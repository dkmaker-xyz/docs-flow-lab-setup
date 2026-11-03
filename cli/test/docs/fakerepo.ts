/**
 * An in-memory GitHub repository behind the fetch mock: enough of the Git
 * Data, Contents, refs and pulls APIs for the document commands.
 */
import { createHash as createHashForBlobs } from "node:crypto";
import { createHash } from "node:crypto";
import { GitHubClient } from "../../src/github/index.js";
import { MockGitHub, R, REPO, type Call, type Reply } from "../github/mock.js";

interface CommitObj {
  tree: Map<string, string>; // path -> blob sha
  parents: string[];
  message: string;
}

export interface Pull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
}

const sha = (data: string | Buffer) => createHash("sha1").update(data).digest("hex");

export class FakeRepo {
  readonly mock = new MockGitHub();
  readonly blobs = new Map<string, Buffer>();
  readonly commits = new Map<string, CommitObj>();
  readonly refs = new Map<string, string>(); // "heads/main" -> sha
  readonly pulls: Pull[] = [];
  /** Statuses of raw (index) reads, to check conditional requests. */
  readonly rawReads: number[] = [];
  private seq = 0;

  constructor() {
    this.routes();
  }

  client(): GitHubClient {
    return new GitHubClient({ token: "t", repository: REPO, fetch: this.mock.fetch });
  }

  private blob(content: Buffer): string {
    const s = sha(content);
    this.blobs.set(s, content);
    return s;
  }

  private commit(tree: Map<string, string>, parents: string[], message: string): string {
    const s = sha(`${++this.seq}:${message}`);
    this.commits.set(s, { tree, parents, message });
    return s;
  }

  /** Commits `files` on `branch` (creating it, from `from` or empty). */
  seed(branch: string, files: Record<string, string>, from?: string): string {
    const parent = this.refs.get(`heads/${branch}`) ?? (from ? this.refs.get(`heads/${from}`) : undefined);
    const tree = new Map(parent ? this.commits.get(parent)!.tree : []);
    for (const [p, text] of Object.entries(files)) tree.set(p, this.blob(Buffer.from(text)));
    const c = this.commit(tree, parent ? [parent] : [], `seed ${branch}`);
    this.refs.set(`heads/${branch}`, c);
    return c;
  }

  tag(name: string, branch = "main"): void {
    this.refs.set(`tags/${name}`, this.refs.get(`heads/${branch}`)!);
  }

  /** Files of a branch (or tag) head. */
  files(ref: string): Map<string, string> {
    const c = this.resolveRef(ref);
    const out = new Map<string, string>();
    if (!c) return out;
    for (const [p, b] of this.commits.get(c)!.tree) out.set(p, this.blobs.get(b)!.toString("utf8"));
    return out;
  }

  head(branch: string): CommitObj | undefined {
    const c = this.refs.get(`heads/${branch}`);
    return c ? this.commits.get(c) : undefined;
  }

  counters(): Record<string, number> {
    const text = this.files("meta/ids").get("counters.json");
    return text ? (JSON.parse(text) as Record<string, number>) : {};
  }

  private resolveRef(ref: string): string | undefined {
    return this.refs.get(`heads/${ref}`) ?? this.refs.get(`tags/${ref}`) ?? (this.commits.has(ref) ? ref : undefined);
  }

  private routes(): void {
    const m = this.mock;
    const nf = { status: 404, body: { message: "Not Found" } };
    m.on("GET", /\/git\/ref\/(heads|tags)\/.+$/, (c) => {
      const ref = c.path.replace(`${R}/git/ref/`, "");
      const s = this.refs.get(ref);
      return s ? { body: { ref: `refs/${ref}`, object: { sha: s } } } : nf;
    });
    m.on("GET", /\/git\/matching-refs\/tags\/v$/, () => ({
      body: [...this.refs.keys()].filter((k) => k.startsWith("tags/v")).map((k) => ({ ref: `refs/${k}`, object: { sha: this.refs.get(k) } })),
    }));
    m.on("POST", `${R}/git/refs`, (c) => {
      const { ref, sha: s } = c.body as { ref: string; sha: string };
      const key = ref.replace(/^refs\//, "");
      if (this.refs.has(key)) return { status: 422, body: { message: "Reference already exists" } };
      this.refs.set(key, s);
      return { status: 201, body: { ref } };
    });
    m.on("PATCH", /\/git\/refs\/heads\/.+$/, (c) => {
      const key = c.path.replace(`${R}/git/refs/`, "");
      if (!this.refs.has(key)) return { status: 422, body: { message: "Reference does not exist" } };
      this.refs.set(key, (c.body as { sha: string }).sha);
      return { body: {} };
    });
    m.on("DELETE", /\/git\/refs\/heads\/.+$/, (c) => {
      const key = c.path.replace(`${R}/git/refs/`, "");
      if (!this.refs.has(key)) return { status: 422, body: { message: "Reference does not exist" } };
      this.refs.delete(key);
      return { status: 204 };
    });
    m.on("GET", /\/git\/commits\/[0-9a-f]+$/, (c) => {
      const s = c.path.split("/").pop()!;
      const obj = this.commits.get(s);
      return obj ? { body: { sha: s, tree: { sha: `tree:${s}` }, parents: obj.parents.map((p) => ({ sha: p })) } } : nf;
    });
    m.on("POST", `${R}/git/blobs`, (c) => {
      const { content, encoding } = c.body as { content: string; encoding: string };
      return { status: 201, body: { sha: this.blob(Buffer.from(content, encoding === "base64" ? "base64" : "utf8")) } };
    });
    const trees = new Map<string, Map<string, string>>();
    m.on("POST", `${R}/git/trees`, (c) => {
      const { base_tree, tree } = c.body as { base_tree?: string; tree: { path: string; sha: string | null }[] };
      const base = base_tree?.startsWith("tree:") ? this.commits.get(base_tree.slice(5))!.tree : new Map<string, string>();
      const next = new Map(base);
      for (const e of tree) {
        if (e.sha === null) next.delete(e.path);
        else next.set(e.path, e.sha);
      }
      const id = `newtree:${trees.size}`;
      trees.set(id, next);
      return { status: 201, body: { sha: id } };
    });
    m.on("POST", `${R}/git/commits`, (c) => {
      const { message, tree, parents } = c.body as { message: string; tree: string; parents: string[] };
      return { status: 201, body: { sha: this.commit(trees.get(tree)!, parents, message) } };
    });
    // Recursive tree listing of a commit's tree ("tree:<commit>"), with git blob ids like GitHub's.
    m.on("GET", /\/git\/trees\/tree:[0-9a-f]+$/, (c) => {
      const commit = this.commits.get(c.path.split("tree:").pop()!);
      if (!commit) return nf;
      return { body: { tree: [...commit.tree].map(([path, b]) => ({ path, type: "blob", sha: gitBlobSha(this.blobs.get(b)!) })), truncated: false } };
    });
    m.on("GET", /\/git\/blobs\/[0-9a-f]+$/, (c) => ({ body: { content: this.blobs.get(c.path.split("/").pop()!)!.toString("base64"), encoding: "base64" } }));
    m.on("GET", /\/contents(\/.*)?$/, (c) => this.getContents(c));
    m.on("GET", /^\/repos\/[^/]+\/[^/]+\/commits\/.+$/, (c) => {
      if (/\/pulls$/.test(c.path)) return { body: [] };
      const ref = c.path.replace(`${R}/commits/`, "");
      const s = this.resolveRef(ref);
      if (!s) return { status: 422, body: { message: `No commit found for SHA: ${ref}` } };
      return c.headers.accept?.includes("sha") ? { raw: s, headers: { "content-type": "application/vnd.github.sha; charset=utf-8" } } : { body: { sha: s } };
    });
    m.on("PUT", /\/contents\/.+$/, (c) => this.putContents(c));
    m.on("DELETE", /\/contents\/.+$/, (c) => this.deleteContents(c));
    m.on("POST", `${R}/pulls`, (c) => {
      const b = c.body as { head: string; base: string; title: string; body: string };
      const pr: Pull = { number: this.pulls.length + 1, ...b, state: "open" };
      this.pulls.push(pr);
      return { status: 201, body: { number: pr.number, html_url: `https://github.com/${REPO}/pull/${pr.number}` } };
    });
    m.on("GET", `${R}/pulls`, (c) => {
      const head = c.query.get("head")?.split(":")[1];
      const state = c.query.get("state");
      return { body: this.pulls.filter((p) => (!head || p.head === head) && (!state || p.state === state)).map((p) => ({ number: p.number, html_url: `https://github.com/${REPO}/pull/${p.number}`, body: p.body })) };
    });
    m.on("PATCH", /\/pulls\/[0-9]+$/, (c) => {
      const pr = this.pulls[Number(c.path.split("/").pop()) - 1]!;
      Object.assign(pr, c.body as Partial<Pull>);
      return { body: {} };
    });
  }

  private getContents(c: Call): Reply {
    const path = c.path.replace(`${R}/contents`, "").replace(/^\//, "");
    const ref = c.query.get("ref") ?? "main";
    const commit = this.resolveRef(ref);
    if (!commit) return { status: 404, body: { message: "No commit found for the ref" } };
    const tree = this.commits.get(commit)!.tree;
    const blob = tree.get(path);
    if (blob && c.headers.accept?.includes("raw")) {
      const etag = `"${blob}"`;
      this.rawReads.push(c.headers["if-none-match"] === etag ? 304 : 200);
      if (c.headers["if-none-match"] === etag) return { status: 304, headers: { etag } };
      return { raw: this.blobs.get(blob)!.toString("utf8"), headers: { etag, "content-type": "application/vnd.github.raw+json; charset=utf-8" } };
    }
    if (blob) {
      const data = this.blobs.get(blob)!;
      return { body: { type: "file", path, sha: blob, size: data.length, encoding: "base64", content: data.toString("base64") } };
    }
    const prefix = path ? `${path}/` : "";
    const children = new Map<string, { type: string; sha: string; size: number }>();
    for (const [p, b] of tree) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const [name, ...more] = rest.split("/");
      if (more.length) children.set(name!, { type: "dir", sha: "d", size: 0 });
      else children.set(name!, { type: "file", sha: b, size: this.blobs.get(b)!.length });
    }
    if (!children.size) return { status: 404, body: { message: "Not Found" } };
    return { body: [...children].map(([name, e]) => ({ name, path: `${prefix}${name}`, ...e })) };
  }

  private deleteContents(c: Call) {
    const path = c.path.replace(`${R}/contents/`, "");
    const { sha: expected, branch, message } = c.body as { sha: string; branch: string; message: string };
    const head = this.refs.get(`heads/${branch}`);
    if (!head) return { status: 404, body: { message: "Branch not found" } };
    const tree = new Map(this.commits.get(head)!.tree);
    if (!tree.has(path)) return { status: 404, body: { message: "Not Found" } };
    if (tree.get(path) !== expected) return { status: 409, body: { message: `${path} does not match ${expected}` } };
    tree.delete(path);
    this.refs.set(`heads/${branch}`, this.commit(tree, [head], message));
    return { body: { commit: {} } };
  }

  private putContents(c: Call) {
    const path = c.path.replace(`${R}/contents/`, "");
    const { content, sha: expected, branch, message } = c.body as { content: string; sha?: string; branch: string; message: string };
    const head = this.refs.get(`heads/${branch}`);
    if (!head) return { status: 404, body: { message: "Branch not found" } };
    const tree = new Map(this.commits.get(head)!.tree);
    if (tree.get(path) !== expected) return { status: 409, body: { message: `${path} does not match ${expected}` } };
    tree.set(path, this.blob(Buffer.from(content, "base64")));
    this.refs.set(`heads/${branch}`, this.commit(tree, [head], message));
    return { body: { content: { sha: tree.get(path) } } };
  }
}

/** Git's blob id (sha1 of "blob <len>\\0" + content). */
export function gitBlobSha(buf: Buffer): string {
  return createHashForBlobs("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}
