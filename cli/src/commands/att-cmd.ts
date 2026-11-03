import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { createAttachment, getAttachment, showAttachment } from "../docs/attachments.js";
import { KINDS } from "../docs/kinds.js";
import { listFromIndexOrDirect } from "../docs/read.js";
import { GitHubClient, GitHubError } from "../github/index.js";
import { loadSetup, renderSetupProblems } from "../setup/setup.js";
import { renderRefusal, renderWrite } from "./docs.js";

const CLI = "idc365-decisions";

function md(title: string, lines: string[], next: string): string {
  return [`# ${title}`, "", ...lines, ...(lines.length ? [""] : []), "## Next action", "", next, ""].join("\n");
}

function print(json: boolean, data: unknown, markdown: string): void {
  process.stdout.write(json ? JSON.stringify(data, (k, v) => (k === "data" ? undefined : v), 2) + "\n" : markdown);
}

async function withClient(json: boolean, fn: (client: GitHubClient) => Promise<number>): Promise<void> {
  const setup = loadSetup(process.cwd());
  if (!setup.ok) {
    print(json, { ok: false, error: "setup incomplete", problems: setup.problems }, renderSetupProblems(setup.problems));
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = await fn(new GitHubClient({ repository: setup.setup.repository, token: setup.setup.token }));
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    print(json, { ok: false, error: err.message, nextAction: err.nextAction }, md("GitHub error", [`- ${err.message}`, ...err.details.map((d) => `  ${d}`)], err.nextAction));
    process.exitCode = 1;
  }
}

const HELP = [
  KINDS.att.purpose,
  "",
  "## How to write it",
  "",
  ...KINDS.att.instruction.map((l) => `- ${l}`),
  "",
  "## Verbs",
  "",
  `- \`${CLI} att create <file> --version v1.0.1 --title "…" --description "…" --intent "…" --when "…" [--supersedes ATT-0001 --why "…"] [--branch …]\``,
  `- \`${CLI} att show ATT-0001 [--ref main]\`: metadata and the documents that link to it`,
  `- \`${CLI} att list [--ref main]\``,
  `- \`${CLI} att get ATT-0001 [--out <path>] [--ref main]\`: download the binary`,
];

/** Registers `att` (spec 5.5, 6.3). */
export function registerAttCommands(program: Command): void {
  const att = program
    .command("att")
    .enablePositionalOptions()
    .action(() => {
      process.stdout.write(md(KINDS.att.name, HELP, "Pick the verb for your task. Every write opens or extends a PR for the user to review and merge."));
    });
  att.helpInformation = () => `Run \`${CLI} att\` for the attachment guide.\n`;

  att
    .command("create")
    .argument("<file>")
    .option("--version <vX.Y.Z>")
    .option("--branch <branch>")
    .option("--title <text>")
    .option("--description <text>")
    .option("--intent <text>")
    .option("--when <text>")
    .option("--state <state>")
    .option("--supersedes <ATT-ID>", "this file is a new version of that attachment")
    .option("--why <text>", "why the new version supersedes the old one")
    .option("--body-file <path>")
    .option("--json")
    .action(async (file: string, o: Record<string, string | boolean | undefined>) => {
      const json = !!o.json;
      await withClient(json, async (client) => {
        const body = typeof o.bodyFile === "string" ? readFileSync(o.bodyFile === "-" ? 0 : o.bodyFile, "utf8") : undefined;
        const r = await createAttachment(
          client,
          resolve(file),
          { title: o.title as string | undefined, description: o.description as string | undefined, intent: o.intent as string | undefined, when: o.when as string | undefined, state: o.state as string | undefined },
          body,
          { version: o.version as string | undefined, branch: o.branch as string | undefined, supersedes: o.supersedes as string | undefined, why: o.why as string | undefined },
        );
        let text = renderWrite(KINDS.att, r);
        if (r.ok) text = text.replace("## Next action\n\n", `## Next action\n\nReference it from documents with \`{{ATT:${r.key.slice(4)}|attachment|<why>}}\`. `);
        print(json, r, text);
        return r.ok ? 0 : 1;
      });
    });

  att
    .command("show")
    .argument("<id>")
    .option("--ref <ref>", "branch or tag", "main")
    .option("--json")
    .action(async (id: string, o: { ref: string; json?: boolean }) => {
      await withClient(!!o.json, async (client) => {
        const r = await showAttachment(client, id, o.ref);
        if (!r.ok) {
          print(!!o.json, r, renderRefusal(r));
          return 1;
        }
        const superseded = r.supersededBy.length > 0 || r.state === "superseded";
        const lines = [
          `- Metadata: \`${r.file}\`; binary: ${r.binary ? `\`${r.binary}\`` : "missing"}`,
          `- ${r.mediaType}, ${r.size} bytes, sha256 ${r.sha256}`,
          `- State: ${r.state}${r.supersededBy.length ? `, superseded by ${r.supersededBy.join(", ")}` : ""}`,
          r.linkers.length
            ? `- ${superseded ? "Still linking to this old version" : "Linked from"}: ${r.linkers.map((l) => `${l.id} (${l.type})`).join(", ")}`
            : "- Nothing links to it.",
        ];
        const next = superseded && r.linkers.length ? `Update ${r.linkers.map((l) => l.id).join(", ")} to link to ${r.supersededBy[0] ?? "the new version"} where the new version applies (via \`update\`).` : `Download it with \`${CLI} att get ${r.id}\` if you need the file.`;
        print(!!o.json, r, [`# ${r.id} at \`${r.ref}\``, "", ...lines, "", "````markdown", r.text.replace(/\n$/, ""), "````", "", "## Next action", "", next, ""].join("\n"));
        return 0;
      });
    });

  att
    .command("list")
    .option("--ref <ref>", "branch or tag", "main")
    .option("--json")
    .action(async (o: { ref: string; json?: boolean }) => {
      await withClient(!!o.json, async (client) => {
        const { documents, source } = await listFromIndexOrDirect(client, KINDS.att, o.ref);
        const lines = documents.length ? documents.map((d) => `- ${d.id}${d.pending ? " (pending)" : ""} · ${d.title} · ${d.state} · ${d.intent}`) : ["No attachments."];
        print(!!o.json, { ok: true, ref: o.ref, source, documents }, md(`Attachments: ${documents.length} at \`${o.ref}\``, lines, `Show one with \`${CLI} att show <ID> --ref ${o.ref}\`.`));
        return 0;
      });
    });

  att
    .command("get")
    .argument("<id>")
    .option("--out <path>", "file to write (default: the attachment's file name in the current folder)")
    .option("--ref <ref>", "branch or tag", "main")
    .option("--json")
    .action(async (id: string, o: { out?: string; ref: string; json?: boolean }) => {
      await withClient(!!o.json, async (client) => {
        const r = await getAttachment(client, id, o.ref);
        if (!r.ok) {
          print(!!o.json, r, renderRefusal(r));
          return 1;
        }
        const out = resolve(o.out ?? join(process.cwd(), r.name));
        writeFileSync(out, r.data);
        print(!!o.json, { ok: true, id: r.id, out, bytes: r.data.length, sha256: r.sha256 }, md(`Downloaded ${r.id}`, [`- \`${out}\`, ${r.data.length} bytes`, `- sha256 ${r.sha256} (matches the pointer and the metadata)`], "Use the file for your task."));
        return 0;
      });
    });
}
