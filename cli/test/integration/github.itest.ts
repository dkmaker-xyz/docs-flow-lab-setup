/**
 * Integration tests against a real, disposable documentation repository.
 * Opt-in: `IDC365_TEST_REPO=<owner/repo> IDC365_DECISIONS_TOKEN=... npm run test:integration`.
 * Never part of `npm test` or CI. The repository name comes only from the environment.
 *
 * The tests never merge. Every pull request they open is closed and every
 * branch they create is deleted again; meta/ids stays (and advances).
 */
import assert from "node:assert/strict";
import { after, before, describe, test, type TestContext } from "node:test";
import {
  allocateIds,
  baseBranchFor,
  branchHead,
  commitFiles,
  createBranch,
  GitHubClient,
  GitHubError,
  IDS_BRANCH,
  listFolder,
  openPullRequest,
  readFile,
  releasedVersion,
  workBranchName,
  type PullRequest,
} from "../../src/github/index.js";

const REPOSITORY = process.env.IDC365_TEST_REPO ?? "";
const TOKEN = process.env.IDC365_DECISIONS_TOKEN ?? "";
const skip = !REPOSITORY || !TOKEN ? "set IDC365_TEST_REPO and IDC365_DECISIONS_TOKEN to run integration tests" : false;
const RUN = `itest-${Date.now().toString(36)}`;
const VERSION = "v0.1.0";

const newClient = () => new GitHubClient({ repository: REPOSITORY, token: TOKEN });
const cleanup: { branches: string[]; prs: number[] } = { branches: [], prs: [] };

function note(t: TestContext, label: string, value: unknown) {
  t.diagnostic(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

/** Runs a call that the repository's rules must reject; returns the rejection. */
async function expectRejected(p: Promise<unknown>): Promise<GitHubError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GitHubError) return err;
    throw err;
  }
  assert.fail("the call succeeded but must be rejected");
}

const describeRejection = (e: GitHubError) => `${e.status} ${e.message}${e.details.length ? ` | ${e.details.join(" | ")}` : ""}`;

describe("GitHub integration", { skip, concurrency: 1 }, () => {
  let client: GitHubClient;
  before(() => {
    client = newClient();
  });
  after(async () => {
    if (!client) return;
    for (const n of cleanup.prs) await client.request("PATCH", client.repoPath(`/pulls/${n}`), { body: { state: "closed" } }).catch(() => {});
    for (const b of cleanup.branches) await client.request("DELETE", client.repoPath(`/git/refs/heads/${b}`), { allow: [404, 422] }).catch(() => {});
  });

  test("2.1: 5 parallel clients × 4 ADR IDs are unique and consecutive", async (t) => {
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const c = newClient(); // one client per simulated CLI
        const got: { id: string; n: number; retries: number }[] = [];
        for (let i = 0; i < 4; i++) {
          const a = await allocateIds(c, "ADR");
          got.push({ id: a.ids[0]!, n: a.numbers[0]!, retries: a.retries });
        }
        return got;
      }),
    );
    const flat = results.flat();
    const numbers = flat.map((r) => r.n).sort((a, b) => a - b);
    note(t, "ids", flat.map((r) => r.id).sort());
    note(t, "retries", flat.reduce((s, r) => s + r.retries, 0));
    assert.equal(new Set(numbers).size, 20, "IDs must be unique");
    assert.equal(numbers[19]! - numbers[0]!, 19, "IDs must be consecutive");
  });

  test("base branch with the repository's current tags", async (t) => {
    const released = await releasedVersion(client);
    note(t, "released version", released ?? "none (no vX.Y.Z tag)");
    const r = await baseBranchFor(client, VERSION);
    note(t, `base for ${VERSION}`, r);
    if (!released) {
      assert.deepEqual(r, { ok: true, base: "main", reason: "no-release-yet" });
    } else {
      assert.ok(r.ok || /release create/.test(r.nextAction));
    }
    const far = await baseBranchFor(client, "v999.0.0");
    note(t, "base for v999.0.0", far);
    if (released) assert.equal(far.ok, false);
  });

  test("2.2 + branch/commit/PR: two work branches allocate different IDs, commit, open PRs (never merged)", async (t) => {
    const base = await baseBranchFor(client, VERSION);
    assert.ok(base.ok);
    const branches = ["a", "b"].map((s) => workBranchName(VERSION, `${RUN}-${s}`));
    cleanup.branches.push(...branches);
    const prs: (PullRequest & { title: string })[] = await Promise.all(
      branches.map(async (branch) => {
        const c = newClient();
        await createBranch(c, branch, base.base);
        const { ids } = await allocateIds(c, "PROC");
        const id = ids[0]!;
        const file = `docs/procedure/${id.slice(5)}-${RUN}.md`;
        const commit = await commitFiles(c, branch, [
          { path: file, content: `---\nid: ${id}\ntitle: Integration test ${RUN}\n---\nTest data.\n` },
          { path: `docs/procedure/${id.slice(5)}-${RUN}-note.md`, content: "second file in the same commit\n" },
        ], `Add ${id} (integration test)`);
        const pr = await openPullRequest(c, branch, base.base, `Integration test ${id}`, "Opened by the CLI integration tests. Never merge; the test closes it.");
        cleanup.prs.push(pr.number);
        const read = await readFile(c, file, branch);
        assert.match(read!.text(), new RegExp(`id: ${id}`));
        const listed = await listFolder(c, "docs/procedure", branch);
        assert.ok(listed!.some((e) => e.path === file));
        const files = await c.request<{ filename: string }[]>("GET", c.repoPath(`/pulls/${pr.number}/files`));
        assert.equal(files.data.length, 2, "both files are in the PR");
        const commits = await c.request<unknown[]>("GET", c.repoPath(`/pulls/${pr.number}/commits`));
        assert.equal(commits.data.length, 1, "one commit");
        note(t, branch, { id, commit: commit.sha, pr: pr.number, url: pr.url });
        return { ...pr, title: id };
      }),
    );
    assert.notEqual(prs[0]!.title, prs[1]!.title, "IDs from two branches must differ");
  });

  test("1.1: direct push to main is rejected (Git Data API and Contents API)", async (t) => {
    const git = await expectRejected(commitFiles(client, "main", [{ path: `${RUN}.md`, content: "x\n" }], "direct push"));
    note(t, "git refs update", describeRejection(git));
    assert.match(`${git.message} ${git.details.join(" ")}`, /rule violation|pull request/i);
    const contents = await expectRejected(
      client.request("PUT", client.repoPath(`/contents/${RUN}.md`), { body: { message: "direct push", content: Buffer.from("x").toString("base64"), branch: "main" } }),
    );
    note(t, "contents PUT", describeRejection(contents));
  });

  test("1.4: writing to meta/index is rejected", async (t) => {
    if (!(await branchHead(client, "meta/index"))) {
      t.skip("meta/index does not exist; creating it would be permanent, so the write test needs the bot to create it first");
      return;
    }
    const e = await expectRejected(commitFiles(client, "meta/index", [{ path: `${RUN}.json`, content: "{}\n" }], "developer write"));
    note(t, "meta/index update", describeRejection(e));
  });

  test("1.5: force push and deletion of meta/ids are rejected", async (t) => {
    const head = await branchHead(client, IDS_BRANCH);
    assert.ok(head, "meta/ids exists after the allocation tests");
    const commit = await client.request<{ parents: { sha: string }[] }>("GET", client.repoPath(`/git/commits/${head}`));
    const parent = commit.data.parents[0]?.sha;
    assert.ok(parent, "meta/ids has history to rewind");
    const force = await expectRejected(client.request("PATCH", client.repoPath(`/git/refs/heads/${IDS_BRANCH}`), { body: { sha: parent, force: true } }));
    note(t, "force push", describeRejection(force));
    const del = await expectRejected(client.request("DELETE", client.repoPath(`/git/refs/heads/${IDS_BRANCH}`)));
    note(t, "delete", describeRejection(del));
    assert.equal(await branchHead(client, IDS_BRANCH), head, "meta/ids is unchanged");
  });

  test("1.6: creating a v* tag is rejected", async (t) => {
    // Not a semantic version, so it could never count as a release even if the rule failed.
    const tag = `v-${RUN}`;
    const head = await branchHead(client, "main");
    const e = await expectRejected(client.request("POST", client.repoPath("/git/refs"), { body: { ref: `refs/tags/${tag}`, sha: head } }));
    note(t, `create ${tag}`, describeRejection(e));
    const exists = await client.request("GET", client.repoPath(`/git/ref/tags/${tag}`), { allow: [404] });
    assert.equal(exists.status, 404, "the tag does not exist");
    // Control: the same call for a tag outside v* succeeds, so the rejection comes from the tag rule.
    const control = `control-${RUN}`;
    await client.request("POST", client.repoPath("/git/refs"), { body: { ref: `refs/tags/${control}`, sha: head } });
    await client.request("DELETE", client.repoPath(`/git/refs/tags/${control}`));
    note(t, "control", `created and deleted tag ${control}`);
  });

  test("reading at a ref: README on main and the root folder", async () => {
    const readme = await readFile(client, "README.md", "main");
    assert.ok(readme && readme.size > 0);
    const root = await listFolder(client, "", "main");
    assert.ok(root!.some((e) => e.path === "README.md"));
  });
});
