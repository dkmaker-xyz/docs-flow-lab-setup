import { encodePath, type GitHubClient } from "./client.js";
import { GitHubError } from "./errors.js";

/** Head commit SHA of a branch, or undefined when it does not exist. */
export async function branchHead(client: GitHubClient, branch: string): Promise<string | undefined> {
  const res = await client.request<{ object: { sha: string } }>("GET", client.repoPath(`/git/ref/heads/${encodePath(branch)}`), { allow: [404] });
  return res.status === 404 ? undefined : res.data.object.sha;
}

/** Creates `branch` pointing at the head of `from`. */
export async function createBranch(client: GitHubClient, branch: string, from: string): Promise<string> {
  const sha = await branchHead(client, from);
  if (!sha) throw new GitHubError(404, `base branch ${from} does not exist`, `Create ${from} first, or choose another base.`, `GET git/ref/heads/${from}`);
  await client.request("POST", client.repoPath("/git/refs"), { body: { ref: `refs/heads/${branch}`, sha } });
  return sha;
}

export interface FileChange {
  path: string;
  /** New content; text is committed as UTF-8. Omit together with `delete: true` to remove the file. */
  content?: string | Buffer;
  delete?: boolean;
}

export interface CommitResult {
  sha: string;
  parent: string;
}

/** Builds a commit on top of `parent` with all changes (blobs, a tree on the parent's tree, the commit). No ref moves. */
export async function buildCommit(client: GitHubClient, parent: string, changes: FileChange[], message: string): Promise<string> {
  if (changes.length === 0) throw new Error("a commit needs at least one change");
  const commit = await client.request<{ tree: { sha: string } }>("GET", client.repoPath(`/git/commits/${parent}`));
  const tree = await Promise.all(
    changes.map(async (c) => {
      if (c.delete) return { path: c.path, mode: "100644", type: "blob", sha: null };
      if (c.content === undefined) throw new Error(`no content for ${c.path}`);
      const buf = typeof c.content === "string" ? Buffer.from(c.content, "utf8") : c.content;
      const blob = await client.request<{ sha: string }>("POST", client.repoPath("/git/blobs"), { body: { content: buf.toString("base64"), encoding: "base64" } });
      return { path: c.path, mode: "100644", type: "blob", sha: blob.data.sha };
    }),
  );
  const newTree = await client.request<{ sha: string }>("POST", client.repoPath("/git/trees"), { body: { base_tree: commit.data.tree.sha, tree } });
  const newCommit = await client.request<{ sha: string }>("POST", client.repoPath("/git/commits"), { body: { message, tree: newTree.data.sha, parents: [parent] } });
  return newCommit.data.sha;
}

/**
 * Commits all changes to an existing `branch` as one commit (Git Data API),
 * then fast-forwards the branch.
 */
export async function commitFiles(client: GitHubClient, branch: string, changes: FileChange[], message: string): Promise<CommitResult> {
  const parent = await branchHead(client, branch);
  if (!parent) throw new GitHubError(404, `branch ${branch} does not exist`, "Create the work branch first.", `GET git/ref/heads/${branch}`);
  const sha = await buildCommit(client, parent, changes, message);
  await client.request("PATCH", client.repoPath(`/git/refs/heads/${encodePath(branch)}`), { body: { sha, force: false } });
  return { sha, parent };
}

/**
 * Creates a new `branch` whose first commit holds the changes: the commit is
 * made on the head of `from` first, then the ref is created at it, so the new
 * branch causes one push instead of two.
 */
export async function createBranchWithCommit(client: GitHubClient, branch: string, from: string, changes: FileChange[], message: string): Promise<CommitResult> {
  const parent = await branchHead(client, from);
  if (!parent) throw new GitHubError(404, `base branch ${from} does not exist`, `Create ${from} first, or choose another base.`, `GET git/ref/heads/${from}`);
  const sha = await buildCommit(client, parent, changes, message);
  await client.request("POST", client.repoPath("/git/refs"), { body: { ref: `refs/heads/${branch}`, sha } });
  return { sha, parent };
}

export interface PullRequest {
  number: number;
  url: string;
  head: string;
  base: string;
}

/** Opens a pull request from `head` to `base`. There is deliberately no merge function: a human merges. */
export async function openPullRequest(client: GitHubClient, head: string, base: string, title: string, body: string): Promise<PullRequest> {
  const res = await client.request<{ number: number; html_url: string }>("POST", client.repoPath("/pulls"), { body: { head, base, title, body } });
  return { number: res.data.number, url: res.data.html_url, head, base };
}
