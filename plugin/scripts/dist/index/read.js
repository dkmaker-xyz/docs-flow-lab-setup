import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodePath } from "../github/index.js";
import { INDEX_BRANCH, indexFileName } from "./model.js";
/** User cache folder: $XDG_CACHE_HOME, %LOCALAPPDATA% on Windows, ~/Library/Caches on macOS, else ~/.cache. */
export function cacheDir(env = process.env, platform = process.platform) {
    if (env.IDC365_DECISIONS_CACHE)
        return env.IDC365_DECISIONS_CACHE;
    if (env.XDG_CACHE_HOME)
        return join(env.XDG_CACHE_HOME, "idc365-decisions");
    if (platform === "win32" && env.LOCALAPPDATA)
        return join(env.LOCALAPPDATA, "idc365-decisions");
    if (platform === "darwin")
        return join(homedir(), "Library", "Caches", "idc365-decisions");
    return join(homedir(), ".cache", "idc365-decisions");
}
function cachePath(dir, client, ref) {
    return join(dir, "index", client.owner, client.repo, indexFileName(ref));
}
/**
 * Reads the index for a ref from meta/index with the cached ETag
 * (`If-None-Match`, 304 is free against the rate limit), then compares its
 * sourceSha with the branch head (40-byte request), spec 6.2.
 */
export async function fetchIndex(client, ref, dir = cacheDir()) {
    const file = cachePath(dir, client, ref);
    let cached;
    try {
        cached = JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        cached = undefined;
    }
    const res = await client.request("GET", client.repoPath(`/contents/${encodePath(indexFileName(ref))}`), {
        query: { ref: INDEX_BRANCH },
        accept: "application/vnd.github.raw+json",
        headers: cached ? { "If-None-Match": cached.etag } : {},
        allow: [304, 404],
    });
    let index;
    let status;
    if (res.status === 404) {
        status = 404;
    }
    else if (res.status === 304 && cached) {
        status = 304;
        index = cached.index;
    }
    else {
        status = 200;
        index = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        const etag = res.headers.get("etag");
        if (etag) {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify({ etag, index }));
        }
    }
    const head = await client.request("GET", client.repoPath(`/commits/${encodePath(ref)}`), { accept: "application/vnd.github.sha", allow: [404, 422] });
    const headSha = head.status === 200 && typeof head.data === "string" ? head.data.trim() : undefined;
    return { index, status, head: headSha, stale: !!index && !!headSha && index.sourceSha !== headSha };
}
