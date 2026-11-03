import type { GitHubClient } from "./client.js";
import { branchHead } from "./git.js";

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseVersion(text: string): Version | undefined {
  const m = VERSION_RE.exec(text);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : undefined;
}

export function formatVersion(v: Version): string {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** `vX.Y.Z/<slug>`, the only allowed work-branch name (spec 7.1). */
export function workBranchName(version: string, slug: string): string {
  if (!parseVersion(version)) throw new Error(`version must be vMAJOR.MINOR.PATCH, got "${version}"`);
  if (!SLUG_RE.test(slug)) throw new Error(`slug must be lowercase letters and digits separated by hyphens, got "${slug}"`);
  return `${version}/${slug}`;
}

/**
 * The released version: the highest `vX.Y.Z` tag (spec 7.2), read with one
 * call. Tags that are not full semantic versions are ignored. Tags are created
 * on main by the bot only, so ancestry is not checked.
 */
export async function releasedVersion(client: GitHubClient): Promise<Version | undefined> {
  const res = await client.request<{ ref: string }[]>("GET", client.repoPath("/git/matching-refs/tags/v"));
  return highestVersion(res.data.map((r) => r.ref));
}

export type BaseResult =
  | { ok: true; base: string; reason: "patch-on-main" | "release-branch" | "no-release-yet"; released?: Version }
  | { ok: false; message: string; nextAction: string; released?: Version };

/**
 * The base branch for work on `version` (spec 7.1):
 * - an existing `release/<version>` branch → that branch;
 * - same major.minor as the released version → `main`;
 * - no released version yet (no tag) → `main`;
 * - otherwise refused: the release must be created first.
 */
export async function baseBranchFor(client: GitHubClient, version: string): Promise<BaseResult> {
  if (!parseVersion(version)) return decideBase(version, undefined, false);
  const released = await releasedVersion(client);
  return decideBase(version, released, (await branchHead(client, `release/${version}`)) !== undefined);
}

/** The highest strict vX.Y.Z among tag names. */
export function highestVersion(tags: string[]): Version | undefined {
  let best: Version | undefined;
  for (const t of tags) {
    const v = parseVersion(t.replace(/^refs\/tags\//, ""));
    if (v && (!best || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

/** The base-branch rule itself, without I/O, for the API and for a local checkout. */
export function decideBase(version: string, released: Version | undefined, releaseBranchExists: boolean): BaseResult {
  const v = parseVersion(version);
  if (!v) return { ok: false, message: `\`${version}\` is not a version like v2.1.0`, nextAction: "Use a full version vMAJOR.MINOR.PATCH." };
  const releaseBranch = `release/${version}`;
  if (releaseBranchExists) return { ok: true, base: releaseBranch, reason: "release-branch", released };
  if (!released) return { ok: true, base: "main", reason: "no-release-yet" };
  if (v.major === released.major && v.minor === released.minor) return { ok: true, base: "main", reason: "patch-on-main", released };
  return {
    ok: false,
    released,
    message: `${version} is neither a patch of the released ${formatVersion(released)} nor a release with a branch (no \`${releaseBranch}\`)`,
    nextAction: `Create the release first with \`idc365-decisions release create ${version}\`, or use a ${released.major}.${released.minor}.x version for a patch on main.`,
  };
}
