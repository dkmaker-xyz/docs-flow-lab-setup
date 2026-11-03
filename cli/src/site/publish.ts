import { createHash } from "node:crypto";
import { branchHead, encodePath, GitHubError, type GitHubClient } from "../github/index.js";
import { FOLDER_RE, folderName, SITE_BRANCH, SITE_REF_RE, type SiteManifest } from "./render.js";

/**
 * Writes one site folder to meta/site (phase 11), the way publishIndex writes
 * meta/index: one bot commit that replaces the folder, compare-and-swap on
 * the branch head with retries, only for the current head of the source
 * ref, and a deleted branch never gets its folder back.
 */

export interface SitePublishOptions {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type SitePublishOutcome = "created-branch" | "written" | "unchanged" | "skipped-superseded" | "skipped-deleted" | "removed" | "absent";

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Git's blob id for content, to skip files that did not change. */
export function blobSha(content: string | Buffer): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/** The commit a branch or v* tag points at now, or undefined when it is gone. */
export async function refHead(client: GitHubClient, ref: string, kind: "branch" | "tag"): Promise<string | undefined> {
  if (kind === "branch") return branchHead(client, ref);
  const res = await client.request<{ object: { sha: string; type: string } }>("GET", client.repoPath(`/git/ref/tags/${encodePath(ref)}`), { allow: [404] });
  if (res.status === 404) return undefined;
  if (res.data.object.type !== "tag") return res.data.object.sha;
  const tag = await client.request<{ object: { sha: string } }>("GET", client.repoPath(`/git/tags/${res.data.object.sha}`));
  return tag.data.object.sha;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

async function folderEntries(client: GitHubClient, head: string, folder: string): Promise<Map<string, string>> {
  const commit = await client.request<{ tree: { sha: string } }>("GET", client.repoPath(`/git/commits/${head}`));
  const tree = await client.request<{ tree: TreeEntry[]; truncated?: boolean }>("GET", client.repoPath(`/git/trees/${commit.data.tree.sha}`), { query: { recursive: 1 } });
  if (tree.data.truncated) throw new GitHubError(500, `the ${SITE_BRANCH} tree is too large to list`, "Split the site or remove old folders.", "GET git/trees");
  const out = new Map<string, string>();
  for (const e of tree.data.tree) if (e.type === "blob" && e.path.startsWith(`${folder}/`)) out.set(e.path.slice(folder.length + 1), e.sha);
  return out;
}

/** One commit on meta/site (or its first, orphan commit) that makes `folder` hold exactly `files`. */
async function writeFolder(client: GitHubClient, folder: string, files: Map<string, string> | undefined, message: string, o: SitePublishOptions): Promise<SitePublishOutcome> {
  const sleep = o.sleep ?? sleepReal;
  for (let attempt = 1; attempt <= (o.maxAttempts ?? 20); attempt++) {
    const head = await branchHead(client, SITE_BRANCH);
    const existing = head ? await folderEntries(client, head, folder) : new Map<string, string>();
    if (!files && existing.size === 0) return "absent";
    const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
    for (const [path, content] of files ?? []) {
      if (existing.get(path) === blobSha(content)) continue;
      const blob = await client.request<{ sha: string }>("POST", client.repoPath("/git/blobs"), { body: { content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" } });
      tree.push({ path: `${folder}/${path}`, mode: "100644", type: "blob", sha: blob.data.sha });
    }
    for (const path of existing.keys()) if (!files?.has(path)) tree.push({ path: `${folder}/${path}`, mode: "100644", type: "blob", sha: null });
    if (tree.length === 0) return "unchanged";
    let baseTree: string | undefined;
    if (head) baseTree = (await client.request<{ tree: { sha: string } }>("GET", client.repoPath(`/git/commits/${head}`))).data.tree.sha;
    const newTree = await client.request<{ sha: string }>("POST", client.repoPath("/git/trees"), { body: { ...(baseTree ? { base_tree: baseTree } : {}), tree: head ? tree : tree.filter((t) => t.sha) } });
    const commit = await client.request<{ sha: string }>("POST", client.repoPath("/git/commits"), { body: { message, tree: newTree.data.sha, parents: head ? [head] : [] } });
    if (!head) {
      const created = await client.request("POST", client.repoPath("/git/refs"), { body: { ref: `refs/heads/${SITE_BRANCH}`, sha: commit.data.sha }, allow: [422] });
      if (created.status !== 422) return "created-branch";
      if (!(await branchHead(client, SITE_BRANCH))) throw ruleError("creating the branch", created.data);
    } else {
      const moved = await client.request("PATCH", client.repoPath(`/git/refs/heads/${encodePath(SITE_BRANCH)}`), { body: { sha: commit.data.sha, force: false }, allow: [422] });
      if (moved.status !== 422) return files ? "written" : "removed";
      if (/rule violation/i.test(String((moved.data as { message?: string }).message ?? ""))) throw ruleError("writing", moved.data);
    }
    await sleep(100 + Math.random() * 900); // another run moved meta/site; rebuild on the new head
  }
  throw new GitHubError(409, `could not write ${SITE_BRANCH}/${folder} after several attempts`, "Run the site workflow again.", `PATCH ${SITE_BRANCH}`);
}

function ruleError(op: string, data: unknown): GitHubError {
  const message = String((data as { message?: string } | undefined)?.message ?? "").split("\n")[0];
  return new GitHubError(409, `${op} ${SITE_BRANCH} was rejected: ${message}`, `Only the bot may write ${SITE_BRANCH}. Run the site workflow with the bot token.`, `PATCH ${SITE_BRANCH}`);
}

/** Publishes a rendered folder, but only while its commit is still the head of its ref. */
export async function publishSite(client: GitHubClient, manifest: SiteManifest, files: Map<string, string>, o: SitePublishOptions = {}): Promise<{ folder: string; outcome: SitePublishOutcome }> {
  if (!SITE_REF_RE.test(manifest.ref)) throw new GitHubError(400, `\`${manifest.ref}\` is not a site ref`, "Only main, release/vX.Y.Z and vX.Y.Z tags are rendered.", "site publish");
  const folder = folderName(manifest.ref);
  const head = await refHead(client, manifest.ref, manifest.kind);
  if (!head) {
    await removeSite(client, manifest.ref, o);
    return { folder, outcome: "skipped-deleted" };
  }
  if (head !== manifest.sourceSha) return { folder, outcome: "skipped-superseded" };
  const outcome = await writeFolder(client, folder, files, `Site ${manifest.ref} at ${manifest.sourceSha.slice(0, 7)}`, o);
  // The branch may have been deleted while we wrote; its remove run may already be done.
  if (manifest.kind === "branch" && !(await refHead(client, manifest.ref, "branch"))) {
    await removeSite(client, manifest.ref, o);
    return { folder, outcome: "skipped-deleted" };
  }
  return { folder, outcome };
}

/** Removes the folder of a deleted branch. */
export async function removeSite(client: GitHubClient, ref: string, o: SitePublishOptions = {}): Promise<SitePublishOutcome> {
  const folder = folderName(ref);
  if (!FOLDER_RE.test(folder)) return "absent";
  return writeFolder(client, folder, undefined, `Remove site of deleted ${ref}`, o);
}
