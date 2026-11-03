import { encodePath, type GitHubClient } from "./client.js";
import { GitHubError } from "./errors.js";

export interface FileContent {
  path: string;
  /** Blob SHA of the file at that ref. */
  sha: string;
  size: number;
  content: Buffer;
  text(): string;
}

export interface FolderEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  sha: string;
  size: number;
}

interface ContentsFile {
  type: string;
  path: string;
  sha: string;
  size: number;
  encoding?: string;
  content?: string;
}

/** Reads a file at a ref (branch, tag or commit). Returns undefined when it does not exist. */
export async function readFile(client: GitHubClient, path: string, ref: string): Promise<FileContent | undefined> {
  const res = await client.request<ContentsFile | ContentsFile[]>("GET", client.repoPath(`/contents/${encodePath(path)}`), { query: { ref }, allow: [404] });
  if (res.status === 404) return undefined;
  if (Array.isArray(res.data) || res.data.type !== "file") {
    throw new GitHubError(400, `${path} at ${ref} is not a file`, "Use listFolder for folders.", `GET contents/${path}`);
  }
  const file = res.data;
  let content: Buffer;
  if (file.encoding === "base64" && file.content !== undefined) {
    content = Buffer.from(file.content, "base64");
  } else {
    // Files over 1 MB come without content; read the blob instead.
    const blob = await client.request<{ content: string; encoding: string }>("GET", client.repoPath(`/git/blobs/${file.sha}`));
    content = Buffer.from(blob.data.content, blob.data.encoding === "base64" ? "base64" : "utf8");
  }
  return { path: file.path, sha: file.sha, size: file.size, content, text: () => content.toString("utf8") };
}

/** Lists a folder at a ref. Returns undefined when it does not exist. GitHub returns at most 1,000 entries. */
export async function listFolder(client: GitHubClient, path: string, ref: string): Promise<FolderEntry[] | undefined> {
  const suffix = path === "" || path === "." ? "/contents" : `/contents/${encodePath(path.replace(/\/$/, ""))}`;
  const res = await client.request<ContentsFile | FolderEntry[]>("GET", client.repoPath(suffix), { query: { ref }, allow: [404] });
  if (res.status === 404) return undefined;
  if (!Array.isArray(res.data)) {
    throw new GitHubError(400, `${path} at ${ref} is a file, not a folder`, "Use readFile for files.", `GET contents/${path}`);
  }
  return res.data.map((e) => ({ name: e.name, path: e.path, type: e.type, sha: e.sha, size: e.size }));
}
