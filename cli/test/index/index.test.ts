import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { packageRoot } from "../../src/engine/package-root.js";
import { GitHubClient, GitHubError } from "../../src/github/index.js";
import { buildIndex, localGit, pendingBase, type GitInfo } from "../../src/index/build.js";
import { indexFileName, type BranchIndex } from "../../src/index/model.js";
import { deleteIndex, mergedByLookup, publishIndex } from "../../src/index/publish.js";
import { FakeRepo } from "../docs/fakerepo.js";
import { MockGitHub, R, REPO } from "../github/mock.js";

const VALID = join(packageRoot(), "test", "fixtures", "valid");
const temp = mkdtempSync(join(tmpdir(), "idc365-index-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const noSleep = { sleep: async () => {} };

function gitRepo(): string {
  const root = join(temp, `repo-${Math.random().toString(36).slice(2)}`);
  cpSync(VALID, root, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init");
  return root;
}
const commit = (root: string, msg: string) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qam", msg], { cwd: root });

describe("index build", () => {
  test("indexes every document with fields, relations both ways and commits", async () => {
    const root = gitRepo();
    const idx = await buildIndex({ root, branch: "main", git: localGit(root), now: () => new Date("2026-11-02T00:00:00Z") });
    assert.equal(idx.branch, "main");
    assert.equal(idx.base, null);
    assert.equal(idx.generatedAt, "2026-11-02T00:00:00.000Z");
    assert.equal(idx.sourceSha, execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    assert.equal(idx.documents.length, 11);
    assert.deepEqual(idx.skipped, []);
    const adr1 = idx.documents.find((d) => d.id === "ADR-0001")!;
    assert.deepEqual(
      { type: adr1.type, path: adr1.path, slug: adr1.slug, state: adr1.state, category: adr1.category, featured: adr1.featured, pending: adr1.pending, releases: adr1.releases, mergedBy: adr1.mergedBy },
      { type: "adr", path: "docs/adr/0001-store-data-in-postgresql.md", slug: "store-data-in-postgresql", state: "accepted", category: "data", featured: true, pending: false, releases: ["main"], mergedBy: null },
    );
    assert.equal(adr1.commit!.sha, idx.sourceSha);
    // outgoing: forward relations only (the amended-by inverse entry is not repeated)
    assert.deepEqual(adr1.relations.outgoing.map((r) => `${r.type} ${r.target}`), ["uses TECH-0001", "attachment ATT-0001", "relates-to CODE:idconnectdk/idc365/src/main.ts", "relates-to CODE:idconnectdk/idc365/src/db.ts", "relates-to JIRA:IDC-123", "relates-to https://www.postgresql.org/docs/"]);
    // incoming: forward relations of others
    assert.deepEqual(adr1.relations.incoming.map((r) => `${r.type} ${r.source}`), ["relates-to CODE:idconnectdk/idc365/src/db.ts", "amends ADR-0002"]);
    const shadow = idx.documents.find((d) => d.id === "CODE:idconnectdk/idc365/src/db.ts")!;
    assert.equal(shadow.placeholder, true);
    assert.equal(shadow.slug, null);
    assert.ok(!JSON.stringify(idx).includes("## Context"), "no bodies");
  });

  test("a work branch marks documents changed since its base pending", async () => {
    const root = gitRepo();
    execFileSync("git", ["checkout", "-q", "-b", "v0.1.0/change"], { cwd: root });
    appendFileSync(join(root, "docs/procedure/0001-documentation-workflow.md"), "\nMore.\n");
    commit(root, "change");
    const idx = await buildIndex({ root, branch: "v0.1.0/change", git: localGit(root) });
    assert.equal(idx.base, "main");
    assert.deepEqual(idx.documents.filter((d) => d.pending).map((d) => d.id), ["PROC-0001"]);
    assert.notEqual(idx.documents.find((d) => d.id === "PROC-0001")!.commit!.sha, idx.documents.find((d) => d.id === "ADR-0001")!.commit!.sha);
  });

  test("files that are not documents are skipped with a reason", async () => {
    const root = gitRepo();
    writeFileSync(join(root, "docs/adr/notes.md"), "x");
    writeFileSync(join(root, "docs/adr/0009-broken.md"), "---\nid: [\n---\n");
    const idx = await buildIndex({ root, branch: "main", git: localGit(root) });
    assert.deepEqual(idx.skipped.map((s) => s.path), ["docs/adr/0009-broken.md", "docs/adr/notes.md"]);
  });

  test("merged-by comes from the PR of the latest commit", async () => {
    const root = gitRepo();
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const m = new MockGitHub()
      .on("GET", `${R}/commits/${sha}/pulls`, { body: [{ number: 4, merged_at: "2026-11-01T00:00:00Z", merge_commit_sha: sha }] })
      .on("GET", `${R}/pulls/4`, { body: { merged_by: { login: "alice" } } });
    const lookup = mergedByLookup(new GitHubClient({ token: "t", repository: REPO, fetch: m.fetch }));
    const idx = await buildIndex({ root, branch: "main", git: localGit(root), mergedBy: lookup });
    assert.ok(idx.documents.every((d) => d.mergedBy === "alice"));
    assert.equal(m.calls.length, 2, "one lookup per commit, cached");
  });

  test("merged-by skips commits without a PR (the bot's post-merge edits)", async () => {
    const root = gitRepo();
    const merged = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    appendFileSync(join(root, "docs/adr/0002-partner-event-api.md"), "\nBot edit.\n");
    commit(root, "bot edit");
    const bot = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const m = new MockGitHub()
      .on("GET", `${R}/commits/${bot}/pulls`, { body: [] })
      .on("GET", `${R}/commits/${merged}/pulls`, { body: [{ number: 4, merged_at: "2026-11-01T00:00:00Z", merge_commit_sha: merged }] })
      .on("GET", `${R}/pulls/4`, { body: { merged_by: { login: "alice" } } });
    const idx = await buildIndex({ root, branch: "main", git: localGit(root), mergedBy: mergedByLookup(new GitHubClient({ token: "t", repository: REPO, fetch: m.fetch })) });
    const adr2 = idx.documents.find((d) => d.id === "ADR-0002")!;
    assert.equal(adr2.commit!.sha, bot);
    assert.equal(adr2.mergedBy, "alice");
  });

  test("releases lists the truth branches and v* tags a document exists on", async () => {
    const root = gitRepo();
    execFileSync("git", ["tag", "v0.1.0"], { cwd: root });
    execFileSync("git", ["branch", "release/v0.2.0"], { cwd: root });
    execFileSync("git", ["checkout", "-q", "release/v0.2.0"], { cwd: root });
    writeFileSync(join(root, "docs/adr/0003-new.md"), "---\nid: ADR-0003\ntitle: New\n---\nx\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    commit(root, "new on the release branch");
    execFileSync("git", ["branch", "v0.2.0/work"], { cwd: root });
    const idx = await buildIndex({ root, branch: "release/v0.2.0", git: localGit(root) });
    assert.deepEqual(idx.documents.find((d) => d.id === "ADR-0001")!.releases, ["main", "release/v0.2.0", "v0.1.0"]);
    assert.deepEqual(idx.documents.find((d) => d.id === "ADR-0003")!.releases, ["release/v0.2.0"]);
  });

  test("pendingBase follows the base-branch rule", () => {
    const git = (tags: string[], branches: string[]): GitInfo => ({ head: () => "", latestCommits: () => new Map(), tags: () => tags, branchExists: (b) => branches.includes(b), changedSince: () => new Set() });
    assert.equal(pendingBase("main", git([], [])), null);
    assert.equal(pendingBase("release/v2.0.0", git([], [])), null);
    assert.equal(pendingBase("feature-x", git([], [])), null);
    assert.equal(pendingBase("v0.1.0/x", git([], [])), "main");
    assert.equal(pendingBase("v2.0.1/x", git(["v2.0.0"], [])), "main");
    assert.equal(pendingBase("v2.1.0/x", git(["v2.0.0"], ["release/v2.1.0"])), "release/v2.1.0");
    assert.equal(pendingBase("v3.0.0/x", git(["v2.0.0"], [])), null);
  });

  test("file names", () => {
    assert.equal(indexFileName("main"), "main.json");
    assert.equal(indexFileName("release/v2.0.0"), "release__v2.0.0.json");
    assert.equal(indexFileName("v1.0.1/adr-0001-x"), "v1.0.1__adr-0001-x.json");
  });
});

const sample = (branch: string, sourceSha = "a".repeat(40)): BranchIndex => ({ schema: 1, branch, sourceSha, generatedAt: "2026-11-02T00:00:00.000Z", base: null, documents: [], skipped: [] });

describe("index publish and delete", () => {
  const at = (r: FakeRepo, branch: string) => sample(branch, r.refs.get(`heads/${branch}`)!);

  test("creates meta/index as an orphan branch with the file", async () => {
    const r = new FakeRepo();
    r.seed("main", { "README.md": "x" });
    const res = await publishIndex(r.client(), at(r, "main"), noSleep);
    assert.deepEqual(res, { path: "main.json", outcome: "created-branch", retries: 0 });
    assert.deepEqual(JSON.parse(r.files("meta/index").get("main.json")!).branch, "main");
    assert.deepEqual(r.head("meta/index")!.parents, []);
  });
  test("adds and updates files on an existing meta/index", async () => {
    const r = new FakeRepo();
    r.seed("meta/index", { "main.json": "{}" });
    r.seed("main", { "README.md": "x" });
    r.seed("v1.0.1/x", {}, "main");
    assert.equal((await publishIndex(r.client(), at(r, "v1.0.1/x"), noSleep)).outcome, "written");
    assert.equal((await publishIndex(r.client(), at(r, "main"), noSleep)).outcome, "written");
    assert.deepEqual([...r.files("meta/index").keys()].sort(), ["main.json", "v1.0.1__x.json"]);
    assert.equal(JSON.parse(r.files("meta/index").get("main.json")!).sourceSha, r.refs.get("heads/main"));
    assert.match(r.head("meta/index")!.message, /^Index main at [0-9a-f]{7}$/);
  });
  test("an index of an older commit is not published (newest push wins)", async () => {
    const r = new FakeRepo();
    r.seed("meta/index", { "main.json": "{}" });
    const old = r.seed("main", { "README.md": "x" });
    r.seed("main", { "README.md": "y" });
    const res = await publishIndex(r.client(), sample("main", old), noSleep);
    assert.equal(res.outcome, "skipped-superseded");
    assert.equal(r.files("meta/index").get("main.json"), "{}");
  });
  test("retries on 409 and stops on a ruleset rejection", async () => {
    const r = new FakeRepo();
    r.seed("meta/index", { "main.json": "{}" });
    r.seed("main", { "README.md": "x" });
    let n = 0;
    r.mock.on("PUT", `${R}/contents/main.json`, () => (++n === 1 ? { status: 409, body: { message: "main.json does not match" } } : { status: 200, body: {} }));
    assert.equal((await publishIndex(r.client(), at(r, "main"), noSleep)).retries, 1);
    r.mock.on("PUT", `${R}/contents/main.json`, { status: 409, body: { message: "Repository rule violations found\n\nCannot update this protected ref.\n" } });
    await assert.rejects(publishIndex(r.client(), at(r, "main"), noSleep), (e: unknown) => e instanceof GitHubError && /rejected/.test(e.message) && /Only the bot/.test(e.nextAction));
  });
  test("a deleted branch is not published, and a leftover index is removed", async () => {
    const r = new FakeRepo();
    r.seed("meta/index", { "main.json": "{}", "v1.0.1__gone.json": "{}" });
    assert.equal((await publishIndex(r.client(), sample("v1.0.1/gone"), noSleep)).outcome, "skipped-deleted");
    assert.deepEqual([...r.files("meta/index").keys()], ["main.json"]);
  });
  test("a branch deleted during the write gets its index removed again", async () => {
    const r = new FakeRepo();
    r.seed("meta/index", { "main.json": "{}" });
    r.seed("main", { "README.md": "x" });
    r.seed("v1.0.1/x", {}, "main");
    const idx = at(r, "v1.0.1/x");
    const put = (r as unknown as { putContents: (c: unknown) => unknown }).putContents.bind(r);
    r.mock.on("PUT", `${R}/contents/v1.0.1__x.json`, (c) => {
      r.refs.delete("heads/v1.0.1/x"); // the branch is deleted while this run publishes
      return put(c) as never;
    });
    assert.equal((await publishIndex(r.client(), idx, noSleep)).outcome, "removed-deleted");
    assert.deepEqual([...r.files("meta/index").keys()], ["main.json"]);
  });
  test("a rejected branch creation is reported, not retried", async () => {
    const r = new FakeRepo();
    r.seed("main", { "README.md": "x" });
    r.mock.on("POST", `${R}/git/refs`, { status: 422, body: { message: "Reference update failed" } });
    await assert.rejects(publishIndex(r.client(), at(r, "main"), noSleep), (e: unknown) => e instanceof GitHubError && /rejected/.test(e.message));
    assert.equal(r.mock.callsTo("POST", `${R}/git/refs`).length, 1);
  });
  test("delete removes the branch's file and is a no-op when missing", async () => {
    const r = new FakeRepo();
    r.seed("meta/index", { "main.json": "{}", "v1.0.1__x.json": "{}" });
    assert.equal(await deleteIndex(r.client(), "v1.0.1/x", noSleep), true);
    assert.deepEqual([...r.files("meta/index").keys()], ["main.json"]);
    assert.match(r.head("meta/index")!.message, /Remove index of deleted branch v1\.0\.1\/x/);
    assert.equal(await deleteIndex(r.client(), "v9.9.9/none", noSleep), false);
  });
});

describe("index reading", () => {
  const { fetchIndex, cacheDir } = await_import();
  function await_import() {
    return { fetchIndex: async (...a: Parameters<typeof import("../../src/index/read.js").fetchIndex>) => (await import("../../src/index/read.js")).fetchIndex(...a), cacheDir: async (...a: Parameters<typeof import("../../src/index/read.js").cacheDir>) => (await import("../../src/index/read.js")).cacheDir(...a) };
  }
  const seeded = () => {
    const r = new FakeRepo();
    r.seed("main", { "README.md": "x", ...Object.fromEntries([["config/x.yaml", "a: 1\n"]]) });
    const head = r.refs.get("heads/main")!;
    const idx: BranchIndex = { ...sample("main", head), documents: [
      { id: "ADR-0001", type: "adr", path: "docs/adr/0001-a.md", slug: "a", title: "A", description: "d", intent: "ia", when: "w", state: "accepted", category: "data", featured: false, placeholder: false, pending: false, relations: { outgoing: [], incoming: [] }, releases: [], commit: null, mergedBy: null },
      { id: "ADR-0002", type: "adr", path: "docs/adr/0002-b.md", slug: "b", title: "B", description: "d", intent: "ib", when: "w", state: "deprecated", category: "api", featured: false, placeholder: false, pending: true, relations: { outgoing: [], incoming: [] }, releases: [], commit: null, mergedBy: null },
      { id: "PROC-0001", type: "procedure", path: "docs/procedure/0001-p.md", slug: "p", title: "P", description: "d", intent: "ip", when: "w", state: "accepted", category: "development", featured: false, placeholder: false, pending: false, relations: { outgoing: [], incoming: [] }, releases: [], commit: null, mergedBy: null },
    ] };
    r.seed("meta/index", { "main.json": JSON.stringify(idx) });
    return r;
  };

  test("the second read is a 304 from the ETag cache", async () => {
    const r = seeded();
    const dir = join(temp, "cache-304");
    const first = await fetchIndex(r.client(), "main", dir);
    const second = await fetchIndex(r.client(), "main", dir);
    assert.equal(first.status, 200);
    assert.equal(second.status, 304);
    assert.deepEqual(r.rawReads, [200, 304]);
    assert.equal(second.index!.documents.length, 3);
    assert.equal(second.stale, false);
    assert.equal(second.head, r.refs.get("heads/main"));
  });

  test("an index behind the branch head is stale; a missing one is 404", async () => {
    const r = seeded();
    r.seed("main", { "docs/adr/0003-c.md": "---\nid: ADR-0003\n---\n" });
    const f = await fetchIndex(r.client(), "main", join(temp, "cache-stale"));
    assert.equal(f.stale, true);
    const none = await fetchIndex(r.client(), "v1.0.1/none", join(temp, "cache-none"));
    assert.equal(none.status, 404);
    assert.equal(none.index, undefined);
  });

  test("list uses the index with filters and pending, and falls back when stale or missing", async () => {
    const { listFromIndexOrDirect } = await import("../../src/docs/read.js");
    const { KINDS } = await import("../../src/docs/kinds.js");
    const r = seeded();
    const viaIndex = await listFromIndexOrDirect(r.client(), KINDS.adr, "main", { state: "deprecated" }, join(temp, "cache-list"));
    assert.equal(viaIndex.source.kind, "index");
    assert.deepEqual(viaIndex.documents.map((d) => `${d.id} ${d.pending}`), ["ADR-0002 true"]);
    r.seed("main", { "docs/adr/0003-c.md": "---\nid: ADR-0003\ntitle: C\nstate: accepted\n---\n" });
    const stale = await listFromIndexOrDirect(r.client(), KINDS.adr, "main", {}, join(temp, "cache-list"));
    assert.deepEqual(stale.source.kind + " " + stale.source.reason, "direct stale");
    assert.deepEqual(stale.documents.map((d) => d.id), ["ADR-0003"]);
    const missing = await listFromIndexOrDirect(r.client(), KINDS.adr, "v1.0.1/x", {}, join(temp, "cache-list"));
    assert.equal(missing.source.reason, "missing");
  });

  test("cache folder per platform", async () => {
    assert.equal(await cacheDir({ XDG_CACHE_HOME: "/x" }, "linux"), join("/x", "idc365-decisions"));
    assert.equal(await cacheDir({ LOCALAPPDATA: "C:\\L" }, "win32"), join("C:\\L", "idc365-decisions"));
    assert.match(await cacheDir({}, "darwin"), /Library[\\/]Caches[\\/]idc365-decisions$/);
    assert.match(await cacheDir({}, "linux"), /\.cache[\\/]idc365-decisions$/);
    assert.equal(await cacheDir({ IDC365_DECISIONS_CACHE: "/c" }, "linux"), "/c");
  });
});
