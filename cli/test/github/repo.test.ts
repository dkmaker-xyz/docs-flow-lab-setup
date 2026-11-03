import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  baseBranchFor,
  commitFiles,
  createBranch,
  GitHubClient,
  GitHubError,
  listFolder,
  openPullRequest,
  readFile,
  releasedVersion,
  workBranchName,
} from "../../src/github/index.js";
import { MockGitHub, R, REPO } from "./mock.js";

const client = (m: MockGitHub) => new GitHubClient({ token: "t", repository: REPO, fetch: m.fetch });

function withTags(m: MockGitHub, tags: string[]): MockGitHub {
  return m.on("GET", `${R}/git/matching-refs/tags/v`, { body: tags.map((t) => ({ ref: `refs/tags/${t}`, object: { sha: "x" } })) });
}
function withBranches(m: MockGitHub, branches: Record<string, string>): MockGitHub {
  return m.on("GET", /\/git\/ref\/heads\/.+$/, (c) => {
    const name = c.path.replace(`${R}/git/ref/heads/`, "");
    const sha = branches[name];
    return sha ? { body: { ref: `refs/heads/${name}`, object: { sha } } } : { status: 404, body: { message: "Not Found" } };
  });
}

describe("released version", () => {
  test("is the highest vX.Y.Z tag; other tags are ignored", async () => {
    const m = withTags(new MockGitHub(), ["v1.9.0", "v2.0.1", "v2.0.0", "v10.0.0-rc1", "vnext", "v2.0.10"]);
    assert.deepEqual(await releasedVersion(client(m)), { major: 2, minor: 0, patch: 10 });
    assert.equal(m.calls.length, 1);
  });
  test("is undefined without tags", async () => {
    assert.equal(await releasedVersion(client(withTags(new MockGitHub(), []))), undefined);
  });
});

describe("base branch", () => {
  const setup = (tags: string[], branches: Record<string, string>) => client(withBranches(withTags(new MockGitHub(), tags), branches));

  test("same major.minor as the released version → main", async () => {
    assert.deepEqual(await baseBranchFor(setup(["v2.0.0"], { main: "m" }), "v2.0.1"), { ok: true, base: "main", reason: "patch-on-main", released: { major: 2, minor: 0, patch: 0 } });
  });
  test("an existing release branch → that branch", async () => {
    const r = await baseBranchFor(setup(["v2.0.0"], { main: "m", "release/v2.1.0": "r" }), "v2.1.0");
    assert.equal(r.ok && r.base, "release/v2.1.0");
  });
  test("no release branch and another major.minor → refused with a next action", async () => {
    const r = await baseBranchFor(setup(["v2.0.0"], { main: "m" }), "v2.1.0");
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /release create v2\.1\.0/.test(r.nextAction));
  });
  test("no tag yet → main", async () => {
    assert.deepEqual(await baseBranchFor(setup([], { main: "m" }), "v0.1.0"), { ok: true, base: "main", reason: "no-release-yet" });
  });
  test("no tag yet but a release branch → the release branch", async () => {
    const r = await baseBranchFor(setup([], { main: "m", "release/v1.0.0": "r" }), "v1.0.0");
    assert.equal(r.ok && r.base, "release/v1.0.0");
  });
  test("an invalid version is refused without API calls", async () => {
    const m = new MockGitHub();
    const r = await baseBranchFor(client(m), "2.1");
    assert.equal(r.ok, false);
    assert.equal(m.calls.length, 0);
  });
  test("work branch names", () => {
    assert.equal(workBranchName("v2.0.1", "fix-login"), "v2.0.1/fix-login");
    assert.throws(() => workBranchName("2.0.1", "fix"));
    assert.throws(() => workBranchName("v2.0.1", "Fix_Login"));
  });
});

describe("branches, commits and pull requests", () => {
  test("createBranch points the new branch at the base head", async () => {
    const m = withBranches(new MockGitHub(), { main: "abc" }).on("POST", `${R}/git/refs`, { status: 201, body: {} });
    assert.equal(await createBranch(client(m), "v0.1.0/x", "main"), "abc");
    assert.deepEqual(m.callsTo("POST", `${R}/git/refs`)[0]!.body, { ref: "refs/heads/v0.1.0/x", sha: "abc" });
  });
  test("createBranch fails clearly when the base is missing", async () => {
    const m = withBranches(new MockGitHub(), {});
    await assert.rejects(createBranch(client(m), "v0.1.0/x", "release/v9.0.0"), (e: unknown) => e instanceof GitHubError && /release\/v9\.0\.0 does not exist/.test(e.message));
  });
  test("commitFiles makes one commit with every change and fast-forwards the branch", async () => {
    let blob = 0;
    const m = withBranches(new MockGitHub(), { "v0.1.0/x": "head1" })
      .on("GET", `${R}/git/commits/head1`, { body: { sha: "head1", tree: { sha: "tree0" } } })
      .on("POST", `${R}/git/blobs`, () => ({ status: 201, body: { sha: `blob${++blob}` } }))
      .on("POST", `${R}/git/trees`, { status: 201, body: { sha: "tree1" } })
      .on("POST", `${R}/git/commits`, { status: 201, body: { sha: "commit1" } })
      .on("PATCH", `${R}/git/refs/heads/v0.1.0/x`, { body: {} });
    const r = await commitFiles(client(m), "v0.1.0/x", [
      { path: "docs/adr/0001-a.md", content: "# A\n" },
      { path: "docs/attachment/0001-b.png", content: Buffer.from([0x89, 0x50]) },
      { path: "docs/old.md", delete: true },
    ], "Add ADR-0001");
    assert.deepEqual(r, { sha: "commit1", parent: "head1" });
    const blobs = m.callsTo("POST", `${R}/git/blobs`).map((c) => c.body as { content: string; encoding: string });
    assert.deepEqual(blobs.map((b) => Buffer.from(b.content, "base64").toString("hex")), [Buffer.from("# A\n").toString("hex"), "8950"]);
    const tree = m.callsTo("POST", `${R}/git/trees`)[0]!.body as { base_tree: string; tree: { path: string; sha: string | null }[] };
    assert.equal(tree.base_tree, "tree0");
    assert.deepEqual(tree.tree.map((t) => t.sha === null ? `-${t.path}` : t.path), ["docs/adr/0001-a.md", "docs/attachment/0001-b.png", "-docs/old.md"]);
    assert.deepEqual(m.callsTo("POST", `${R}/git/commits`)[0]!.body, { message: "Add ADR-0001", tree: "tree1", parents: ["head1"] });
    assert.deepEqual(m.callsTo("PATCH", `${R}/git/refs/heads/v0.1.0/x`)[0]!.body, { sha: "commit1", force: false });
  });
  test("createBranchWithCommit commits on the base head, then creates the ref at that commit", async () => {
    const { createBranchWithCommit } = await import("../../src/github/index.js");
    const m = withBranches(new MockGitHub(), { main: "base1" })
      .on("GET", `${R}/git/commits/base1`, { body: { sha: "base1", tree: { sha: "tree0" } } })
      .on("POST", `${R}/git/blobs`, { status: 201, body: { sha: "blob1" } })
      .on("POST", `${R}/git/trees`, { status: 201, body: { sha: "tree1" } })
      .on("POST", `${R}/git/commits`, { status: 201, body: { sha: "commit1" } })
      .on("POST", `${R}/git/refs`, { status: 201, body: {} });
    assert.deepEqual(await createBranchWithCommit(client(m), "v0.1.0/x", "main", [{ path: "a.md", content: "a" }], "Add a"), { sha: "commit1", parent: "base1" });
    assert.deepEqual(m.callsTo("POST", `${R}/git/commits`)[0]!.body, { message: "Add a", tree: "tree1", parents: ["base1"] });
    assert.deepEqual(m.callsTo("POST", `${R}/git/refs`)[0]!.body, { ref: "refs/heads/v0.1.0/x", sha: "commit1" });
    assert.equal(m.calls.filter((c) => c.method === "PATCH").length, 0);
    const order = m.calls.map((c) => `${c.method} ${c.path.replace(R, "")}`);
    assert.ok(order.indexOf("POST /git/commits") < order.indexOf("POST /git/refs"), "commit before ref");
  });

  test("openPullRequest posts head, base, title and body", async () => {
    const m = new MockGitHub().on("POST", `${R}/pulls`, { status: 201, body: { number: 7, html_url: "https://github.com/acme/docs/pull/7" } });
    assert.deepEqual(await openPullRequest(client(m), "v0.1.0/x", "main", "Add ADR-0001", "Body"), { number: 7, url: "https://github.com/acme/docs/pull/7", head: "v0.1.0/x", base: "main" });
    assert.deepEqual(m.calls[0]!.body, { head: "v0.1.0/x", base: "main", title: "Add ADR-0001", body: "Body" });
  });
});

describe("reading", () => {
  test("readFile decodes base64 content at a ref", async () => {
    const m = new MockGitHub().on("GET", `${R}/contents/docs/adr/0001-a b.md`, {
      body: { type: "file", path: "docs/adr/0001-a b.md", sha: "s1", size: 4, encoding: "base64", content: Buffer.from("# A\n").toString("base64") },
    });
    const f = await readFile(client(m), "docs/adr/0001-a b.md", "v2.0.0");
    assert.equal(f!.text(), "# A\n");
    assert.equal(f!.sha, "s1");
    assert.equal(m.calls[0]!.query.get("ref"), "v2.0.0");
  });
  test("readFile falls back to the blob for large files", async () => {
    const m = new MockGitHub()
      .on("GET", `${R}/contents/big.pdf`, { body: { type: "file", path: "big.pdf", sha: "s2", size: 2_000_000, encoding: "none", content: "" } })
      .on("GET", `${R}/git/blobs/s2`, { body: { content: Buffer.from("PDF").toString("base64"), encoding: "base64" } });
    assert.equal((await readFile(client(m), "big.pdf", "main"))!.text(), "PDF");
  });
  test("readFile returns undefined when missing", async () => {
    const m = new MockGitHub().on("GET", `${R}/contents/nope.md`, { status: 404, body: { message: "Not Found" } });
    assert.equal(await readFile(client(m), "nope.md", "main"), undefined);
  });
  test("listFolder lists entries; root and missing folders work", async () => {
    const entries = [
      { name: "adr", path: "docs/adr", type: "dir", sha: "d", size: 0, url: "x" },
      { name: "x.md", path: "docs/x.md", type: "file", sha: "f", size: 3, url: "y" },
    ];
    const m = new MockGitHub()
      .on("GET", `${R}/contents/docs`, { body: entries })
      .on("GET", `${R}/contents`, { body: [] })
      .on("GET", `${R}/contents/missing`, { status: 404, body: { message: "Not Found" } });
    assert.deepEqual(await listFolder(client(m), "docs/", "main"), entries.map(({ url: _u, ...e }) => e));
    assert.deepEqual(await listFolder(client(m), "", "main"), []);
    assert.equal(await listFolder(client(m), "missing", "main"), undefined);
  });
});
