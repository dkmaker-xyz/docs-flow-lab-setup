import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { API_VERSION, GitHubClient, GitHubError } from "../../src/github/index.js";
import { MockGitHub, R, REPO } from "./mock.js";

const client = (m: MockGitHub) => new GitHubClient({ token: "t0k", repository: REPO, fetch: m.fetch });

async function rejects(p: Promise<unknown>): Promise<GitHubError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof GitHubError, `expected GitHubError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the call to fail");
}

describe("GitHubClient", () => {
  test("rejects a repository that is not owner/repo", () => {
    assert.throws(() => new GitHubClient({ token: "t", repository: "nope" }));
  });

  test("sends auth, API version, accept, query and JSON body", async () => {
    const m = new MockGitHub().on("POST", `${R}/thing`, { status: 201, body: { ok: 1 } });
    const res = await client(m).request<{ ok: number }>("POST", `${R}/thing`, { query: { ref: "meta/ids", skip: undefined }, body: { a: 1 } });
    assert.equal(res.status, 201);
    assert.deepEqual(res.data, { ok: 1 });
    const call = m.calls[0]!;
    assert.equal(call.headers.authorization, "Bearer t0k");
    assert.equal(call.headers["x-github-api-version"], API_VERSION);
    assert.equal(call.headers.accept, "application/vnd.github+json");
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.query.get("ref"), "meta/ids");
    assert.equal(call.query.has("skip"), false);
    assert.deepEqual(call.body, { a: 1 });
  });

  test("surfaces rate-limit headers", async () => {
    const m = new MockGitHub().on("GET", `${R}`, {
      body: {},
      headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4990", "x-ratelimit-used": "10", "x-ratelimit-reset": "1900000000", "x-ratelimit-resource": "core" },
    });
    const c = client(m);
    await c.request("GET", R);
    assert.deepEqual(c.rateLimit, { limit: 5000, remaining: 4990, used: 10, reset: new Date(1900000000 * 1000), resource: "core" });
  });

  test("allowed statuses are returned, not thrown", async () => {
    const m = new MockGitHub().on("GET", `${R}/x`, { status: 404, body: { message: "Not Found" } });
    const res = await client(m).request("GET", `${R}/x`, { allow: [404] });
    assert.equal(res.status, 404);
  });

  test("401 gives a token next action", async () => {
    const m = new MockGitHub().on("GET", R, { status: 401, body: { message: "Bad credentials" } });
    const err = await rejects(client(m).request("GET", R));
    assert.equal(err.status, 401);
    assert.match(err.message, /401: Bad credentials/);
    assert.match(err.nextAction, /IDC365_DECISIONS_TOKEN/);
    assert.match(err.nextAction, /Documentation token/);
  });

  test("403 with no remaining rate limit gives a wait next action", async () => {
    const m = new MockGitHub().on("GET", R, {
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" },
    });
    const err = await rejects(client(m).request("GET", R));
    assert.match(err.nextAction, /rate limit is used up.*2030-03-17T17:46:40\.000Z/);
  });

  test("429 uses retry-after", async () => {
    const m = new MockGitHub().on("GET", R, { status: 429, body: { message: "slow down" }, headers: { "retry-after": "30" } });
    const err = await rejects(client(m).request("GET", R));
    assert.match(err.nextAction, /in 30 seconds/);
  });

  test("403 without rate limit means missing permission", async () => {
    const m = new MockGitHub().on("GET", R, { status: 403, body: { message: "Resource not accessible by personal access token" } });
    const err = await rejects(client(m).request("GET", R));
    assert.match(err.nextAction, /Contents and Pull requests/);
  });

  test("ruleset rejection gives the PR next action and keeps the details", async () => {
    const m = new MockGitHub().on("PATCH", `${R}/git/refs/heads/main`, {
      status: 422,
      body: { message: "Repository rule violations found\n\nChanges must be made through a pull request.\n\n" },
    });
    const err = await rejects(client(m).request("PATCH", `${R}/git/refs/heads/main`, { body: {} }));
    assert.equal(err.status, 422);
    assert.match(err.message, /Repository rule violations found$/);
    assert.deepEqual(err.details, ["Changes must be made through a pull request."]);
    assert.match(err.nextAction, /pull request that a human merges/);
    assert.equal(err.request, `PATCH ${R}/git/refs/heads/main`);
  });

  test("422 errors[] become details", async () => {
    const m = new MockGitHub().on("POST", `${R}/pulls`, {
      status: 422,
      body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and x" }] },
    });
    const err = await rejects(client(m).request("POST", `${R}/pulls`, { body: {} }));
    assert.deepEqual(err.details, ["No commits between main and x"]);
  });

  test("5xx is thrown once, never retried", async () => {
    const m = new MockGitHub().on("GET", R, { status: 502, body: { message: "Bad Gateway" } });
    const err = await rejects(client(m).request("GET", R));
    assert.equal(err.status, 502);
    assert.match(err.nextAction, /again in a minute/);
    assert.equal(m.calls.length, 1);
  });

  test("network failure becomes status 0 after one retry of a GET", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
    }) as typeof fetch;
    const c = new GitHubClient({ token: "t", repository: REPO, fetch: failing });
    const err = await rejects(c.request("GET", R));
    assert.equal(err.status, 0);
    assert.match(err.message, /UND_ERR_SOCKET/);
    assert.match(err.nextAction, /network/);
    assert.equal(calls, 2);
  });

  test("a GET succeeds when the retry after a transport failure works", async () => {
    const m = new MockGitHub().on("GET", R, { body: { ok: true } });
    let calls = 0;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (++calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
      return m.fetch(input, init);
    }) as typeof fetch;
    const res = await new GitHubClient({ token: "t", repository: REPO, fetch: flaky }).request("GET", R);
    assert.deepEqual(res.data, { ok: true });
    assert.equal(calls, 2);
  });

  test("writes are never retried after a transport failure", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      let calls = 0;
      const failing = (async () => {
        calls++;
        throw new TypeError("fetch failed");
      }) as typeof fetch;
      const err = await rejects(new GitHubClient({ token: "t", repository: REPO, fetch: failing }).request(method, R, { body: {} }));
      assert.equal(err.status, 0);
      assert.equal(calls, 1, method);
    }
  });

  test("an HTTP error on a GET is not retried", async () => {
    const m = new MockGitHub().on("GET", R, { status: 500, body: { message: "boom" } });
    await rejects(client(m).request("GET", R));
    assert.equal(m.calls.length, 1);
  });
});
