/** A tiny fetch mock: routes `METHOD /path` to handlers and records every call. */

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw response text instead of JSON. */
  raw?: string;
}

export type Handler = (call: Call) => Reply | Promise<Reply>;

export class MockGitHub {
  readonly calls: Call[] = [];
  private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

  on(method: string, pattern: string | RegExp, handler: Handler | Reply): this {
    const re = typeof pattern === "string" ? new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : pattern;
    this.routes.push({ method, pattern: re, handler: typeof handler === "function" ? handler : () => handler });
    return this;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);
    // Later routes win, so a test can override a default.
    const route = [...this.routes].reverse().find((r) => r.method === call.method && r.pattern.test(call.path));
    const reply: Reply = route ? await route.handler(call) : { status: 599, body: { message: `no mock for ${call.method} ${call.path}` } };
    const status = reply.status ?? 200;
    const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(status === 204 || status === 304 ? null : text, {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...reply.headers },
    });
  }) as typeof fetch;

  callsTo(method: string, path: string | RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path)));
  }
}

export const REPO = "acme/docs";
export const R = `/repos/${REPO}`;
