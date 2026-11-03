/**
 * Phase 4 integration: the index workflow and index reading against a
 * disposable documentation repository that has cli/ and the index workflows
 * on main (opt-in, never in CI):
 * `IDC365_TEST_REPO=<owner/repo> IDC365_DECISIONS_TOKEN=... npm run test:integration`.
 * Nothing is merged; the PR is closed and the branch deleted.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";
import { packageRoot } from "../../src/engine/package-root.js";
import { branchHead, commitFiles, GitHubClient, GitHubError } from "../../src/github/index.js";
import { indexFileName, INDEX_BRANCH, type BranchIndex } from "../../src/index/model.js";

const REPOSITORY = process.env.IDC365_TEST_REPO ?? "";
const TOKEN = process.env.IDC365_DECISIONS_TOKEN ?? "";
const skip = !REPOSITORY || !TOKEN ? "set IDC365_TEST_REPO and IDC365_DECISIONS_TOKEN to run integration tests" : false;
const RUN = `itest-${Date.now().toString(36)}`;
const CLI = join(packageRoot(), "build-test", "src", "index.js");
const work = mkdtempSync(join(tmpdir(), "idc365-index-itest-"));
const cache = join(work, "cache");

function cli(t: TestContext, ...args: string[]): { code: number | null; json: Record<string, unknown>; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: work, encoding: "utf8", env: { ...process.env, IDC365_DECISIONS_TOKEN: TOKEN, IDC365_DECISIONS_CACHE: cache } });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    t.diagnostic(`non-JSON output: ${r.stdout}${r.stderr}`);
  }
  return { code: r.status, json, out: r.stdout };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 300_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(5000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("index workflow and reading", { skip, concurrency: 1 }, () => {
  let client: GitHubClient;
  let branch = "";
  let pr = 0;
  let id = "";
  let head = "";

  before(() => {
    client = new GitHubClient({ repository: REPOSITORY, token: TOKEN });
    writeFileSync(join(work, ".idc365-decisions.json"), JSON.stringify({ repository: REPOSITORY }));
    mkdirSync(join(work, ".git"));
  });
  after(async () => {
    if (client && pr) await client.request("PATCH", client.repoPath(`/pulls/${pr}`), { body: { state: "closed" } }).catch(() => {});
    if (client && branch) await client.request("DELETE", client.repoPath(`/git/refs/heads/${branch}`), { allow: [404, 422] }).catch(() => {});
    rmSync(work, { recursive: true, force: true });
  });

  test("3.1: adr create without --branch makes a work branch from main and a PR", async (t) => {
    const body = join(work, "body.md");
    writeFileSync(body, `## Context\n\nTicket {{JIRA:IDC-1|asked for the decision}}.\n\n## Decision\n\nIndex test ${RUN}.\n\n## Consequences\n\nNone.\n`);
    const r = cli(t, "adr", "create", "--version", "v0.1.0", "--title", `Index test ${RUN}`, "--description", "Integration test document.", "--intent", "Tests the index.", "--when", "Never; test data.", "--category", "architecture", "--body-file", body);
    assert.equal(r.code, 0, r.out);
    id = r.json.key as string;
    branch = r.json.branch as string;
    pr = (r.json.pr as { number: number }).number;
    assert.equal(r.json.base, "main");
    assert.match(branch, /^v0\.1\.0\/adr-[0-9]{4}-index-test-/);
    assert.match(r.json.file as string, /^docs\/adr\/[0-9]{4}-index-test-itest-[a-z0-9]+\.md$/);
    const shown = cli(t, "adr", "show", id, "--ref", branch);
    assert.match(shown.json.body as string, /Ticket \[JIRA:IDC-1\]\[JIRA:IDC-1\]\./);
    assert.match(shown.json.body as string, /\[JIRA:IDC-1\]: https:\/\/example\.atlassian\.net\/browse\/IDC-1/);
    head = (await branchHead(client, branch))!;
    t.diagnostic(`${id} on ${branch} (${head.slice(0, 7)}), file ${r.json.file as string}, PR #${pr} ${(r.json.pr as { url: string }).url}`);
  });

  test("3.3: the work branch's index appears on meta/index with the document pending", async (t) => {
    const name = indexFileName(branch);
    const idx = await waitFor(`${name} at ${head.slice(0, 7)}`, async () => {
      const res = await client.request<BranchIndex | string>("GET", client.repoPath(`/contents/${name}`), { query: { ref: INDEX_BRANCH }, accept: "application/vnd.github.raw+json", allow: [404] });
      if (res.status === 404) return undefined;
      const data = (typeof res.data === "string" ? JSON.parse(res.data) : res.data) as BranchIndex;
      return data.sourceSha === head ? data : undefined;
    });
    const doc = idx.documents.find((d) => d.id === id)!;
    assert.equal(doc.pending, true);
    assert.equal(idx.base, "main");
    assert.deepEqual(doc.relations.outgoing.map((r) => `${r.type} ${r.target}`), ["relates-to JIRA:IDC-1"]);
    const runs = await client.request<{ workflow_runs: { name: string; html_url: string; event: string; conclusion: string }[] }>("GET", client.repoPath("/actions/runs"), { query: { head_sha: head } });
    for (const r of runs.data.workflow_runs) t.diagnostic(`run: ${r.name} (${r.event}) ${r.conclusion} ${r.html_url}`);
    t.diagnostic(`index ${INDEX_BRANCH}/${name}: ${idx.documents.length} documents, ${id} pending=${doc.pending}, mergedBy=${doc.mergedBy}`);
  });

  test("3.6: the second list is a 304; index status is current", async (t) => {
    const first = cli(t, "adr", "list", "--ref", branch);
    const second = cli(t, "adr", "list", "--ref", branch);
    const s1 = first.json.source as { kind: string; status: number };
    const s2 = second.json.source as { kind: string; status: number };
    assert.deepEqual([s1.kind, s1.status, s2.kind, s2.status], ["index", 200, "index", 304]);
    assert.ok((second.json.documents as { id: string; pending: boolean }[]).some((d) => d.id === id && d.pending));
    const status = cli(t, "index", "status", "--ref", branch);
    assert.equal(status.json.current, true);
    t.diagnostic(`list: ${s1.status} then ${s2.status}; status: ${JSON.stringify(status.json)}`);
  });

  test("1.4: a developer token cannot write meta/index", async (t) => {
    const viaGit = await commitFiles(client, INDEX_BRANCH, [{ path: `${RUN}.json`, content: "{}\n" }], "developer write").then(
      () => assert.fail("write succeeded"),
      (e: unknown) => e as GitHubError,
    );
    t.diagnostic(`git refs update: ${viaGit.status} ${viaGit.message} | ${viaGit.details.join(" | ")}`);
    assert.match(`${viaGit.message} ${viaGit.details.join(" ")}`, /rule violation|cannot update/i);
    const viaContents = await client
      .request("PUT", client.repoPath(`/contents/${RUN}.json`), { body: { message: "developer write", content: Buffer.from("{}").toString("base64"), branch: INDEX_BRANCH } })
      .then(() => assert.fail("write succeeded"), (e: unknown) => e as GitHubError);
    t.diagnostic(`contents PUT: ${viaContents.status} ${viaContents.message} | ${viaContents.details.join(" | ")}`);
  });

  test("deleting the work branch removes its index file", async (t) => {
    await client.request("PATCH", client.repoPath(`/pulls/${pr}`), { body: { state: "closed" } });
    await client.request("DELETE", client.repoPath(`/git/refs/heads/${branch}`));
    const name = indexFileName(branch);
    await waitFor(`${name} removed`, async () => {
      const res = await client.request("GET", client.repoPath(`/contents/${name}`), { query: { ref: INDEX_BRANCH }, allow: [404] });
      return res.status === 404 ? true : undefined;
    });
    const runs = await client.request<{ workflow_runs: { name: string; event: string; conclusion: string; html_url: string }[] }>("GET", client.repoPath("/actions/runs"), { query: { event: "delete", per_page: 1 } });
    const r = runs.data.workflow_runs[0];
    t.diagnostic(`PR #${pr} closed unmerged, branch deleted, ${name} removed; run: ${r?.name} (${r?.event}) ${r?.conclusion} ${r?.html_url}`);
    branch = "";
  });
});
