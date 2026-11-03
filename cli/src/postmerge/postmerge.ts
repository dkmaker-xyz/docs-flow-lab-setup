import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDocument } from "../docs/compose.js";
import { relativeLink } from "../docs/macros.js";
import { classifyPath, INVERSE_OF, isRecord, loadConfig, parseYaml, splitFrontmatter, validateTree, type Config, type Finding, type Relation } from "../engine/index.js";
import { branchHead, buildCommit, compareVersions, encodePath, GitHubError, highestVersion, parseVersion, readFile, type FileChange, type GitHubClient } from "../github/index.js";
import { markdownFiles } from "../index/build.js";

/** Forward type → the inverse the bot writes into the target (spec 4.3). relates-to is its own inverse. */
export const INVERSE_FOR: Record<string, string> = {
  ...Object.fromEntries(Object.entries(INVERSE_OF).map(([inverse, forward]) => [forward, inverse])),
  "relates-to": "relates-to",
};

/** Target state a forward relation sets on its target (spec 3.4, 4.3). amends: none. */
export const TARGET_STATE: Record<string, string> = { supersedes: "superseded" };

export interface Edit {
  /** Target document path. */
  file: string;
  key: string;
  add: Relation[];
  state?: string;
  /** Other fields the bot sets (for example a REL's phase). */
  set?: Record<string, unknown>;
  /** Human summary of what the edit does and why. */
  reasons: string[];
}

interface Doc {
  file: string;
  key: string;
  fm: Record<string, unknown>;
}

function parse(text: string): { fm: Record<string, unknown>; body: string } | undefined {
  const split = splitFrontmatter(text);
  if (!split) return undefined;
  try {
    const fm = parseYaml(split.frontmatter);
    return isRecord(fm) ? { fm, body: split.body } : undefined;
  } catch {
    return undefined;
  }
}

function relations(fm: Record<string, unknown>): Relation[] {
  return (Array.isArray(fm.relations) ? fm.relations : []).filter((r): r is Relation => isRecord(r) && typeof r.target === "string" && typeof r.type === "string") as Relation[];
}

/** Every document in the checkout, by key. */
export function readTree(root: string, config: Config): Map<string, Doc> {
  const out = new Map<string, Doc>();
  for (const file of markdownFiles(root)) {
    const c = classifyPath(file, config);
    if (!c.key) continue;
    const p = parse(readFileSync(join(root, file), "utf8"));
    if (p) out.set(c.key, { file, key: c.key, fm: p.fm });
  }
  return out;
}

/**
 * The bot's follow-up edits for the documents in `changed` (paths), or for
 * every document with "all": for each forward relation to a document in the
 * tree, the matching inverse entry in the target, plus the target state.
 */
export function planEdits(docs: Map<string, Doc>, changed: Set<string> | "all"): Edit[] {
  const edits = new Map<string, Edit>();
  for (const d of docs.values()) {
    if (changed !== "all" && !changed.has(d.file)) continue;
    for (const r of relations(d.fm)) {
      const inverse = INVERSE_FOR[r.type];
      const target = docs.get(r.target);
      if (!inverse || !target || target.key === d.key) continue; // inverse types, Jira, URLs, self
      const edit = edits.get(target.key) ?? { file: target.file, key: target.key, add: [], reasons: [] };
      const has = relations(target.fm).some((t) => t.type === inverse && t.target === d.key) || edit.add.some((t) => t.type === inverse && t.target === d.key);
      if (!has) {
        edit.add.push({ type: inverse, target: d.key, why: r.why, link: relativeLink(target.file, d.file) });
        edit.reasons.push(`${inverse} ${d.key}`);
      }
      const state = TARGET_STATE[r.type];
      if (state && target.fm.state !== state && edit.state !== state) {
        edit.state = state;
        edit.reasons.push(`state ${state} (${d.key} ${r.type} it)`);
      }
      if (edit.add.length || edit.state) edits.set(target.key, edit);
    }
  }
  return [...edits.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Applies an edit to a file's text; returns the same text when there is nothing left to do. */
export function applyEdit(text: string, edit: Edit): string {
  const p = parse(text);
  if (!p) return text;
  const fm = { ...p.fm };
  const rels = relations(fm);
  let changed = false;
  for (const a of edit.add) {
    if (!rels.some((r) => r.type === a.type && r.target === a.target)) {
      rels.push(a);
      changed = true;
    }
  }
  if (edit.state && fm.state !== edit.state) {
    fm.state = edit.state;
    changed = true;
  }
  for (const [k, v] of Object.entries(edit.set ?? {})) {
    if (fm[k] !== v) {
      fm[k] = v;
      changed = true;
    }
  }
  if (!changed) return text;
  // Keep relations where they were; do not add an empty list to a document that had none.
  if (rels.length || Array.isArray(p.fm.relations)) fm.relations = rels;
  return renderDocument(fm, p.body);
}

/** A ref change the bot makes after its commit. */
export type Action =
  | { kind: "create-branch"; branch: string; from: string; reason: string }
  | { kind: "delete-branch"; branch: string; reason: string }
  | { kind: "create-tag"; tag: string; sha: string; reason: string };

const RELEASE_BRANCH_RE = /^release\/(v[0-9]+\.[0-9]+\.[0-9]+)$/;

/** Tag names in the checkout. */
function localTags(root: string): string[] {
  try {
    return execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** The branch a merge commit merged, from GitHub's message or from a release branch whose tip is the second parent. */
export function mergedBranch(root: string, after: string): string | undefined {
  const git = (...a: string[]) => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
  const parents = (git("rev-list", "--parents", "-n1", after) ?? "").split(" ").slice(1);
  if (parents.length < 2) return undefined;
  const subject = git("log", "-1", "--format=%s", after) ?? "";
  const m = /^Merge pull request #[0-9]+ from [^/\s]+\/(\S+)$/.exec(subject);
  if (m) return m[1];
  const refs = (git("for-each-ref", "--format=%(refname:short) %(objectname)", "refs/remotes/origin/release/", "refs/heads/release/") ?? "").split("\n").filter(Boolean);
  const hit = refs.map((l) => l.split(" ")).find(([, sha]) => sha === parents[1]);
  return hit?.[0]?.replace(/^origin\//, "");
}

function gitOut(root: string, ...a: string[]): string | undefined {
  try {
    return execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return undefined;
  }
}

/** Merge commits on the first-parent line in (before, after]; just `after` without a usable `before`. */
export function mergesIn(root: string, before: string | undefined, after: string): string[] {
  if (!before || ZERO.test(before)) return [after];
  const list = gitOut(root, "rev-list", "--first-parent", `${before}..${after}`);
  return list === undefined ? [after] : list.split("\n").filter(Boolean).reverse();
}

/** The first commit in (before, after] that recorded `version` in a REL file (phase released, or a patches entry). */
export function recordedIn(root: string, before: string | undefined, after: string, file: string, version: string, released: boolean): string | undefined {
  const range = before && !ZERO.test(before) ? `${before}..${after}` : after;
  const pick = released ? ["-G", "^phase: *released"] : ["-S", version];
  const out = gitOut(root, "log", "--first-parent", "--reverse", "--format=%H", ...pick, range, "--", file);
  return out?.split("\n").find(Boolean);
}

/**
 * The release lifecycle after a push to a truth branch (spec 7.2, 7.5):
 * - a REL merged to main with phase planned: set phase development and
 *   create release/<version> from main (after the bot's commit);
 * - release/vX.Y.Z merged into main: delete release/vX.Y.Z. A merge into a
 *   release branch, or between release branches, never deletes anything.
 */
export function releaseHooks(docs: Map<string, Doc>, changed: Set<string> | "all", branch: string, root?: string, after?: string, before?: string): { edits: Edit[]; actions: Action[] } {
  const edits: Edit[] = [];
  const actions: Action[] = [];
  if (branch !== "main") return { edits, actions };
  for (const d of docs.values()) {
    if (changed !== "all" && !changed.has(d.file)) continue;
    if (!d.key.startsWith("REL-") || d.fm.phase !== "planned" || typeof d.fm.version !== "string") continue;
    edits.push({ file: d.file, key: d.key, add: [], set: { phase: "development" }, reasons: ["phase development"] });
    actions.push({ kind: "create-branch", branch: `release/${d.fm.version}`, from: "main", reason: `${d.key} (${d.fm.version}) was merged with phase planned` });
  }
  // Tags (spec 7.2): a merged release record (REL released, or a new entry in
  // `patches`) gets its tag on the merge commit. Only versions above every
  // existing tag; an existing tag means nothing to do.
  if (root && after) {
    const tags = localTags(root);
    const highest = highestVersion(tags);
    for (const d of docs.values()) {
      if (changed !== "all" && !changed.has(d.file)) continue;
      if (!d.key.startsWith("REL-")) continue;
      const versions = [...(d.fm.phase === "released" && typeof d.fm.version === "string" ? [d.fm.version] : []), ...(Array.isArray(d.fm.patches) ? d.fm.patches.filter((x): x is string => typeof x === "string") : [])];
      for (const version of versions) {
        const v = parseVersion(version);
        if (!v || tags.includes(version) || (highest && compareVersions(v, highest) <= 0)) continue;
        if (actions.some((a) => a.kind === "create-tag" && a.tag === version)) continue;
        // The handled range can span several merges (a cancelled run): tag the commit that recorded the version.
        const sha = recordedIn(root, before, after, d.file, version, d.fm.phase === "released" && d.fm.version === version) ?? after;
        actions.push({ kind: "create-tag", tag: version, sha, reason: `${d.key} records ${version} as released` });
      }
    }
    // Every merge in the handled range, not only the last commit (a cancelled run's merge is handled here).
    for (const commit of mergesIn(root, before, after)) {
      const merged = mergedBranch(root, commit);
      if (merged && RELEASE_BRANCH_RE.test(merged) && !actions.some((a) => a.kind === "delete-branch" && a.branch === merged)) {
        actions.push({ kind: "delete-branch", branch: merged, reason: `${merged} was merged into main` });
      }
    }
  }
  return { edits, actions };
}

/** Merges edits for the same document. */
function combine(edits: Edit[]): Edit[] {
  const byKey = new Map<string, Edit>();
  for (const e of edits) {
    const cur = byKey.get(e.key);
    if (!cur) byKey.set(e.key, { ...e, add: [...e.add], reasons: [...e.reasons], set: { ...e.set } });
    else {
      cur.add.push(...e.add);
      cur.reasons.push(...e.reasons);
      cur.state = e.state ?? cur.state;
      cur.set = { ...cur.set, ...e.set };
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface PostMergeResult {
  changed: string[] | "all";
  edits: Edit[];
  /** Findings of the tree with the edits applied; the bot commits only when empty. */
  findings: Finding[];
  commit?: string;
  /** Ref changes (release branches); `done` once made. */
  actions: (Action & { done?: boolean; skipped?: string })[];
  /** "nothing" when no edit was needed (also after a concurrent run did them). */
  outcome: "nothing" | "committed" | "dry-run" | "invalid";
}

const ZERO = /^0+$/;

export function changedFiles(root: string, before: string | undefined, after: string): Set<string> | "all" {
  if (!before || ZERO.test(before)) return "all";
  try {
    const out = execFileSync("git", ["diff", "--name-only", before, after, "--", "docs", "code"], { cwd: root, encoding: "utf8" });
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return "all"; // before is unknown here (for example after a force push): check everything
  }
}

/**
 * The post-merge run for a truth branch: plan the edits for the pushed
 * documents, check that the tree with them validates, then commit them as
 * the bot in one commit on the current branch head. Idempotent: with nothing
 * to do it writes nothing, so the bot's own commit does not loop.
 */
export async function postMerge(opts: {
  root: string;
  branch: string;
  before?: string;
  after: string;
  client?: GitHubClient;
  dryRun?: boolean;
  maxAttempts?: number;
}): Promise<PostMergeResult> {
  const loaded = loadConfig(opts.root);
  if (!loaded.config) return { changed: [], edits: [], actions: [], findings: loaded.findings, outcome: "invalid" };
  const docs = readTree(opts.root, loaded.config);
  const changed = changedFiles(opts.root, opts.before, opts.after);
  const hooks = releaseHooks(docs, changed, opts.branch, opts.root, opts.after, opts.before);
  const edits = combine([...planEdits(docs, changed), ...hooks.edits]);
  const actions: PostMergeResult["actions"] = hooks.actions;
  const changedList = changed === "all" ? "all" : [...changed].sort();
  if (edits.length === 0 && actions.length === 0) return { changed: changedList, edits, actions, findings: [], outcome: "nothing" };

  // The tree with the edits must validate clean before the bot writes anything.
  for (const e of edits) writeFileSync(join(opts.root, e.file), applyEdit(readFileSync(join(opts.root, e.file), "utf8"), e));
  const findings = validateTree(opts.root).findings;
  if (findings.length) return { changed: changedList, edits, actions, findings, outcome: "invalid" };
  if (opts.dryRun || !opts.client) return { changed: changedList, edits, actions, findings, outcome: "dry-run" };

  const client = opts.client;
  const committed = edits.length ? await commitEdits(client, opts.branch, edits, opts.maxAttempts) : undefined;
  for (const a of actions) {
    if (a.kind === "create-branch") {
      if (await branchHead(client, a.branch)) {
        a.skipped = "exists";
        continue;
      }
      const from = await branchHead(client, a.from);
      if (!from) throw new GitHubError(404, `${a.from} does not exist`, "Nothing to do.", `GET git/ref/heads/${a.from}`);
      await client.request("POST", client.repoPath("/git/refs"), { body: { ref: `refs/heads/${a.branch}`, sha: from } });
      a.done = true;
    } else if (a.kind === "create-tag") {
      const exists = await client.request("GET", client.repoPath(`/git/ref/tags/${encodePath(a.tag)}`), { allow: [404] });
      if (exists.status !== 404) {
        a.skipped = "exists";
        continue;
      }
      await client.request("POST", client.repoPath("/git/refs"), { body: { ref: `refs/tags/${a.tag}`, sha: a.sha } });
      a.done = true;
    } else {
      const del = await client.request("DELETE", client.repoPath(`/git/refs/heads/${encodePath(a.branch)}`), { allow: [404, 422] });
      if (del.status === 422 && (await branchHead(client, a.branch))) throw new GitHubError(422, `deleting ${a.branch} was rejected`, "Check that the bot may bypass the truth-branches ruleset.", `DELETE git/refs/heads/${a.branch}`);
      if (del.status === 404 || del.status === 422) a.skipped = "already deleted";
      else a.done = true;
    }
  }
  const did = actions.some((a) => a.done);
  if (!committed && !did) return { changed: changedList, edits, actions, findings, outcome: "nothing" };
  return { changed: changedList, edits, actions, findings, commit: committed, outcome: "committed" };
}

/** Commits edits on the branch head (re-applied to the head's files); undefined when nothing changed. */
async function commitEdits(client: GitHubClient, branch: string, edits: Edit[], maxAttempts = 5): Promise<string | undefined> {
  const message = `Post-merge: ${edits.map((e) => `${e.key} ← ${e.reasons.join(", ")}`).join("; ")}`;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const head = await branchHead(client, branch);
    if (!head) throw new GitHubError(404, `branch ${branch} no longer exists`, "Nothing to do.", `GET git/ref/heads/${branch}`);
    // Apply the edits to the files as they are at the head now (another merge may have landed).
    const changes: FileChange[] = [];
    for (const e of edits) {
      const current = await readFile(client, e.file, head);
      if (!current) continue;
      const next = applyEdit(current.text(), e);
      if (next !== current.text()) changes.push({ path: e.file, content: next });
    }
    if (changes.length === 0) return undefined;
    const sha = await buildCommit(client, head, changes, message);
    const moved = await client.request("PATCH", client.repoPath(`/git/refs/heads/${encodePath(branch)}`), { body: { sha, force: false }, allow: [422] });
    if (moved.status !== 422) return sha;
    // 422: the branch moved since we read it; retry on the new head.
  }
  throw new GitHubError(409, `could not commit the post-merge edits to ${branch}`, "Run the post-merge workflow again.", `PATCH git/refs/heads/${branch}`);
}
