import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { parseYaml, splitFrontmatter } from "../src/engine/index.js";
import { packageRoot } from "../src/engine/package-root.js";
import { parseVersion } from "../src/github/index.js";
import { postMerge } from "../src/postmerge/postmerge.js";
import { createRelease, currentRelease, docsTagFor, mapRelease, parseRel } from "../src/release/release.js";
import { recordRelease } from "../src/release/tag.js";
import { FakeRepo } from "./docs/fakerepo.js";

const CONFIG_DIR = join(packageRoot(), "test", "fixtures", "valid", "config");
const temp = mkdtempSync(join(tmpdir(), "idc365-release-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const fm = (text: string) => parseYaml(splitFrontmatter(text)!.frontmatter) as Record<string, unknown>;

function config(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(CONFIG_DIR)) files[`config/${name}`] = readFileSync(join(CONFIG_DIR, name), "utf8");
  return files;
}
const rel = (n: string, version: string, phase: string, code = "") =>
  `---\nid: REL-${n}\ntitle: Release ${version}\ndescription: d\nintent: i\nwhen: w\nstate: accepted\nversion: ${version}\nphase: ${phase}\ndocs_branch: release/${version}\n${code}---\n`;

function repo(extra: Record<string, string> = {}): FakeRepo {
  const r = new FakeRepo();
  r.seed("main", { "README.md": "x", ...config(), ...extra });
  return r;
}

describe("release create", () => {
  test("writes the REL with phase planned on a work branch and opens a PR to main", async () => {
    const r = repo();
    const res = await createRelease(r.client(), "v2.0.0", { code: [{ repo: "idconnectdk/idc365", branch: "release/2.0" }], jiraFixVersion: "2.0", plannedDate: "2026-12-01" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.key, "REL-0001");
    assert.equal(res.base, "main");
    assert.match(res.branch, /^v2\.0\.0\/rel-0001-release-v2-0-0$/);
    const f = fm(r.files(res.branch).get(res.file)!);
    assert.deepEqual(
      { version: f.version, phase: f.phase, docs_branch: f.docs_branch, code: f.code, jira_fix_version: f.jira_fix_version, planned_date: f.planned_date },
      { version: "v2.0.0", phase: "planned", docs_branch: "release/v2.0.0", code: [{ repo: "idconnectdk/idc365", branch: "release/2.0" }], jira_fix_version: "2.0", planned_date: "2026-12-01" },
    );
    assert.equal(r.pulls[0]!.base, "main");
  });
  test("refuses a version that is not higher than the released one, or already has a REL", async () => {
    const r = repo({ "docs/release/0001-release-v2-0-0.md": rel("0001", "v2.0.0", "development") });
    r.tag("v1.5.0");
    const low = await createRelease(r.client(), "v1.5.0");
    assert.ok(!low.ok && /not higher than the released v1\.5\.0/.test(low.message));
    const dup = await createRelease(r.client(), "v2.0.0");
    assert.ok(!dup.ok && /already has a release document: REL-0001/.test(dup.message));
    const bad = await createRelease(r.client(), "2.0");
    assert.equal(bad.ok, false);
    assert.equal(r.pulls.length, 0);
  });
  test("refuses an unconfigured code repository (validation)", async () => {
    const r = repo();
    const res = await createRelease(r.client(), "v2.0.0", { code: [{ repo: "other/app", branch: "main" }] });
    assert.ok(!res.ok && (res.findings ?? []).some((f) => f.rule === "release.repo"));
  });
});

describe("release map", () => {
  test("adds or updates the mapping for one repository via PR", async () => {
    const r = repo({ "docs/release/0001-release-v2-0-0.md": rel("0001", "v2.0.0", "development", "code:\n  - repo: idconnectdk/idc365\n    branch: old\n") });
    const res = await mapRelease(r.client(), "1", "idconnectdk/idc365", "release/2.0");
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(fm(r.files(res.branch).get(res.file)!).code, [{ repo: "idconnectdk/idc365", branch: "release/2.0" }]);
    assert.deepEqual(Object.keys(fm(r.files(res.branch).get(res.file)!)), ["id", "title", "description", "intent", "when", "state", "version", "phase", "docs_branch", "code"], "fields keep their place");
    assert.equal(res.base, "main");
    const same = await mapRelease(r.client(), "REL-0001", "idconnectdk/idc365", "old");
    assert.ok(!same.ok && /already maps/.test(same.message));
  });
});

describe("release for and tag", () => {
  test("for: the highest tag at or below the product version", () => {
    const tags = ["v1.0.0", "v2.0.0", "v2.0.1", "v2.2.0", "vnext"];
    assert.equal(docsTagFor(parseVersion("v2.1.3")!, tags), "v2.0.1");
    assert.equal(docsTagFor(parseVersion("v2.2.0")!, tags), "v2.2.0");
    assert.equal(docsTagFor(parseVersion("v0.9.0")!, tags), undefined);
  });
});

describe("release tag: record the release in a PR", () => {
  test("a planned release: REL released (with date), previous released REL retired, one PR to main; no tag, no workflow", async () => {
    const r = repo({ "docs/release/0001-release-v1-0-0.md": rel("0001", "v1.0.0", "released"), "docs/release/0002-release-v2-0-0.md": rel("0002", "v2.0.0", "development") });
    r.tag("v1.0.0");
    const res = await recordRelease(r.client(), "v2.0.0", "2026-11-02");
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual([res.kind, res.rel, res.retired, res.branch], ["release", "REL-0002", ["REL-0001"], "v2.0.0/release-v2-0-0"]);
    const files = r.files(res.branch);
    assert.deepEqual([fm(files.get("docs/release/0002-release-v2-0-0.md")!).phase, fm(files.get("docs/release/0002-release-v2-0-0.md")!).released_date], ["released", "2026-11-02"]);
    assert.equal(fm(files.get("docs/release/0001-release-v1-0-0.md")!).phase, "retired");
    assert.equal(r.pulls[0]!.base, "main");
    assert.equal(r.pulls[0]!.title, "Release v2.0.0: REL-0002 released, REL-0001 retired");
    assert.equal(r.refs.has("tags/v2.0.0"), false, "the CLI never tags");
    assert.equal(r.mock.calls.some((c) => c.path.includes("/actions/")), false, "no workflow is started");
    assert.equal(fm(r.files("main").get("docs/release/0002-release-v2-0-0.md")!).phase, "development", "main changes only by the merge");
  });
  test("a patch without its own REL is appended to patches of the production REL", async () => {
    const r = repo({ "docs/release/0001-release-v1-0-0.md": rel("0001", "v1.0.0", "released") });
    r.tag("v1.0.0");
    const res = await recordRelease(r.client(), "v1.0.1");
    assert.ok(res.ok);
    assert.deepEqual([res.kind, res.rel], ["patch", "REL-0001"]);
    assert.deepEqual(fm(r.files(res.branch).get("docs/release/0001-release-v1-0-0.md")!).patches, ["v1.0.1"]);
  });
  test("refuses a version that is not higher, not strict, or neither a REL nor a patch", async () => {
    const r = repo({ "docs/release/0001-release-v1-0-0.md": rel("0001", "v1.0.0", "released") });
    r.tag("v1.0.0");
    for (const [v, re] of [["v1.0.0", /not higher/], ["v1.1", /not a version/], ["v1.2.0", /not a patch of the production release v1\.0\.0/]] as const) {
      const res = await recordRelease(r.client(), v);
      assert.ok(!res.ok && re.test(res.message), `${v}: ${JSON.stringify(res)}`);
    }
    const none = repo();
    const res = await recordRelease(none.client(), "v0.1.1");
    assert.ok(!res.ok && /no release is in production/.test(res.message));
    assert.equal(r.pulls.length + none.pulls.length, 0);
  });
});

const git = (root: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" }).trim();

describe("post-merge release hooks", () => {
  function checkout(relText: string) {
    const root = join(temp, Math.random().toString(36).slice(2));
    cpSync(join(packageRoot(), "test", "fixtures", "valid"), root, { recursive: true });
    rmSync(join(root, "docs/release"), { recursive: true, force: true });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "before");
    const before = git(root, "rev-parse", "HEAD");
    mkdirSync(join(root, "docs/release"), { recursive: true });
    writeFileSync(join(root, "docs/release/0005-release-v0-2-0.md"), relText);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "Merge pull request #3 from acme/v0.2.0/rel-0005-release-v0-2-0");
    return { root, before, after: git(root, "rev-parse", "HEAD") };
  }
  function remoteFrom(root: string): FakeRepo {
    const files: Record<string, string> = {};
    for (const p of git(root, "ls-files").split("\n")) files[p] = readFileSync(join(root, p), "utf8");
    const r = new FakeRepo();
    r.seed("main", files);
    return r;
  }

  test("a REL merged to main with phase planned: phase development, then release/<version> from main", async () => {
    const { root, before, after: head } = checkout(rel("0005", "v0.2.0", "planned"));
    const remote = remoteFrom(root);
    const r = await postMerge({ root, branch: "main", before, after: head, client: remote.client() });
    assert.equal(r.outcome, "committed");
    assert.equal(fm(remote.files("main").get("docs/release/0005-release-v0-2-0.md")!).phase, "development");
    assert.equal("relations" in fm(remote.files("main").get("docs/release/0005-release-v0-2-0.md")!), false, "no empty relations list added");
    assert.equal(remote.refs.get("heads/release/v0.2.0"), remote.refs.get("heads/main"), "branch created after the phase commit");
    assert.deepEqual(r.actions.map((a) => `${a.kind} ${"branch" in a ? a.branch : a.tag} ${a.done ? "done" : a.skipped}`), ["create-branch release/v0.2.0 done"]);
    // The same push again: nothing to do.
    const again = await postMerge({ root, branch: "main", before, after: head, client: remote.client() });
    assert.equal(again.outcome, "nothing");
  });

  test("a REL merged to a release branch triggers no release hook", async () => {
    const { root, before, after: head } = checkout(rel("0005", "v0.2.0", "planned"));
    const r = await postMerge({ root, branch: "release/v0.1.0", before, after: head, dryRun: true });
    assert.deepEqual(r.actions, []);
  });

  test("a merge of release/vX.Y.Z into main deletes the branch; a merge into a release branch does not", async () => {
    const root = join(temp, `merge-${Math.random().toString(36).slice(2)}`);
    cpSync(join(packageRoot(), "test", "fixtures", "valid"), root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    git(root, "checkout", "-q", "-b", "release/v0.2.0");
    writeFileSync(join(root, "docs/procedure/0001-documentation-workflow.md"), readFileSync(join(root, "docs/procedure/0001-documentation-workflow.md"), "utf8") + "\nRelease note.\n");
    git(root, "commit", "-qam", "release work");
    git(root, "checkout", "-q", "main");
    const before = git(root, "rev-parse", "HEAD");
    git(root, "merge", "--no-ff", "-q", "-m", "Merge pull request #9 from acme/release/v0.2.0", "release/v0.2.0");
    const merge = git(root, "rev-parse", "HEAD");
    const remote = remoteFrom(root);
    remote.seed("release/v0.2.0", {}, "main");
    const r = await postMerge({ root, branch: "main", before, after: merge, client: remote.client() });
    assert.deepEqual(r.actions.map((a) => `${a.kind} ${"branch" in a ? a.branch : a.tag} ${a.done ? "done" : a.skipped}`), ["delete-branch release/v0.2.0 done"]);
    assert.equal(remote.refs.has("heads/release/v0.2.0"), false);
    const into = await postMerge({ root, branch: "release/v0.3.0", before, after: merge, dryRun: true });
    assert.deepEqual(into.actions, []);
  });
});

describe("post-merge tag hook", () => {
  function merged(relText: string, tags: string[] = []) {
    const root = join(temp, `tag-${Math.random().toString(36).slice(2)}`);
    cpSync(join(packageRoot(), "test", "fixtures", "valid"), root, { recursive: true });
    rmSync(join(root, "docs/release"), { recursive: true, force: true });
    mkdirSync(join(root, "docs/release"), { recursive: true });
    writeFileSync(join(root, "docs/release/0005-release-v0-2-0.md"), rel("0005", "v0.2.0", "development"));
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "before");
    for (const t of tags) git(root, "tag", t);
    const before = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "docs/release/0005-release-v0-2-0.md"), relText);
    git(root, "commit", "-qam", "Merge pull request #7 from acme/v0.2.0/release-v0-2-0");
    const after = git(root, "rev-parse", "HEAD");
    const files: Record<string, string> = {};
    for (const p of git(root, "ls-files").split("\n")) files[p] = readFileSync(join(root, p), "utf8");
    const remote = new FakeRepo();
    remote.seed("main", files);
    for (const t of tags) remote.tag(t);
    return { root, before, after, remote };
  }

  test("a merged release record gets its tag on the merge commit; a rerun does nothing", async () => {
    const { root, before, after, remote } = merged(rel("0005", "v0.2.0", "released").replace("phase: released\n", "phase: released\nreleased_date: 2026-11-02\n"), ["v0.1.0"]);
    const r = await postMerge({ root, branch: "main", before, after, client: remote.client() });
    assert.equal(r.outcome, "committed");
    assert.deepEqual(r.actions.map((a) => `${a.kind} ${"tag" in a ? a.tag : a.branch} ${a.done ? "done" : a.skipped}`), ["create-tag v0.2.0 done"]);
    assert.equal(remote.refs.get("tags/v0.2.0"), after, "on the merge commit");
    const again = await postMerge({ root, branch: "main", before, after, client: remote.client() });
    assert.equal(again.outcome, "nothing", "an existing tag means nothing to do");
  });
  test("a patch appended to patches gets its tag; an already tagged or lower version does not", async () => {
    const { root, before, after, remote } = merged(rel("0005", "v0.2.0", "released").replace("phase: released\n", "phase: released\npatches:\n  - v0.1.5\n  - v0.2.1\n"), ["v0.2.0"]);
    const r = await postMerge({ root, branch: "main", before, after, client: remote.client() });
    assert.deepEqual(r.actions.map((a) => `${a.kind} ${"tag" in a ? a.tag : a.branch}`), ["create-tag v0.2.1"]);
    assert.equal(remote.refs.get("tags/v0.2.1"), after);
    assert.equal(remote.refs.has("tags/v0.1.5"), false);
  });
  test("no tag on a release branch, and none for a REL that is not released", async () => {
    const a = merged(rel("0005", "v0.2.0", "released"));
    assert.deepEqual((await postMerge({ root: a.root, branch: "release/v0.2.0", before: a.before, after: a.after, dryRun: true })).actions, []);
    const b = merged(rel("0005", "v0.2.0", "development").replace("state: accepted", "state: accepted\nplanned_date: 2026-12-01"));
    assert.deepEqual((await postMerge({ root: b.root, branch: "main", before: b.before, after: b.after, dryRun: true })).actions, []);
  });
});

describe("release current (code repository resolution)", () => {
  function codeRepo() {
    const root = join(temp, `code-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "remote", "add", "origin", "https://github.com/idconnectdk/idc365.git");
    writeFileSync(join(root, "a.txt"), "a");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "main 1");
    git(root, "checkout", "-q", "-b", "release/2.0");
    writeFileSync(join(root, "b.txt"), "b");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "release work");
    git(root, "checkout", "-q", "-b", "feature/x");
    writeFileSync(join(root, "c.txt"), "c");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "feature");
    git(root, "checkout", "-q", "main");
    git(root, "checkout", "-q", "-b", "other/y");
    writeFileSync(join(root, "d.txt"), "d");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "other");
    return root;
  }
  const rels = [parseRel("docs/release/0001-r.md", rel("0001", "v2.0.0", "development", "code:\n  - repo: idconnectdk/idc365\n    branch: release/2.0\n"))!];
  const r = repo();
  r.seed("release/v2.0.0", {}, "main");

  test("a mapped branch resolves directly", async () => {
    const root = codeRepo();
    git(root, "checkout", "-q", "release/2.0");
    const res = await currentRelease(r.client(), root, rels);
    assert.ok(res.ok);
    assert.deepEqual([res.how, res.rel.id, res.docsBranch], ["direct", "REL-0001", "release/v2.0.0"]);
  });
  test("a feature branch from a mapped branch inherits it", async () => {
    const root = codeRepo();
    git(root, "checkout", "-q", "feature/x");
    const res = await currentRelease(r.client(), root, rels);
    assert.ok(res.ok);
    assert.deepEqual([res.how, res.mappedBranch], ["inherited", "release/2.0"]);
  });
  test("a branch from main that is not mapped is orphaned and gets the map command", async () => {
    const root = codeRepo();
    git(root, "checkout", "-q", "other/y");
    const res = await currentRelease(r.client(), root, rels);
    assert.ok(!res.ok);
    assert.match(res.nextAction, /release map --repo idconnectdk\/idc365 --branch other\/y <REL-ID>/);
    assert.match(res.nextAction, /Do not guess/);
  });
  test("a released REL whose release branch is gone points to main", async () => {
    const root = codeRepo();
    git(root, "checkout", "-q", "release/2.0");
    const gone = new FakeRepo();
    gone.seed("main", { "README.md": "x" });
    const res = await currentRelease(gone.client(), root, rels);
    assert.ok(res.ok && res.docsBranch === "main" && !res.docsBranchExists);
  });
});
