import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findGitRoot, originRepository } from "../docs/gitrepo.js";
import { charCount, composeInstructions, FALLBACK_INSTRUCTIONS, INSTRUCTIONS_FILE, isRecord, parseYaml, placeholderProblems, primingFeatured, splitFrontmatter } from "../engine/index.js";
import { encodePath, GitHubClient, GitHubError, readFile } from "../github/index.js";
import { indexFileName } from "../index/model.js";
import { fetchIndex } from "../index/read.js";
import { currentRelease, listRels, type Resolution } from "../release/release.js";
import { loadSetup, TOKEN_ENV, type SetupProblem } from "../setup/setup.js";
import { checkForUpdate, installedPluginVersion, marketplaceViewer, updateNotice, type Viewer } from "./update.js";

/** Claude Code caps additionalContext at 10,000 characters. */
export const CLAUDE_CONTEXT_CAP = 10_000;
export const DEFAULT_BUDGET = 8000;

export interface FeaturedBody {
  id: string;
  title: string;
  path: string;
  /** Commit of the document in the index; the cached body is reused while it is unchanged. */
  sha: string;
  body: string;
}

/** Cache of the last priming per documentation branch. */
export interface DocsBranchCache {
  at: string;
  docs: string;
  docsBranch: string;
  budget: number;
  featured: FeaturedBody[];
  /** config/instructions.md of the documentation branch, with its ETag. */
  instructions?: { text: string; etag?: string };
}

/** What a code branch resolved to the last time it was primed online. */
export interface BranchEntry {
  at: string;
  docsBranch: string;
  release: string[];
}

export interface PrimeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  cacheDir: string;
  /** CLI version; the plugin version comes from \`pluginRoot\`. */
  version: string;
  /** \`CLAUDE_PLUGIN_ROOT\` when the hook runs from the plugin; the update check runs only then. */
  pluginRoot?: string;
  fetch?: typeof fetch;
  view?: Viewer;
  /** Per request; the whole online part also stops after `deadlineMs`. */
  requestTimeoutMs?: number;
  deadlineMs?: number;
}

export interface Primed {
  context: string;
  mode: "online" | "cache" | "none";
  docsBranch?: string;
  warnings: string[];
}

interface LocalCode {
  repo?: string;
  branch?: string;
}

function localCode(cwd: string): LocalCode {
  const root = findGitRoot(cwd);
  if (!root) return {};
  let branch: string | undefined;
  try {
    branch = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    branch = undefined;
  }
  return { repo: originRepository(root), branch };
}

const primingRoot = (dir: string, docs: string) => join(dir, "priming", ...docs.split("/"));
const docsCacheFile = (dir: string, docs: string, docsBranch: string) => join(primingRoot(dir, docs), indexFileName(docsBranch));
const branchesFile = (dir: string, docs: string) => join(primingRoot(dir, docs), "code-branches.json");
const branchKey = (c: LocalCode) => `${c.repo ?? "?"}#${c.branch ?? "?"}`;

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, data: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  } catch {
    // A cache that cannot be written only means no offline priming next time.
  }
}

/** The release lines of the priming for a resolution (spec 7.3). */
export function releaseLines(r: Resolution, code: LocalCode): string[] {
  if (!r.ok) {
    return [
      `- Code: \`${r.repo ?? code.repo ?? "unknown repository"}\` branch \`${r.branch ?? code.branch ?? "unknown"}\``,
      `- Release: none. This branch is orphaned: ${r.message}.`,
      `- ${r.nextAction}`,
      "- Documentation branch: `main` until the branch is mapped.",
    ];
  }
  return [
    `- Code: \`${r.repo}\` branch \`${r.branch}\``,
    `- Release: ${r.rel.version} (${r.rel.id}, phase ${r.rel.phase}), ${r.how === "direct" ? "the branch is mapped in the release" : `inherited from the mapped branch \`${r.mappedBranch}\` (git merge-base)`}`,
    r.docsBranch === "main"
      ? `- Documentation branch: \`main\`${r.docsBranchExists ? "" : ` (\`${r.rel.docsBranch}\` does not exist)`}: commands read it by default`
      : `- Documentation branch: \`${r.docsBranch}\`: read with \`--ref ${r.docsBranch}\``,
    `- Work with version ${r.rel.version}; run \`idc365-decisions release current\` if the branch changes.`,
  ];
}

/**
 * Composes the priming from the instruction text: its placeholders filled
 * in, featured documents in index order while they fit the budget (and
 * Claude Code's cap); the rest are named so the agent can read them with
 * `show`. Featured documents are the first to go.
 */
export function composePriming(template: string, docs: string, release: string[], warnings: string[], featured: FeaturedBody[], budget: number): string {
  const limit = Math.min(budget, CLAUDE_CONTEXT_CAP);
  const vars = { docs, release, warnings };
  let used = charCount(composeInstructions(template, vars, ""));
  const blocks: string[] = [];
  const left: string[] = [];
  for (const f of featured) {
    const block = primingFeatured(f.id, f.title, f.body);
    const n = charCount(block) + 1;
    if (used + n <= limit) {
      blocks.push(block);
      used += n;
    } else left.push(f.id);
  }
  let featuredText = blocks.join("\n");
  if (left.length) featuredText += `\nFeatured documents left out to stay within the budget of ${limit} characters: ${left.join(", ")}. Read them with \`idc365-decisions <type> show <ID>\`.\n`;
  const text = composeInstructions(template, vars, featuredText);
  // Only an instruction text far over the budget gets here; cut as the last resort.
  return charCount(text) > CLAUDE_CONTEXT_CAP ? [...text].slice(0, CLAUDE_CONTEXT_CAP).join("") : text;
}

/** config/instructions.md at a ref, with the cached ETag; undefined when missing (the caller keeps its cached copy). */
async function instructionsAt(client: GitHubClient, ref: string, previous: DocsBranchCache["instructions"]): Promise<DocsBranchCache["instructions"]> {
  const res = await client.request<unknown>("GET", client.repoPath(`/contents/${encodePath(INSTRUCTIONS_FILE)}`), {
    query: { ref },
    accept: "application/vnd.github.raw+json",
    headers: previous?.etag ? { "If-None-Match": previous.etag } : {},
    allow: [304, 404],
  });
  if (res.status === 304) return previous;
  if (res.status === 404) return previous;
  const text = typeof res.data === "string" ? res.data : String(res.data ?? "");
  // A text without its placeholders would drop the release and commands; keep the last good copy instead.
  if (placeholderProblems(text).length) return previous;
  return { text, etag: res.headers.get("etag") ?? undefined };
}

function timeoutFetch(base: typeof fetch, ms: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => base(input, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
}

async function budgetAt(client: GitHubClient, ref: string, fallback: number): Promise<number> {
  const f = await readFile(client, "config/priming.yaml", ref);
  if (!f) return fallback;
  try {
    const y = parseYaml(await f.text());
    return isRecord(y) && typeof y.priming_budget === "number" && y.priming_budget > 0 ? y.priming_budget : fallback;
  } catch {
    return fallback;
  }
}

async function online(client: GitHubClient, docs: string, o: PrimeOptions, code: LocalCode, cacheDir: string): Promise<{ release: string[]; cache: DocsBranchCache; indexNote?: string }> {
  const rels = await listRels(client, "main");
  const r = await currentRelease(client, o.cwd, rels);
  const docsBranch = r.ok ? r.docsBranch : "main";
  const previous = readJson<DocsBranchCache>(docsCacheFile(cacheDir, docs, docsBranch));
  const [idx, budget, instructions] = await Promise.all([fetchIndex(client, docsBranch, cacheDir), budgetAt(client, docsBranch, previous?.budget ?? DEFAULT_BUDGET), instructionsAt(client, docsBranch, previous?.instructions)]);
  let indexNote: string | undefined;
  if (!idx.index) indexNote = `There is no index for \`${docsBranch}\` yet, so featured documents are not included; list them with \`idc365-decisions adr list --ref ${docsBranch}\`.`;
  else if (idx.stale) indexNote = `The index of \`${docsBranch}\` is being rebuilt; the featured documents are read from the branch itself.`;
  const wanted = (idx.index?.documents ?? []).filter((d) => d.featured && d.state !== "superseded" && d.state !== "retired");
  const featured = await Promise.all(
    wanted.map(async (d): Promise<FeaturedBody | undefined> => {
      const sha = d.commit?.sha ?? "";
      const hit = !idx.stale && sha ? previous?.featured.find((f) => f.path === d.path && f.sha === sha) : undefined;
      if (hit) return { ...hit, id: d.id, title: d.title ?? "" };
      const file = await readFile(client, d.path, docsBranch);
      if (!file) return undefined;
      const split = splitFrontmatter(await file.text());
      return { id: d.id, title: d.title ?? "", path: d.path, sha, body: (split?.body ?? "").trim() };
    }),
  );
  const cache: DocsBranchCache = { at: (o.now ?? new Date()).toISOString(), docs, docsBranch, budget, featured: featured.filter((f): f is FeaturedBody => !!f), instructions };
  return { release: releaseLines(r, code), cache, indexNote };
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new GitHubError(0, `the documentation repository did not answer within ${ms / 1000} s`, "Check the network connection.", "priming")), ms)))]).finally(() => clearTimeout(timer));
}

function problemText(p: SetupProblem[]): string {
  return p.map((x) => `${x.message} Fix: ${x.nextAction}`).join(" ");
}

/**
 * The SessionStart priming (spec 9.2/9.3). Never throws: without network or
 * token it primes from the cache with a stale warning and what is missing.
 */
export async function prime(o: PrimeOptions): Promise<Primed> {
  const env = o.env ?? process.env;
  const now = o.now ?? new Date();
  const code = localCode(o.cwd);
  const warnings: string[] = [];
  const setup = loadSetup(o.cwd, env);
  const installed = installedPluginVersion(o.pluginRoot);
  const update: Promise<string | undefined> =
    installed && setup.ok
      ? checkForUpdate(installed, {
          dir: o.cacheDir,
          key: setup.setup.repository,
          now,
          view: o.view ?? marketplaceViewer(new GitHubClient({ repository: setup.setup.repository, token: setup.setup.token, fetch: timeoutFetch(o.fetch ?? fetch, 4000) })),
        }).then(updateNotice, () => undefined)
      : Promise.resolve(undefined);

  const linkProblem = !setup.ok ? setup.problems.find((p) => p.kind !== "token-missing") : undefined;
  if (!setup.ok && linkProblem) {
    const notice = await update;
    const context = [
      "# IDC365 decision system",
      "",
      `The idc365-decisions hook ran, but this repository is not linked to a documentation repository: ${linkProblem.message}`,
      `Fix: ${linkProblem.nextAction} Until then no decisions, procedures or tech stack are available here; tell the user.`,
      ...(notice ? ["", `> ${notice}`] : []),
      "",
    ].join("\n");
    return { context, mode: "none", warnings: [linkProblem.message] };
  }
  const docs = setup.ok ? setup.setup.repository : (readJson<{ repository?: string }>(setup.linkFile!)?.repository ?? "");

  let reason: string | undefined;
  let result: Awaited<ReturnType<typeof online>> | undefined;
  if (!setup.ok) reason = problemText(setup.problems);
  else {
    const client = new GitHubClient({ repository: docs, token: setup.setup.token, fetch: timeoutFetch(o.fetch ?? fetch, o.requestTimeoutMs ?? 4000) });
    try {
      result = await withDeadline(online(client, docs, o, code, o.cacheDir), o.deadlineMs ?? 9000);
    } catch (err) {
      const e = err as Error;
      reason = err instanceof GitHubError
        ? err.status === 401
          ? `the token in \`${TOKEN_ENV}\` was rejected (401). Fix: the user creates a new token and stores it as \`${TOKEN_ENV}\`; run \`idc365-decisions setup\` for the steps (Windows and Linux).`
          : `${e.message}. Fix: ${err.nextAction}`
        : `unexpected error: ${e.message}.`;
    }
  }

  const notice = await update;
  if (result) {
    writeJson(docsCacheFile(o.cacheDir, docs, result.cache.docsBranch), result.cache);
    const branches = readJson<Record<string, BranchEntry>>(branchesFile(o.cacheDir, docs)) ?? {};
    branches[branchKey(code)] = { at: result.cache.at, docsBranch: result.cache.docsBranch, release: result.release };
    writeJson(branchesFile(o.cacheDir, docs), branches);
    if (result.indexNote) warnings.push(result.indexNote);
    if (notice) warnings.push(notice);
    return { context: composePriming(result.cache.instructions?.text ?? FALLBACK_INSTRUCTIONS, docs, result.release, warnings, result.cache.featured, result.cache.budget), mode: "online", docsBranch: result.cache.docsBranch, warnings };
  }

  // Offline or no token: the last priming of this code branch, else of main.
  const entry = (readJson<Record<string, BranchEntry>>(branchesFile(o.cacheDir, docs)) ?? {})[branchKey(code)];
  const docsBranch = entry?.docsBranch ?? "main";
  const cached = readJson<DocsBranchCache>(docsCacheFile(o.cacheDir, docs, docsBranch));
  const release = entry?.release ?? [
    `- Code: \`${code.repo ?? "unknown repository"}\` branch \`${code.branch ?? "unknown"}\``,
    "- Release: unknown. This branch has not been primed online before, so its release could not be resolved.",
    "- Run `idc365-decisions release current` once the documentation repository can be reached.",
  ];
  if (cached) warnings.push(`Primed from the cache of ${cached.at.slice(0, 16).replace("T", " ")} UTC because the documentation repository could not be read: ${reason} The content may be out of date; tell the user what is missing before relying on it.`);
  else warnings.push(`No cached priming exists and the documentation repository could not be read: ${reason} Tell the user; decisions, procedures and the tech stack are not available until this is fixed.`);
  if (notice) warnings.push(notice);
  return { context: composePriming(cached?.instructions?.text ?? FALLBACK_INSTRUCTIONS, docs, release, warnings, cached?.featured ?? [], cached?.budget ?? DEFAULT_BUDGET), mode: cached ? "cache" : "none", docsBranch: cached ? docsBranch : undefined, warnings };
}

/** The hook output Claude Code reads from stdout. */
export function hookOutput(context: string): string {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`;
}
