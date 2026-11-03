import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { allocateIds, formatId, GitHubClient, GitHubError } from "../../src/github/index.js";
import { MockGitHub, R, REPO, type Call } from "./mock.js";

const noSleep = { sleep: async () => {} };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o, null, 2) + "\n").toString("base64");
const decode = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as Record<string, number>;
const client = (m: MockGitHub) => new GitHubClient({ token: "t", repository: REPO, fetch: m.fetch });
const CONTENTS = `${R}/contents/counters.json`;

/** In-memory meta/ids: GET returns the file, PUT is a compare-and-swap on the blob sha. */
function fakeIdsBranch(initial: Record<string, number> | undefined, opts: { jitter?: boolean } = {}) {
  const state = { content: initial ? b64(initial) : undefined as string | undefined, conflicts: 0 };
  const sha = () => createHash("sha1").update(state.content ?? "").digest("hex");
  const wait = () => (opts.jitter ? new Promise((r) => setTimeout(r, Math.random() * 3)) : Promise.resolve());
  const m = new MockGitHub()
    .on("GET", CONTENTS, async () => {
      await wait();
      return state.content === undefined ? { status: 404, body: { message: "Not Found" } } : { body: { sha: sha(), content: state.content, encoding: "base64" } };
    })
    .on("PUT", CONTENTS, async (c: Call) => {
      await wait();
      const body = c.body as { sha: string; content: string; branch: string };
      if (body.sha !== sha()) {
        state.conflicts++;
        return { status: 409, body: { message: `counters.json does not match ${body.sha}` } };
      }
      state.content = body.content;
      return { status: 200, body: { content: { sha: sha() } } };
    });
  return { m, state };
}

describe("ID allocation", () => {
  test("formatId pads to four digits", () => {
    assert.equal(formatId("ADR", 1), "ADR-0001");
    assert.equal(formatId("PROC", 42), "PROC-0042");
    assert.equal(formatId("TECH", 12345), "TECH-12345");
  });

  test("increments the counter and writes it back with the sha", async () => {
    const { m, state } = fakeIdsBranch({ ADR: 4, PROC: 1, TECH: 0, REL: 0, ATT: 0 });
    const a = await allocateIds(client(m), "ADR", 1, noSleep);
    assert.deepEqual(a, { ids: ["ADR-0005"], numbers: [5], retries: 0 });
    assert.deepEqual(decode(state.content!), { ADR: 5, PROC: 1, TECH: 0, REL: 0, ATT: 0 });
    const put = m.callsTo("PUT", CONTENTS)[0]!.body as { branch: string; message: string; sha: string };
    assert.equal(put.branch, "meta/ids");
    assert.equal(put.message, "Allocate ADR-0005");
    assert.equal(m.callsTo("GET", CONTENTS)[0]!.query.get("ref"), "meta/ids");
  });

  test("allocates a consecutive range in one write", async () => {
    const { m } = fakeIdsBranch({ PROC: 9 });
    const a = await allocateIds(client(m), "PROC", 3, noSleep);
    assert.deepEqual(a.ids, ["PROC-0010", "PROC-0011", "PROC-0012"]);
    assert.equal((m.callsTo("PUT", CONTENTS)[0]!.body as { message: string }).message, "Allocate PROC-0010..PROC-0012");
    assert.equal(m.callsTo("PUT", CONTENTS).length, 1);
  });

  test("a type missing from counters.json starts at 1", async () => {
    const { m } = fakeIdsBranch({ ADR: 3 });
    assert.deepEqual((await allocateIds(client(m), "ATT", 1, noSleep)).ids, ["ATT-0001"]);
  });

  test("retries after 409 with fresh data", async () => {
    const { m } = fakeIdsBranch({ ADR: 1 });
    let first = true;
    m.on("PUT", CONTENTS, () => {
      if (first) {
        first = false;
        return { status: 409, body: { message: "conflict" } };
      }
      return { status: 200, body: {} };
    });
    const a = await allocateIds(client(m), "ADR", 1, noSleep);
    assert.equal(a.retries, 1);
    assert.equal(m.callsTo("GET", CONTENTS).length, 2);
  });

  test("gives up after maxAttempts", async () => {
    const { m } = fakeIdsBranch({ ADR: 1 });
    m.on("PUT", CONTENTS, { status: 409, body: { message: "conflict" } });
    await assert.rejects(allocateIds(client(m), "ADR", 1, { ...noSleep, maxAttempts: 3 }), (e: unknown) => e instanceof GitHubError && /after 3 attempts/.test(e.message));
    assert.equal(m.callsTo("PUT", CONTENTS).length, 3);
  });

  test("a ruleset rejection (also 409) is not retried", async () => {
    const { m } = fakeIdsBranch({ ADR: 1 });
    m.on("PUT", CONTENTS, { status: 409, body: { message: "Repository rule violations found\n\nCannot update this protected ref.\n" } });
    await assert.rejects(allocateIds(client(m), "ADR", 1, noSleep), (e: unknown) => e instanceof GitHubError && /rejected/.test(e.message) && /meta\/ids/.test(e.nextAction));
    assert.equal(m.callsTo("PUT", CONTENTS).length, 1);
  });

  test("other errors are not retried", async () => {
    const { m } = fakeIdsBranch({ ADR: 1 });
    m.on("PUT", CONTENTS, { status: 403, body: { message: "Resource not accessible" } });
    await assert.rejects(allocateIds(client(m), "ADR", 1, noSleep), (e: unknown) => e instanceof GitHubError && e.status === 403);
    assert.equal(m.callsTo("PUT", CONTENTS).length, 1);
  });

  test("creates meta/ids as an orphan branch when it does not exist", async () => {
    const { m, state } = fakeIdsBranch(undefined);
    m.on("POST", `${R}/git/blobs`, (c) => ({ status: 201, body: { sha: "blob1", _content: (c.body as { content: string }).content } }))
      .on("POST", `${R}/git/trees`, { status: 201, body: { sha: "tree1" } })
      .on("POST", `${R}/git/commits`, { status: 201, body: { sha: "commit1" } })
      .on("POST", `${R}/git/refs`, (c) => {
        state.content = (m.callsTo("POST", `${R}/git/blobs`)[0]!.body as { content: string }).content;
        return { status: 201, body: { ref: (c.body as { ref: string }).ref } };
      });
    const a = await allocateIds(client(m), "REL", 1, noSleep);
    assert.deepEqual(a.ids, ["REL-0001"]);
    assert.deepEqual(decode((m.callsTo("POST", `${R}/git/blobs`)[0]!.body as { content: string }).content), { ADR: 0, PROC: 0, TECH: 0, REL: 0, ATT: 0 });
    assert.deepEqual((m.callsTo("POST", `${R}/git/commits`)[0]!.body as { parents: string[] }).parents, []);
    assert.deepEqual(m.callsTo("POST", `${R}/git/refs`)[0]!.body, { ref: "refs/heads/meta/ids", sha: "commit1" });
  });

  test("losing the race to create meta/ids is fine", async () => {
    const { m, state } = fakeIdsBranch(undefined);
    m.on("POST", `${R}/git/blobs`, { status: 201, body: { sha: "b" } })
      .on("POST", `${R}/git/trees`, { status: 201, body: { sha: "t" } })
      .on("POST", `${R}/git/commits`, { status: 201, body: { sha: "c" } })
      .on("POST", `${R}/git/refs`, () => {
        state.content = b64({ ADR: 7 }); // another client created it first
        return { status: 422, body: { message: "Reference already exists" } };
      });
    assert.deepEqual((await allocateIds(client(m), "ADR", 1, noSleep)).ids, ["ADR-0008"]);
  });

  test("5 parallel clients × 4 allocations give 20 unique consecutive IDs", async () => {
    const { m, state } = fakeIdsBranch({ ADR: 0 }, { jitter: true });
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const c = client(m);
        const got: number[] = [];
        for (let i = 0; i < 4; i++) got.push(...(await allocateIds(c, "ADR", 1, { backoffMs: [0, 2], maxAttempts: 200 })).numbers);
        return got;
      }),
    );
    const all = results.flat().sort((a, b) => a - b);
    assert.deepEqual(all, Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(decode(state.content!).ADR, 20);
    assert.ok(state.conflicts > 0, "expected contention in the simulation");
  });
});
