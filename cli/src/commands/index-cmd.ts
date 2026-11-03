import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { GitHubClient, GitHubError } from "../github/index.js";
import { buildIndex, localGit } from "../index/build.js";
import { indexFileName, INDEX_BRANCH, type BranchIndex } from "../index/model.js";
import { deleteIndex, mergedByLookup, publishIndex } from "../index/publish.js";
import { fetchIndex } from "../index/read.js";
import { findLinkFile, loadSetup, renderSetupProblems, TOKEN_ENV } from "../setup/setup.js";

const CLI = "idc365-decisions";

function md(title: string, lines: string[], next: string): string {
  return [`# ${title}`, "", ...lines, ...(lines.length ? [""] : []), "## Next action", "", next, ""].join("\n");
}

function print(json: boolean, data: unknown, markdown: string): void {
  process.stdout.write(json ? JSON.stringify(data, null, 2) + "\n" : markdown);
}

/** owner/repo: --repository, then $GITHUB_REPOSITORY (Actions), then the link file. */
function repositoryFor(option: string | undefined): string | undefined {
  if (option) return option;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const { linkFile } = findLinkFile(process.cwd());
  if (!linkFile) return undefined;
  try {
    return (JSON.parse(readFileSync(linkFile, "utf8")) as { repository?: string }).repository;
  } catch {
    return undefined;
  }
}

export function clientFor(option: string | undefined): GitHubClient | { error: string; nextAction: string } {
  const repository = repositoryFor(option);
  if (!repository) return { error: "no documentation repository", nextAction: "Pass --repository owner/repo (in Actions, GITHUB_REPOSITORY is used)." };
  const token = process.env[TOKEN_ENV]?.trim();
  if (!token) return { error: `${TOKEN_ENV} is not set`, nextAction: `Set ${TOKEN_ENV} (in the index workflow: the bot token).` };
  return new GitHubClient({ repository, token });
}

async function guarded(json: boolean, fn: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    print(json, { ok: false, error: err.message, details: err.details, nextAction: err.nextAction }, md("GitHub error", [`- ${err.message}`, ...err.details.map((d) => `  ${d}`)], err.nextAction));
    process.exitCode = 1;
  }
}

function currentBranch(root: string): string {
  if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_TYPE !== "tag") return process.env.GITHUB_REF_NAME;
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function summary(index: BranchIndex): string[] {
  const pending = index.documents.filter((d) => d.pending).length;
  return [
    `- Branch: \`${index.branch}\`, sourceSha ${index.sourceSha.slice(0, 7)}, generated ${index.generatedAt}`,
    `- Documents: ${index.documents.length}${index.base ? ` (${pending} pending against \`${index.base}\`)` : ""}`,
    ...(index.skipped.length ? [`- Skipped: ${index.skipped.map((s) => `\`${s.path}\` (${s.reason})`).join(", ")}`] : []),
  ];
}

export function registerIndexCommands(program: Command): void {
  const index = program
    .command("index")
    .enablePositionalOptions()
    .action(() => {
      process.stdout.write(
        md(
          "idc365-decisions index",
          [
            "The index on `meta/index` lists every document of a branch without its body; `list` reads it.",
            "",
            `- \`${CLI} index status [--ref main]\`: is the index there and current?`,
            `- \`${CLI} index build [--out file]\`, \`index publish <file>\`, \`index delete --branch <name>\`: used by the index workflow with the bot token.`,
          ],
          `Run \`${CLI} index status\` to check the index of a branch.`,
        ),
      );
    });
  index.helpInformation = () => `Run \`${CLI} index\` for the index commands.\n`;

  index
    .command("build")
    .option("--root <dir>", "checkout of the documentation branch", ".")
    .option("--branch <name>", "branch name (default: GITHUB_REF_NAME or the checked-out branch)")
    .option("--out <file>", "write the index JSON here (default: stdout)")
    .option("--repository <owner/repo>", "for the merged-by lookup (default: GITHUB_REPOSITORY)")
    .option("--json")
    .action(async (o: { root: string; branch?: string; out?: string; repository?: string; json?: boolean }) => {
      await guarded(!!o.json, async () => {
        const root = resolve(o.root);
        const client = clientFor(o.repository);
        const built = await buildIndex({ root, branch: o.branch ?? currentBranch(root), git: localGit(root), mergedBy: client instanceof GitHubClient ? mergedByLookup(client) : undefined });
        if (!o.out) {
          process.stdout.write(JSON.stringify(built, null, 2) + "\n");
          return 0;
        }
        writeFileSync(o.out, JSON.stringify(built, null, 2) + "\n");
        const lines = [...summary(built), `- Written to \`${o.out}\``, ...(client instanceof GitHubClient ? [] : [`- Merged-by is empty: ${client.error}.`])];
        print(!!o.json, { ok: true, out: o.out, branch: built.branch, sourceSha: built.sourceSha, documents: built.documents.length }, md(`Index built for ${built.branch}`, lines, `Publish it with \`${CLI} index publish ${o.out}\`.`));
        return 0;
      });
    });

  index
    .command("publish")
    .argument("<file>", "index JSON from index build")
    .option("--repository <owner/repo>")
    .option("--json")
    .action(async (file: string, o: { repository?: string; json?: boolean }) => {
      await guarded(!!o.json, async () => {
        const client = clientFor(o.repository);
        if (!(client instanceof GitHubClient)) {
          print(!!o.json, { ok: false, ...client }, md(`Cannot publish: ${client.error}`, [], client.nextAction));
          return 1;
        }
        const built = JSON.parse(readFileSync(file, "utf8")) as BranchIndex;
        const r = await publishIndex(client, built);
        print(!!o.json, { ok: true, ...r, branch: built.branch, sourceSha: built.sourceSha }, r.outcome === "skipped-deleted" || r.outcome === "removed-deleted"
          ? md(`Index not kept: \`${built.branch}\` no longer exists`, [], "None. The branch was deleted while its index was built; its index file is removed.")
          : r.outcome === "skipped-superseded"
            ? md(`Index not published: \`${built.branch}\` moved past ${built.sourceSha.slice(0, 7)}`, [], "None. The build of the newer commit publishes the index.")
            : md(`Index published: ${INDEX_BRANCH}/${r.path}`, [...summary(built), `- ${r.outcome === "created-branch" ? `Created \`${INDEX_BRANCH}\`` : "Written"}${r.retries ? ` after ${r.retries} retries` : ""}`], "None."));
        return 0;
      });
    });

  index
    .command("delete")
    .requiredOption("--branch <name>", "deleted documentation branch")
    .option("--repository <owner/repo>")
    .option("--json")
    .action(async (o: { branch: string; repository?: string; json?: boolean }) => {
      await guarded(!!o.json, async () => {
        const client = clientFor(o.repository);
        if (!(client instanceof GitHubClient)) {
          print(!!o.json, { ok: false, ...client }, md(`Cannot delete: ${client.error}`, [], client.nextAction));
          return 1;
        }
        const removed = await deleteIndex(client, o.branch);
        const name = indexFileName(o.branch);
        print(!!o.json, { ok: true, removed, path: name }, md(removed ? `Index removed: ${INDEX_BRANCH}/${name}` : `No index for ${o.branch}`, [], "None."));
        return 0;
      });
    });

  index
    .command("status")
    .option("--ref <ref>", "branch", "main")
    .option("--json")
    .action(async (o: { ref: string; json?: boolean }) => {
      const setup = loadSetup(process.cwd());
      if (!setup.ok) {
        print(!!o.json, { ok: false, error: "setup incomplete", problems: setup.problems }, renderSetupProblems(setup.problems));
        process.exitCode = 1;
        return;
      }
      await guarded(!!o.json, async () => {
        const client = new GitHubClient({ repository: setup.setup.repository, token: setup.setup.token });
        const f = await fetchIndex(client, o.ref);
        const data = {
          ok: true,
          ref: o.ref,
          exists: !!f.index,
          status: f.status,
          head: f.head ?? null,
          sourceSha: f.index?.sourceSha ?? null,
          current: !!f.index && !f.stale,
          generatedAt: f.index?.generatedAt ?? null,
          documents: f.index?.documents.length ?? 0,
          pending: f.index?.documents.filter((d) => d.pending).length ?? 0,
        };
        if (!f.index) {
          print(!!o.json, data, md(`No index for \`${o.ref}\``, [`- Branch head: ${f.head ?? "not a branch"}`], `The index workflow builds it after the next push to \`${o.ref}\`. Until then \`list\` reads the documents directly.`));
          return 0;
        }
        const lines = [
          `- sourceSha ${f.index.sourceSha.slice(0, 7)} vs branch head ${f.head?.slice(0, 7) ?? "unknown"}: ${f.stale ? "**behind** (being rebuilt)" : "current"}`,
          `- Generated ${f.index.generatedAt}`,
          `- Documents: ${data.documents}${f.index.base ? `, ${data.pending} pending against \`${f.index.base}\`` : ""}`,
          `- Read: ${f.status === 304 ? "304, cache was current" : "200, downloaded"}`,
        ];
        print(!!o.json, data, md(`Index for \`${o.ref}\``, lines, f.stale ? "Wait for the index workflow, or let `list` read the documents directly." : "None. The index is current."));
        return 0;
      });
    });
}
