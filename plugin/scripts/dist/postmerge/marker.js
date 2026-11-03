import { execFileSync } from "node:child_process";
import { encodePath } from "../github/index.js";
import { INDEX_BRANCH } from "../index/model.js";
/**
 * The last commit of a truth branch that post-merge handled completely
 * (phase 11 fix). GitHub keeps only one pending run per concurrency group, so
 * a queued post-merge run can be cancelled by a newer one; the newer run then
 * handles everything since this marker instead of only its own push.
 *
 * Stored as `post-merge/<branch>.json` on meta/index, which only the bot may
 * write (ruleset "meta-index"); index files live at the root as
 * `<branch>.json`, so the folder never collides with them.
 */
export function markerPath(branch) {
    return `post-merge/${branch.replace(/\//g, "__")}.json`;
}
export async function readMarker(client, branch) {
    const res = await client.request("GET", client.repoPath(`/contents/${encodePath(markerPath(branch))}`), { query: { ref: INDEX_BRANCH }, allow: [404] });
    if (res.status === 404)
        return {};
    try {
        const m = JSON.parse(Buffer.from(res.data.content, "base64").toString("utf8"));
        return /^[0-9a-f]{40}$/.test(m.sha) ? { marker: m, blob: res.data.sha } : { blob: res.data.sha };
    }
    catch {
        return { blob: res.data.sha };
    }
}
/** True when `ancestor` is reachable from `commit` in the checkout. */
export function isAncestor(root, ancestor, commit) {
    try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, commit], { cwd: root, stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The base for this run: the marker when it is an ancestor of `after` (the
 * normal case), otherwise the push event's `before`.
 */
export function chooseBase(root, marker, eventBefore, after) {
    if (marker && marker.sha !== after && isAncestor(root, marker.sha, after))
        return { before: marker.sha, from: "marker" };
    if (marker && marker.sha === after)
        return { before: after, from: "marker" };
    return eventBefore ? { before: eventBefore, from: "event" } : { from: "none" };
}
/**
 * Records `after` as handled, but never moves the marker backwards (a
 * re-run of an old run leaves a newer marker alone). Compare-and-swap on the
 * file's blob sha; retried when another write won.
 */
export async function writeMarker(client, root, branch, after, now = new Date()) {
    const path = markerPath(branch);
    for (let attempt = 1; attempt <= 10; attempt++) {
        const { marker, blob } = await readMarker(client, branch);
        if (marker && (marker.sha === after || isAncestor(root, after, marker.sha)))
            return "kept";
        const body = { sha: after, at: now.toISOString() };
        const put = await client.request("PUT", client.repoPath(`/contents/${encodePath(path)}`), {
            body: { message: `Post-merge ${branch} handled up to ${after.slice(0, 7)}`, content: Buffer.from(JSON.stringify(body) + "\n").toString("base64"), branch: INDEX_BRANCH, ...(blob ? { sha: blob } : {}) },
            allow: [409, 422],
        });
        if (put.status === 200 || put.status === 201)
            return "written";
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 800));
    }
    throw new Error(`could not write ${path} on ${INDEX_BRANCH}`);
}
