import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodePath, GitHubError, type GitHubClient } from "../github/index.js";
import { INDEX_BRANCH, indexFileName } from "../index/model.js";
import { FOLDER_RE, SITE_BRANCH, type SearchEntry, type SiteManifest } from "./render.js";

/**
 * Read-only access to meta/site and meta/index for the viewer, through the
 * GitHub API with the user's token. Every file is cached on disk with its
 * ETag (a 304 is free against the rate limit) and kept in memory for a short
 * time; without network the last cached copy is served and marked offline.
 */

interface Entry {
  status: number;
  etag?: string;
  body: string;
  at: string;
}

export interface Fetched {
  status: number;
  body: string;
  /** Set when GitHub could not be reached and this is the cached copy from that time. */
  offlineSince?: string;
}

/** Cache file for a request key: a hash, so no path from GitHub ever becomes a file path (Windows-safe). */
export function cacheFile(dir: string, key: string): string {
  return join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
}

export class SiteSource {
  private readonly memory = new Map<string, { at: number; value: Fetched }>();
  offlineSince: string | undefined;

  constructor(
    private readonly client: GitHubClient,
    private readonly dir: string,
    private readonly freshMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  private read(key: string): Entry | undefined {
    try {
      return JSON.parse(readFileSync(cacheFile(this.dir, key), "utf8")) as Entry;
    } catch {
      return undefined;
    }
  }

  private write(key: string, e: Entry): void {
    try {
      const file = cacheFile(this.dir, key);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(e));
      renameSync(tmp, file);
    } catch {
      // A cache that cannot be written only costs a download next time.
    }
  }

  /** GET a repository path (contents API) at a ref, raw, with ETag cache and offline fallback. */
  async get(path: string, ref: string, raw = true): Promise<Fetched> {
    const key = `${this.client.owner}/${this.client.repo}\0${ref}\0${path}\0${raw}`;
    const mem = this.memory.get(key);
    if (mem && this.now() - mem.at < this.freshMs) return mem.value;
    const cached = this.read(key);
    let value: Fetched;
    try {
      const res = await this.client.request<unknown>("GET", this.client.repoPath(`/contents${path ? `/${encodePath(path)}` : ""}`), {
        query: { ref },
        accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
        allow: [304, 404],
      });
      if (res.status === 304 && cached) value = { status: cached.status, body: cached.body };
      else {
        const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? "");
        const etag = res.headers.get("etag") ?? undefined;
        this.write(key, { status: res.status, etag, body, at: new Date(this.now()).toISOString() });
        value = { status: res.status, body };
      }
      this.offlineSince = undefined;
    } catch (err) {
      const offline = err instanceof GitHubError && (err.status === 0 || err.status >= 500);
      if (!offline || !cached) throw err;
      value = { status: cached.status, body: cached.body, offlineSince: cached.at };
      this.offlineSince = cached.at;
    }
    this.memory.set(key, { at: this.now(), value });
    return value;
  }

  private async json<T>(path: string, ref: string): Promise<{ data?: T; offlineSince?: string }> {
    const f = await this.get(path, ref);
    if (f.status !== 200) return { offlineSince: f.offlineSince };
    return { data: JSON.parse(f.body) as T, offlineSince: f.offlineSince };
  }

  /** Rendered versions: the folders at the root of meta/site. */
  async folders(): Promise<string[]> {
    const f = await this.get("", SITE_BRANCH, false);
    if (f.status !== 200) return [];
    const list = JSON.parse(f.body) as { name: string; type: string }[];
    return Array.isArray(list) ? list.filter((e) => e.type === "dir" && FOLDER_RE.test(e.name)).map((e) => e.name) : [];
  }

  manifest(folder: string) {
    return this.json<SiteManifest>(`${folder}/site.json`, SITE_BRANCH);
  }

  search(folder: string) {
    return this.json<SearchEntry[]>(`${folder}/search.json`, SITE_BRANCH);
  }

  async page(folder: string, page: string): Promise<Fetched> {
    return this.get(`${folder}/${page}`, SITE_BRANCH);
  }

  /** sourceSha of a branch's index on meta/index (for the stale notice). */
  async indexSha(branch: string): Promise<string | undefined> {
    const { data } = await this.json<{ sourceSha?: string }>(indexFileName(branch), INDEX_BRANCH);
    return data?.sourceSha;
  }
}
