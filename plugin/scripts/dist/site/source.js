import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodePath, GitHubError } from "../github/index.js";
import { INDEX_BRANCH, indexFileName } from "../index/model.js";
import { FOLDER_RE, SITE_BRANCH } from "./render.js";
/** Cache file for a request key: a hash, so no path from GitHub ever becomes a file path (Windows-safe). */
export function cacheFile(dir, key) {
    return join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
}
export class SiteSource {
    client;
    dir;
    freshMs;
    now;
    memory = new Map();
    offlineSince;
    constructor(client, dir, freshMs = 30_000, now = Date.now) {
        this.client = client;
        this.dir = dir;
        this.freshMs = freshMs;
        this.now = now;
    }
    read(key) {
        try {
            return JSON.parse(readFileSync(cacheFile(this.dir, key), "utf8"));
        }
        catch {
            return undefined;
        }
    }
    write(key, e) {
        try {
            const file = cacheFile(this.dir, key);
            mkdirSync(dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(e));
            renameSync(tmp, file);
        }
        catch {
            // A cache that cannot be written only costs a download next time.
        }
    }
    /** GET a repository path (contents API) at a ref, raw, with ETag cache and offline fallback. */
    async get(path, ref, raw = true) {
        const key = `${this.client.owner}/${this.client.repo}\0${ref}\0${path}\0${raw}`;
        const mem = this.memory.get(key);
        if (mem && this.now() - mem.at < this.freshMs)
            return mem.value;
        const cached = this.read(key);
        let value;
        try {
            const res = await this.client.request("GET", this.client.repoPath(`/contents${path ? `/${encodePath(path)}` : ""}`), {
                query: { ref },
                accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
                headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
                allow: [304, 404],
            });
            if (res.status === 304 && cached)
                value = { status: cached.status, body: cached.body };
            else {
                const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? "");
                const etag = res.headers.get("etag") ?? undefined;
                this.write(key, { status: res.status, etag, body, at: new Date(this.now()).toISOString() });
                value = { status: res.status, body };
            }
            this.offlineSince = undefined;
        }
        catch (err) {
            const offline = err instanceof GitHubError && (err.status === 0 || err.status >= 500);
            if (!offline || !cached)
                throw err;
            value = { status: cached.status, body: cached.body, offlineSince: cached.at };
            this.offlineSince = cached.at;
        }
        this.memory.set(key, { at: this.now(), value });
        return value;
    }
    async json(path, ref) {
        const f = await this.get(path, ref);
        if (f.status !== 200)
            return { offlineSince: f.offlineSince };
        return { data: JSON.parse(f.body), offlineSince: f.offlineSince };
    }
    /** Rendered versions: the folders at the root of meta/site. */
    async folders() {
        const f = await this.get("", SITE_BRANCH, false);
        if (f.status !== 200)
            return [];
        const list = JSON.parse(f.body);
        return Array.isArray(list) ? list.filter((e) => e.type === "dir" && FOLDER_RE.test(e.name)).map((e) => e.name) : [];
    }
    manifest(folder) {
        return this.json(`${folder}/site.json`, SITE_BRANCH);
    }
    search(folder) {
        return this.json(`${folder}/search.json`, SITE_BRANCH);
    }
    async page(folder, page) {
        return this.get(`${folder}/${page}`, SITE_BRANCH);
    }
    /** sourceSha of a branch's index on meta/index (for the stale notice). */
    async indexSha(branch) {
        const { data } = await this.json(indexFileName(branch), INDEX_BRANCH);
        return data?.sourceSha;
    }
}
