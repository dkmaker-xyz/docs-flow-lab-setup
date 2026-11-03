import { GitHubError, nextActionFor, parseRateLimit } from "./errors.js";
export const GITHUB_API = "https://api.github.com";
export const API_VERSION = "2026-03-10";
/**
 * Minimal GitHub REST client on the built-in fetch. It retries only a GET
 * once after a transport failure; HTTP errors are never retried here:
 * callers retry where the spec requires it (ID allocation on 409).
 */
export class GitHubClient {
    owner;
    repo;
    token;
    baseUrl;
    fetchImpl;
    userAgent;
    /** Rate limit from the most recent response. */
    rateLimit;
    constructor(opts) {
        const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(opts.repository);
        if (!m)
            throw new Error(`repository must be owner/repo, got "${opts.repository}"`);
        this.owner = m[1];
        this.repo = m[2];
        this.token = opts.token;
        this.baseUrl = (opts.baseUrl ?? GITHUB_API).replace(/\/$/, "");
        this.fetchImpl = opts.fetch ?? fetch;
        this.userAgent = opts.userAgent ?? "idc365-decisions-cli";
    }
    /** Authorization for the Git LFS API (basic, as git uses it). */
    lfsAuthorization() {
        return `Basic ${Buffer.from(`x-access-token:${this.token}`).toString("base64")}`;
    }
    /** The fetch in use, for requests outside the REST API (Git LFS, object storage). */
    get fetcher() {
        return this.fetchImpl;
    }
    get repository() {
        return `${this.owner}/${this.repo}`;
    }
    /** `/repos/{owner}/{repo}` + suffix. */
    repoPath(suffix) {
        return `/repos/${this.owner}/${this.repo}${suffix}`;
    }
    async request(method, path, opts = {}) {
        const url = new URL(this.baseUrl + path);
        for (const [k, v] of Object.entries(opts.query ?? {}))
            if (v !== undefined)
                url.searchParams.set(k, String(v));
        const headers = {
            Authorization: `Bearer ${this.token}`,
            Accept: opts.accept ?? "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": this.userAgent,
            ...opts.headers,
        };
        let body;
        if (opts.body !== undefined) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(opts.body);
        }
        const label = `${method} ${path}`;
        let res;
        try {
            try {
                res = await this.fetchImpl(url, { method, headers, body });
            }
            catch (first) {
                // A GET is retried once on a transport failure (for example a stale
                // keep-alive socket, UND_ERR_SOCKET). Writes are never retried.
                if (method !== "GET")
                    throw first;
                res = await this.fetchImpl(url, { method, headers, body });
            }
        }
        catch (err) {
            const cause = err.cause;
            const detail = cause ? ` (${cause.code ?? cause.message ?? "unknown cause"})` : "";
            throw new GitHubError(0, `could not reach GitHub: ${err.message}${detail}`, "Check the network connection and run the command again.", label);
        }
        this.rateLimit = parseRateLimit(res.headers) ?? this.rateLimit;
        const text = await res.text();
        const isJson = (res.headers.get("content-type") ?? "").includes("json");
        let data = text;
        if (isJson && text !== "") {
            try {
                data = JSON.parse(text);
            }
            catch {
                data = text;
            }
        }
        if (res.ok || opts.allow?.includes(res.status))
            return { status: res.status, data: data, headers: res.headers };
        const payload = (typeof data === "object" && data !== null ? data : {});
        const message = payload.message ?? (text || res.statusText || `HTTP ${res.status}`);
        const details = (payload.errors ?? []).map((e) => (typeof e === "string" ? e : typeof e === "object" && e !== null && "message" in e ? String(e.message) : JSON.stringify(e)));
        throw new GitHubError(res.status, `${label} failed with ${res.status}: ${message.split("\n")[0]}`, nextActionFor(res.status, `${message} ${details.join(" ")}`, this.rateLimit, res.headers.get("retry-after")), label, [...message.split("\n").slice(1).map((s) => s.trim()).filter(Boolean), ...details]);
    }
}
/** Encodes a repository path for a URL, keeping the slashes. */
export function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
}
