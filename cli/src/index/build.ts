import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPath, INVERSE_OF, isRecord, loadConfig, parseYaml, splitFrontmatter, TYPE_FOLDERS, type Config } from "../engine/index.js";
import { decideBase, highestVersion } from "../github/index.js";
import { INDEX_SCHEMA, type BranchIndex, type IndexDocument, type IndexRelation } from "./model.js";

const WORK_BRANCH_RE = /^(v[0-9]+\.[0-9]+\.[0-9]+)\/[^/].*$/;
const TRUTH_RE = /^(main|release\/v[0-9]+\.[0-9]+\.[0-9]+)$/;

/** Git access for the checkout; injectable for tests. */
export interface GitInfo {
  head(): string;
  /** Latest commit (sha, ISO date) per path under docs/ and code/. */
  latestCommits(): Map<string, { sha: string; date: string }>;
  /** Tag names. */
  tags(): string[];
  /** Whether a branch exists (local or origin/). */
  branchExists(name: string): boolean;
  /** Paths changed on HEAD since it left `base` (three-dot diff). */
  changedSince(base: string): Set<string>;
  /** The newest commits that touched a path, newest first. */
  commitsFor?(path: string, limit: number): string[];
  /** For each path under docs/ and code/: the truth branches (main, release/*) and v* tags it exists on. */
  releaseRefs?(): Map<string, string[]>;
}

export function localGit(root: string): GitInfo {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const ref = (name: string) => {
    for (const candidate of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      try {
        git("rev-parse", "--verify", "--quiet", candidate);
        return candidate;
      } catch {
        // try the next one
      }
    }
    return undefined;
  };
  return {
    head: () => git("rev-parse", "HEAD").trim(),
    latestCommits: () => {
      const out = new Map<string, { sha: string; date: string }>();
      let current: { sha: string; date: string } | undefined;
      for (const line of git("log", "--format=%x00%H%x09%cI", "--name-only", "--", "docs", "code").split("\n")) {
        if (line.startsWith("\0")) {
          const [sha, date] = line.slice(1).split("\t");
          current = { sha: sha!, date: date! };
        } else if (line && current && !out.has(line)) out.set(line, current);
      }
      return out;
    },
    tags: () => git("tag", "--list", "v*").split("\n").filter(Boolean),
    branchExists: (name) => ref(name) !== undefined,
    releaseRefs: () => {
      const out = new Map<string, string[]>();
      const refs = git("for-each-ref", "--format=%(refname)", "refs/remotes/origin/main", "refs/remotes/origin/release/", "refs/heads/main", "refs/heads/release/", "refs/tags/")
        .split("\n")
        .filter(Boolean);
      const names = new Map<string, string>();
      for (const r of refs) {
        const name = r.replace(/^refs\/(remotes\/origin|heads|tags)\//, "");
        if (TRUTH_RE.test(name) || /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(name)) if (!names.has(name) || r.startsWith("refs/remotes/")) names.set(name, r);
      }
      for (const [name, ref] of [...names].sort(([a], [b]) => a.localeCompare(b))) {
        for (const path of git("ls-tree", "-r", "--name-only", ref, "--", "docs", "code").split("\n").filter(Boolean)) {
          out.set(path, [...(out.get(path) ?? []), name]);
        }
      }
      return out;
    },
    commitsFor: (path, limit) => git("log", `-n${limit}`, "--format=%H", "--", path).split("\n").filter(Boolean),
    changedSince: (base) => {
      const r = ref(base);
      if (!r) return new Set();
      return new Set(git("diff", "--name-only", `${r}...HEAD`, "--", "docs", "code").split("\n").filter(Boolean));
    },
  };
}

export interface BuildOptions {
  root: string;
  branch: string;
  git: GitInfo;
  /** Login of whoever merged the PR for a commit; undefined when unknown or no token. */
  mergedBy?: (sha: string) => Promise<string | null>;
  now?: () => Date;
}

export function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith(".md")) out.push(child);
    }
  };
  for (const folder of Object.keys(TYPE_FOLDERS)) walk(`docs/${folder}`);
  walk("code");
  return out.sort();
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The base branch whose diff marks documents pending, or null. */
export function pendingBase(branch: string, git: GitInfo): string | null {
  if (TRUTH_RE.test(branch)) return null;
  const m = WORK_BRANCH_RE.exec(branch);
  if (!m) return null;
  const decision = decideBase(m[1]!, highestVersion(git.tags()), git.branchExists(`release/${m[1]}`));
  return decision.ok ? decision.base : null;
}

/**
 * Who merged the latest PR that touched the file. Bot commits (post-merge
 * edits) have no PR, so older commits of the file are tried, up to 10.
 */
async function mergedByFor(path: string, latest: string, git: GitInfo, lookup: (sha: string) => Promise<string | null>): Promise<string | null> {
  const shas = git.commitsFor ? git.commitsFor(path, 10) : [latest];
  for (const sha of shas.length ? shas : [latest]) {
    const who = await lookup(sha);
    if (who) return who;
  }
  return null;
}

/** Builds the index of the checkout at `root` (spec 6.2). */
export async function buildIndex(opts: BuildOptions): Promise<BranchIndex> {
  const { root, branch, git } = opts;
  const loaded = loadConfig(root);
  const config: Config = loaded.config ?? ({ repositories: [] } as unknown as Config);
  const base = pendingBase(branch, git);
  const changed = base ? git.changedSince(base) : new Set<string>();
  const commits = git.latestCommits();
  const releaseRefs = git.releaseRefs ? git.releaseRefs() : new Map<string, string[]>();
  const skipped: BranchIndex["skipped"] = [];
  const docs: IndexDocument[] = [];

  for (const path of markdownFiles(root)) {
    const c = classifyPath(path, config);
    if (!c.type || !c.key) {
      skipped.push({ path, reason: c.findings[0]?.message ?? "not a document path" });
      continue;
    }
    const split = splitFrontmatter(readFileSync(join(root, path), "utf8"));
    let fm: Record<string, unknown> = {};
    try {
      const data = split ? parseYaml(split.frontmatter) : undefined;
      if (!isRecord(data)) throw new Error("no frontmatter mapping");
      fm = data;
    } catch (err) {
      skipped.push({ path, reason: `frontmatter: ${(err as Error).message}` });
      continue;
    }
    const outgoing: IndexRelation[] = (Array.isArray(fm.relations) ? fm.relations : [])
      // Inverse entries (written by the bot) only mirror forward relations; incoming is computed from those.
      .filter((r): r is Record<string, unknown> => isRecord(r) && typeof r.target === "string" && !(String(r.type) in INVERSE_OF))
      .map((r) => ({ type: String(r.type), target: String(r.target), why: String(r.why ?? "") }));
    const commit = commits.get(path) ?? null;
    const file = path.split("/").pop()!;
    docs.push({
      id: c.key,
      type: c.type,
      path,
      slug: c.type === "shadow" ? null : file.replace(/^[0-9]+-/, "").replace(/\.md$/, ""),
      title: str(fm.title),
      description: str(fm.description),
      intent: str(fm.intent),
      when: str(fm.when),
      state: str(fm.state),
      category: str(fm.category),
      featured: fm.featured === true,
      placeholder: fm.placeholder === true,
      pending: changed.has(path),
      relations: { outgoing, incoming: [] },
      releases: releaseRefs.get(path) ?? [],
      commit,
      mergedBy: commit && opts.mergedBy ? await mergedByFor(path, commit.sha, git, opts.mergedBy) : null,
    });
  }

  const byId = new Map(docs.map((d) => [d.id, d]));
  for (const d of docs) {
    for (const r of d.relations.outgoing) byId.get(r.target!)?.relations.incoming.push({ type: r.type, source: d.id, why: r.why });
  }
  docs.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: INDEX_SCHEMA,
    branch,
    sourceSha: git.head(),
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    base,
    documents: docs,
    skipped,
  };
}
