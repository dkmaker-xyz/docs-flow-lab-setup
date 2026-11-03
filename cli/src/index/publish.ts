import { encodePath, GitHubError, type GitHubClient } from "../github/index.js";
import { branchHead } from "../github/index.js";
import { INDEX_BRANCH, indexFileName, type BranchIndex } from "./model.js";

export interface CasOptions {
  maxAttempts?: number;
  backoffMs?: [number, number];
  sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRuleViolation(data: unknown): boolean {
  return /rule violation/i.test(String((data as { message?: string } | undefined)?.message ?? ""));
}

function ruleError(op: string, data: unknown): GitHubError {
  const message = String((data as { message?: string } | undefined)?.message ?? "").split("\n")[0];
  return new GitHubError(409, `${op} on ${INDEX_BRANCH} was rejected: ${message}`, "Only the bot may write meta/index. Run index publish in the index workflow with the bot token.", `PUT ${INDEX_BRANCH}`);
}

/** Creates meta/index as an orphan branch holding one file. False when it already exists. */
async function createIndexBranch(client: GitHubClient, path: string, content: string): Promise<boolean> {
  const blob = await client.request<{ sha: string }>("POST", client.repoPath("/git/blobs"), { body: { content: Buffer.from(content).toString("base64"), encoding: "base64" } });
  const tree = await client.request<{ sha: string }>("POST", client.repoPath("/git/trees"), { body: { tree: [{ path, mode: "100644", type: "blob", sha: blob.data.sha }] } });
  const commit = await client.request<{ sha: string }>("POST", client.repoPath("/git/commits"), { body: { message: `Index ${path}`, tree: tree.data.sha, parents: [] } });
  const ref = await client.request("POST", client.repoPath("/git/refs"), { body: { ref: `refs/heads/${INDEX_BRANCH}`, sha: commit.data.sha }, allow: [422] });
  if (ref.status !== 422) return true;
  // 422 is either "already exists" (another run won) or a ruleset rejection, which may only say "Reference update failed".
  if (await branchHead(client, INDEX_BRANCH)) return false;
  throw ruleError("creating the branch", ref.data);
}

export interface PublishResult {
  path: string;
  /**
   * - created-branch / written: published.
   * - skipped-superseded: the branch moved past this index's sourceSha; a newer build publishes.
   * - skipped-deleted: the branch no longer exists (any leftover index file is removed).
   * - removed-deleted: the branch was deleted while publishing; the file just written was removed again.
   */
  outcome: "created-branch" | "written" | "skipped-superseded" | "skipped-deleted" | "removed-deleted";
  retries: number;
}

/**
 * Writes `<branch>.json` to meta/index with the Contents API (compare-and-swap
 * on the blob sha), creating meta/index when missing. 409 means another run
 * won and is retried; a ruleset rejection (also 409) is not.
 */
export async function publishIndex(client: GitHubClient, index: BranchIndex, opts: CasOptions = {}): Promise<PublishResult> {
  const path = indexFileName(index.branch);
  const content = JSON.stringify(index, null, 2) + "\n";
  const api = client.repoPath(`/contents/${encodePath(path)}`);
  // Only the index of the current head is published, and a deleted branch never gets its index back.
  const head = await branchHead(client, index.branch);
  if (!head) {
    await deleteIndex(client, index.branch, opts);
    return { path, outcome: "skipped-deleted", retries: 0 };
  }
  if (head !== index.sourceSha) return { path, outcome: "skipped-superseded", retries: 0 };
  const written = await writeIndexFile(client, index, path, content, api, opts);
  // The branch may have been deleted between the check and the write, and its remove run may already be done.
  if (!(await branchHead(client, index.branch))) {
    await deleteIndex(client, index.branch, opts);
    return { path, outcome: "removed-deleted", retries: written.retries };
  }
  return written;
}

async function writeIndexFile(client: GitHubClient, index: BranchIndex, path: string, content: string, api: string, opts: CasOptions): Promise<PublishResult> {
  const maxAttempts = opts.maxAttempts ?? 20;
  const [lo, hi] = opts.backoffMs ?? [100, 1000];
  const sleep = opts.sleep ?? sleepReal;
  let retries = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await client.request<{ sha: string }>("GET", api, { query: { ref: INDEX_BRANCH }, allow: [404] });
    if (current.status === 404 && !(await branchHead(client, INDEX_BRANCH))) {
      if (await createIndexBranch(client, path, content)) return { path, outcome: "created-branch", retries };
      retries++;
      continue;
    }
    const put = await client.request("PUT", api, {
      body: {
        message: `Index ${index.branch} at ${index.sourceSha.slice(0, 7)}`,
        content: Buffer.from(content).toString("base64"),
        branch: INDEX_BRANCH,
        ...(current.status === 404 ? {} : { sha: current.data.sha }),
      },
      allow: [409, 422],
    });
    if (put.status === 200 || put.status === 201) return { path, outcome: "written", retries };
    if (isRuleViolation(put.data)) throw ruleError("writing the index", put.data);
    if (put.status === 422 && !/sha/i.test(String((put.data as { message?: string }).message))) {
      throw new GitHubError(422, `writing ${path} failed: ${String((put.data as { message?: string }).message)}`, "Check the details and run the index workflow again.", `PUT contents/${path}`);
    }
    retries++; // 409, or 422 "sha wasn't supplied" after a concurrent create
    await sleep(lo + Math.random() * (hi - lo));
  }
  throw new GitHubError(409, `could not write ${path} after ${maxAttempts} attempts`, "Run the index workflow again.", `PUT contents/${path}`);
}

/** Removes `<branch>.json` from meta/index (branch deleted). Returns false when there was nothing to remove. */
export async function deleteIndex(client: GitHubClient, branch: string, opts: CasOptions = {}): Promise<boolean> {
  const path = indexFileName(branch);
  const api = client.repoPath(`/contents/${encodePath(path)}`);
  const maxAttempts = opts.maxAttempts ?? 20;
  const [lo, hi] = opts.backoffMs ?? [100, 1000];
  const sleep = opts.sleep ?? sleepReal;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await client.request<{ sha: string }>("GET", api, { query: { ref: INDEX_BRANCH }, allow: [404] });
    if (current.status === 404) return false;
    const del = await client.request("DELETE", api, { body: { message: `Remove index of deleted branch ${branch}`, sha: current.data.sha, branch: INDEX_BRANCH }, allow: [409] });
    if (del.status !== 409) return true;
    if (isRuleViolation(del.data)) throw ruleError("removing the index", del.data);
    await sleep(lo + Math.random() * (hi - lo));
  }
  throw new GitHubError(409, `could not remove ${path} after ${maxAttempts} attempts`, "Run the index workflow again.", `DELETE contents/${path}`);
}

/** Login of whoever merged the PR that produced `sha`, or null. Cached per run. */
export function mergedByLookup(client: GitHubClient): (sha: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (sha) => {
    if (!cache.has(sha)) {
      cache.set(
        sha,
        (async () => {
          const prs = await client.request<{ number: number; merged_at: string | null; merge_commit_sha: string | null }[]>("GET", client.repoPath(`/commits/${sha}/pulls`));
          const pr = prs.data.find((p) => p.merged_at && p.merge_commit_sha === sha) ?? prs.data.find((p) => p.merged_at);
          if (!pr) return null;
          const full = await client.request<{ merged_by: { login: string } | null }>("GET", client.repoPath(`/pulls/${pr.number}`));
          return full.data.merged_by?.login ?? null;
        })(),
      );
    }
    return cache.get(sha)!;
  };
}
