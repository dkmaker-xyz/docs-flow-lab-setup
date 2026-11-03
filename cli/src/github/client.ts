import { GitHubError, nextActionFor, parseRateLimit, type RateLimit } from "./errors.js";

export const GITHUB_API = "https://api.github.com";
export const API_VERSION = "2026-03-10";

export interface ClientOptions {
  /** Token for the `Authorization: Bearer` header. */
  token: string;
  /** Documentation repository as `owner/repo`. */
  repository: string;
  baseUrl?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  userAgent?: string;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Statuses that are returned instead of thrown (for example 404 when "missing" is a normal answer). */
  allow?: number[];
  accept?: string;
  /** Extra request headers, for example If-None-Match. */
  headers?: Record<string, string>;
}

export interface Response<T> {
  status: number;
  data: T;
  headers: Headers;
}

/**
 * Minimal GitHub REST client on the built-in fetch. It retries only a GET
 * once after a transport failure; HTTP errors are never retried here:
 * callers retry where the spec requires it (ID allocation on 409).
 */
export class GitHubClient {
  readonly owner: string;
  readonly repo: string;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  /** Rate limit from the most recent response. */
  rateLimit: RateLimit | undefined;

  constructor(opts: ClientOptions) {
    const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(opts.repository);
    if (!m) throw new Error(`repository must be owner/repo, got "${opts.repository}"`);
    this.owner = m[1]!;
    this.repo = m[2]!;
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? GITHUB_API).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.userAgent = opts.userAgent ?? "idc365-decisions-cli";
  }

  /** Authorization for the Git LFS API (basic, as git uses it). */
  lfsAuthorization(): string {
    return `Basic ${Buffer.from(`x-access-token:${this.token}`).toString("base64")}`;
  }

  /** The fetch in use, for requests outside the REST API (Git LFS, object storage). */
  get fetcher(): typeof fetch {
    return this.fetchImpl;
  }

  get repository(): string {
    return `${this.owner}/${this.repo}`;
  }

  /** `/repos/{owner}/{repo}` + suffix. */
  repoPath(suffix: string): string {
    return `/repos/${this.owner}/${this.repo}${suffix}`;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<Response<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: opts.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": this.userAgent,
      ...opts.headers,
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const label = `${method} ${path}`;
    let res: globalThis.Response;
    try {
      try {
        res = await this.fetchImpl(url, { method, headers, body });
      } catch (first) {
        // A GET is retried once on a transport failure (for example a stale
        // keep-alive socket, UND_ERR_SOCKET). Writes are never retried.
        if (method !== "GET") throw first;
        res = await this.fetchImpl(url, { method, headers, body });
      }
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause ? ` (${cause.code ?? cause.message ?? "unknown cause"})` : "";
      throw new GitHubError(0, `could not reach GitHub: ${(err as Error).message}${detail}`, "Check the network connection and run the command again.", label);
    }
    this.rateLimit = parseRateLimit(res.headers) ?? this.rateLimit;
    const text = await res.text();
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    let data: unknown = text;
    if (isJson && text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (res.ok || opts.allow?.includes(res.status)) return { status: res.status, data: data as T, headers: res.headers };

    const payload = (typeof data === "object" && data !== null ? data : {}) as { message?: string; errors?: unknown[] };
    const message = payload.message ?? (text || res.statusText || `HTTP ${res.status}`);
    const details = (payload.errors ?? []).map((e) => (typeof e === "string" ? e : typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : JSON.stringify(e)));
    throw new GitHubError(
      res.status,
      `${label} failed with ${res.status}: ${message.split("\n")[0]}`,
      nextActionFor(res.status, `${message} ${details.join(" ")}`, this.rateLimit, res.headers.get("retry-after")),
      label,
      [...message.split("\n").slice(1).map((s) => s.trim()).filter(Boolean), ...details],
    );
  }
}

/** Encodes a repository path for a URL, keeping the slashes. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
