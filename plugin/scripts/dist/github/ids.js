import { GitHubError } from "./errors.js";
export const IDS_BRANCH = "meta/ids";
export const COUNTERS_FILE = "counters.json";
export const ID_PREFIXES = ["ADR", "PROC", "TECH", "REL", "ATT"];
export function formatId(prefix, n) {
    return `${prefix}-${String(n).padStart(4, "0")}`;
}
function encodeCounters(c) {
    return Buffer.from(JSON.stringify(c, null, 2) + "\n", "utf8").toString("base64");
}
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Creates `meta/ids` as an orphan branch holding counters.json with every
 * counter at 0. Returns false when another client created it first.
 */
export async function createIdsBranch(client) {
    const counters = Object.fromEntries(ID_PREFIXES.map((p) => [p, 0]));
    const blob = await client.request("POST", client.repoPath("/git/blobs"), { body: { content: encodeCounters(counters), encoding: "base64" } });
    const tree = await client.request("POST", client.repoPath("/git/trees"), {
        body: { tree: [{ path: COUNTERS_FILE, mode: "100644", type: "blob", sha: blob.data.sha }] },
    });
    const commit = await client.request("POST", client.repoPath("/git/commits"), {
        body: { message: "Create ID counters", tree: tree.data.sha, parents: [] },
    });
    const ref = await client.request("POST", client.repoPath("/git/refs"), { body: { ref: `refs/heads/${IDS_BRANCH}`, sha: commit.data.sha }, allow: [422] });
    return ref.status !== 422; // 422: "Reference already exists"
}
/**
 * Allocates `count` consecutive IDs of one type (spec 6.1): read counters.json
 * on meta/ids, write it back with the blob sha; 409 means another client won,
 * so read again and retry.
 */
export async function allocateIds(client, prefix, count = 1, opts = {}) {
    if (!Number.isInteger(count) || count < 1)
        throw new Error("count must be a positive integer");
    const maxAttempts = opts.maxAttempts ?? 30;
    const [minWait, maxWait] = opts.backoffMs ?? [50, 500];
    const sleep = opts.sleep ?? sleepReal;
    const path = client.repoPath(`/contents/${COUNTERS_FILE}`);
    let retries = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await client.request("GET", path, { query: { ref: IDS_BRANCH }, allow: [404] });
        if (res.status === 404) {
            await createIdsBranch(client);
            continue;
        }
        const counters = JSON.parse(Buffer.from(res.data.content, "base64").toString("utf8"));
        const current = counters[prefix] ?? 0;
        const numbers = Array.from({ length: count }, (_, i) => current + 1 + i);
        counters[prefix] = current + count;
        const ids = numbers.map((n) => formatId(prefix, n));
        const put = await client.request("PUT", path, {
            body: {
                message: `Allocate ${ids.length === 1 ? ids[0] : `${ids[0]}..${ids[ids.length - 1]}`}`,
                content: encodeCounters(counters),
                sha: res.data.sha,
                branch: IDS_BRANCH,
            },
            allow: [409],
        });
        if (put.status !== 409)
            return { ids, numbers, retries };
        // A ruleset rejection also answers 409 on the Contents API; that is not a race.
        const message = put.data?.message ?? "";
        if (/rule violation/i.test(message)) {
            throw new GitHubError(409, `writing ${COUNTERS_FILE} on ${IDS_BRANCH} was rejected: ${message.split("\n")[0]}`, "The repository's rules block ID allocation on meta/ids. Ask a repository owner to allow updates to meta/ids.", `PUT contents/${COUNTERS_FILE}`);
        }
        retries++;
        await sleep(minWait + Math.random() * (maxWait - minWait));
    }
    throw new GitHubError(409, `could not allocate a ${prefix} ID after ${maxAttempts} attempts`, "Many clients are allocating at once. Run the command again.", `PUT contents/${COUNTERS_FILE}`);
}
