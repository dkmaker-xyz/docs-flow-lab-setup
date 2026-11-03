/**
 * Phase 3 integration: document commands end to end through the built CLI
 * against a disposable documentation repository (opt-in, never in CI):
 * `IDC365_TEST_REPO=<owner/repo> IDC365_DECISIONS_TOKEN=... npm run test:integration`.
 * The PR is closed and the branch deleted afterwards; nothing is merged.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";
import { validateTree } from "../../src/engine/index.js";
import { packageRoot } from "../../src/engine/package-root.js";
import { commitFiles, createBranch, GitHubClient } from "../../src/github/index.js";

const REPOSITORY = process.env.IDC365_TEST_REPO ?? "";
const TOKEN = process.env.IDC365_DECISIONS_TOKEN ?? "";
const skip = !REPOSITORY || !TOKEN ? "set IDC365_TEST_REPO and IDC365_DECISIONS_TOKEN to run integration tests" : false;
const RUN = `itest-${Date.now().toString(36)}`;
const BRANCH = `v0.1.0/${RUN}`;
const CODE_REPO = "acme/app"; // test configuration only
const CLI = join(packageRoot(), "build-test", "src", "index.js");

const work = mkdtempSync(join(tmpdir(), "idc365-docs-itest-"));
const state: { prs: number[] } = { prs: [] };

function cli(t: TestContext, ...args: string[]): { code: number | null; out: string; json: Record<string, unknown> } {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: work, encoding: "utf8", env: { ...process.env, IDC365_DECISIONS_TOKEN: TOKEN } });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    t.diagnostic(`non-JSON output: ${r.stdout}${r.stderr}`);
  }
  return { code: r.status, out: r.stdout, json };
}

function bodyFile(name: string, text: string): string {
  const p = join(work, name);
  writeFileSync(p, text);
  return p;
}

describe("document commands against GitHub", { skip, concurrency: 1 }, () => {
  let client: GitHubClient;
  const ids: Record<string, string> = {};

  before(async () => {
    client = new GitHubClient({ repository: REPOSITORY, token: TOKEN });
    writeFileSync(join(work, ".idc365-decisions.json"), JSON.stringify({ repository: REPOSITORY }));
    mkdirSync(join(work, ".git")); // marks the git root for the link-file lookup
    // The work branch carries the configuration, since main has none yet.
    await createBranch(client, BRANCH, "main");
    const cfgDir = join(packageRoot(), "test", "fixtures", "valid", "config");
    const files = readdirSync(cfgDir).map((name) => ({
      path: `config/${name}`,
      content: name === "repositories.yaml" ? `repositories:\n  - ${CODE_REPO}\n` : readFileSync(join(cfgDir, name), "utf8"),
    }));
    await commitFiles(client, BRANCH, files, "Test configuration (integration test)");
  });

  after(async () => {
    if (client) {
      for (const n of state.prs) await client.request("PATCH", client.repoPath(`/pulls/${n}`), { body: { state: "closed" } }).catch(() => {});
      await client.request("DELETE", client.repoPath(`/git/refs/heads/${BRANCH}`), { allow: [404, 422] }).catch(() => {});
    }
    rmSync(work, { recursive: true, force: true });
  });

  test("adr create: first ADR opens the PR", async (t) => {
    const r = cli(t, "adr", "create", "--branch", BRANCH, "--title", `Store data in PostgreSQL ${RUN}`, "--description", "Relational data lives in PostgreSQL.", "--intent", "Where service data is stored.", "--when", "When a change stores data.", "--category", "data", "--state", "accepted",
      "--body-file", bodyFile("adr1.md", "## Context\n\nServices need storage.\n\n## Decision\n\nUse PostgreSQL.\n\n## Consequences\n\nOne engine.\n"));
    assert.equal(r.code, 0, r.out);
    ids.adr1 = r.json.key as string;
    const pr = r.json.pr as { number: number; url: string; opened: boolean };
    state.prs.push(pr.number);
    assert.equal(pr.opened, true);
    t.diagnostic(`created ${ids.adr1} ${r.json.file as string}; PR #${pr.number} ${pr.url}`);
  });

  test("adr create: second ADR supersedes the first in the same PR", async (t) => {
    const n = ids.adr1!.slice(4);
    const r = cli(t, "adr", "create", "--branch", BRANCH, "--title", `Store data in PostgreSQL with replicas ${RUN}`, "--description", "Adds read replicas.", "--intent", "Where service data is stored, now with replicas.", "--when", "When a change stores or reads data.", "--category", "data",
      "--body-file", bodyFile("adr2.md", `## Context\n\nRead load grew.\n\n## Decision\n\nUse PostgreSQL with read replicas; this replaces {{ADR:${n}|supersedes|the replicas change the storage decision}}.\n\n## Consequences\n\nReplica lag is acceptable.\n`));
    assert.equal(r.code, 0, r.out);
    ids.adr2 = r.json.key as string;
    assert.equal((r.json.pr as { opened: boolean; number: number }).opened, false);
    assert.equal((r.json.pr as { number: number }).number, state.prs[0]);
    t.diagnostic(`created ${ids.adr2} ${r.json.file as string} (supersedes ${ids.adr1})`);
  });

  test("proc create: a code reference creates a placeholder shadow", async (t) => {
    const r = cli(t, "proc", "create", "--branch", BRANCH, "--title", `Deploy the app ${RUN}`, "--description", "How the app is deployed.", "--intent", "Steps to deploy.", "--when", "When you deploy.", "--category", "release",
      "--body-file", bodyFile("proc.md", `## Trigger\n\nA release is ready.\n\n## Roles\n\nAgent, release manager.\n\n## Steps\n\n1. (agent) Run {{CODE:${CODE_REPO}/scripts/deploy.sh|the deploy script}}.\n2. (human) Approve the deployment.\n\n## Done\n\nThe new version runs.\n`));
    assert.equal(r.code, 0, r.out);
    ids.proc = r.json.key as string;
    assert.deepEqual(r.json.placeholders, [`code/${CODE_REPO}/scripts/deploy.sh.md`]);
    t.diagnostic(`created ${ids.proc} with placeholder ${(r.json.placeholders as string[])[0]}`);
  });

  test("refusals on the real repository write nothing", async (t) => {
    const r = cli(t, "adr", "create", "--branch", BRANCH, "--title", "Bad", "--description", "d", "--intent", "i", "--when", "w", "--category", "data", "--body-file", bodyFile("bad.md", "{{ADR:9999|missing target}}\n"));
    assert.equal(r.code, 1);
    t.diagnostic(`refused: ${r.json.message as string} | ${JSON.stringify(r.json.problems)}`);
  });

  test("show and list read everything back from the branch", async (t) => {
    const shown = cli(t, "adr", "show", ids.adr2!, "--ref", BRANCH);
    assert.equal(shown.code, 0, shown.out);
    const fm = shown.json.frontmatter as { relations: { type: string; target: string; link: string }[] };
    assert.deepEqual(fm.relations.map((r) => `${r.type} ${r.target}`), [`supersedes ${ids.adr1}`]);
    assert.match(shown.json.body as string, new RegExp(`\\[${ids.adr1}\\]\\[${ids.adr1}\\]`));
    const adrs = cli(t, "adr", "list", "--ref", BRANCH);
    const listed = (adrs.json.documents as { id: string }[]).map((d) => d.id);
    assert.ok(listed.includes(ids.adr1!) && listed.includes(ids.adr2!));
    const procs = cli(t, "proc", "list", "--ref", BRANCH, "--category", "release");
    assert.deepEqual((procs.json.documents as { id: string }[]).map((d) => d.id), [ids.proc]);
    const main = cli(t, "adr", "list", "--ref", "main");
    assert.equal((main.json.documents as unknown[]).length, 0, "main is untouched");
    t.diagnostic(`list --ref ${BRANCH}: ${listed.join(", ")}; proc list: ${ids.proc}`);
  });

  test("the phase 1 validator passes on the branch content", async (t) => {
    const head = await client.request<{ object: { sha: string } }>("GET", client.repoPath(`/git/ref/heads/${BRANCH}`));
    const tree = await client.request<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>("GET", client.repoPath(`/git/trees/${head.data.object.sha}`), { query: { recursive: 1 } });
    assert.equal(tree.data.truncated, false);
    const root = join(work, "tree");
    for (const e of tree.data.tree.filter((x) => x.type === "blob")) {
      const blob = await client.request<{ content: string }>("GET", client.repoPath(`/git/blobs/${e.sha}`));
      mkdirSync(dirname(join(root, e.path)), { recursive: true });
      writeFileSync(join(root, e.path), Buffer.from(blob.data.content, "base64"));
    }
    const result = validateTree(root);
    t.diagnostic(`validated ${result.documents} documents: ${result.findings.length} findings`);
    assert.deepEqual(result.findings, []);
    const pr = await client.request<{ number: number; state: string; merged: boolean; body: string }>("GET", client.repoPath(`/pulls/${state.prs[0]}`));
    const files = await client.request<{ filename: string }[]>("GET", client.repoPath(`/pulls/${state.prs[0]}/files`), { query: { per_page: 100 } });
    t.diagnostic(`PR #${pr.data.number} (${pr.data.state}, merged=${pr.data.merged}) files: ${files.data.map((f) => f.filename).join(", ")}`);
    t.diagnostic(`PR body: ${pr.data.body.replace(/\n/g, " / ")}`);
  });
});
