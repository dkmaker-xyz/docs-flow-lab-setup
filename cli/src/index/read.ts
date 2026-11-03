import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodePath, type GitHubClient } from "../github/index.js";
import { INDEX_BRANCH, indexFileName, type BranchIndex } from "./model.js";

/** User cache folder: $XDG_CACHE_HOME, %LOCALAPPDATA% on Windows, ~/Library/Caches on macOS, else ~/.cache. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.IDC365_DECISIONS_CACHE) return env.IDC365_DECISIONS_CACHE;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "idc365-decisions");
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "idc365-decisions");
  if (platform === "darwin") return join(homedir(), "Library", "Caches", "idc365-decisions");
  return join(homedir(), ".cache", "idc365-decisions");
}

interface CacheEntry {
  etag: string;
  index: BranchIndex;
}

export interface FetchedIndex {
  /** undefined when there is no index for the ref. */
  index?: BranchIndex;
  /** HTTP status of the conditional request: 200 downloaded, 304 cache was current, 404 none. */
  status: 200 | 304 | 404;
  /** Branch head, when the ref is a branch. */
  head?: string;
  /** True when the index was built from an older commit than the head. */
  stale: boolean;
}

function cachePath(dir: string, client: GitHubClient, ref: string): string {
  return join(dir, "index", client.owner, client.repo, indexFileName(ref));
}

/**
 * Reads the index for a ref from meta/index with the cached ETag
 * (`If-None-Match`, 304 is free against the rate limit), then compares its
 * sourceSha with the branch head (40-byte request), spec 6.2.
 */
export async function fetchIndex(client: GitHubClient, ref: string, dir = cacheDir()): Promise<FetchedIndex> {
  const file = cachePath(dir, client, ref);
  let cached: CacheEntry | undefined;
  try {
    cached = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
  } catch {
    cached = undefined;
  }
  const res = await client.request<BranchIndex>("GET", client.repoPath(`/contents/${encodePath(indexFileName(ref))}`), {
    query: { ref: INDEX_BRANCH },
    accept: "application/vnd.github.raw+json",
    headers: cached ? { "If-None-Match": cached.etag } : {},
    allow: [304, 404],
  });
  let index: BranchIndex | undefined;
  let status: FetchedIndex["status"];
  if (res.status === 404) {
    status = 404;
  } else if (res.status === 304 && cached) {
    status = 304;
    index = cached.index;
  } else {
    status = 200;
    index = typeof res.data === "string" ? (JSON.parse(res.data) as BranchIndex) : res.data;
    const etag = res.headers.get("etag");
    if (etag) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ etag, index } satisfies CacheEntry));
    }
  }
  const head = await client.request<string>("GET", client.repoPath(`/commits/${encodePath(ref)}`), { accept: "application/vnd.github.sha", allow: [404, 422] });
  const headSha = head.status === 200 && typeof head.data === "string" ? head.data.trim() : undefined;
  return { index, status, head: headSha, stale: !!index && !!headSha && index.sourceSha !== headSha };
}
