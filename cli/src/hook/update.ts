import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodePath, type GitHubClient } from "../github/index.js";
import { MARKETPLACE, PLUGIN_ID, PLUGIN_REF } from "./settings.js";

/**
 * Daily, cached check for a newer plugin version (spec 8.1, phase 10): the
 * installed plugin's `plugin.json` against the one on the marketplace branch
 * of the documentation repository, read with the documentation token. The
 * CLI never updates itself: the notice tells the agent to ask the user and
 * gives the exact commands. Background auto-update (on in the project
 * settings that `setup` writes) usually gets there first; the notice covers
 * users who turned it off.
 */

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PLUGIN_MANIFEST = "plugin/.claude-plugin/plugin.json";

/** npm-style version `X.Y.Z` (a pre-release or build suffix is ignored for the comparison). */
export function parseNpmVersion(text: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function newerThan(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export type ViewResult = { ok: true; version: string } | { ok: false; error: string };
/** Reads the latest published version; injected in tests. */
export type Viewer = () => Promise<ViewResult>;

/** The version in the plugin manifest on the marketplace branch. */
export function marketplaceViewer(client: GitHubClient): Viewer {
  return async () => {
    try {
      const res = await client.request<unknown>("GET", client.repoPath(`/contents/${encodePath(PLUGIN_MANIFEST)}`), { query: { ref: PLUGIN_REF }, accept: "application/vnd.github.raw+json", allow: [404] });
      if (res.status === 404) return { ok: false, error: `no plugin on \`${PLUGIN_REF}\`` };
      const data = (typeof res.data === "string" ? JSON.parse(res.data) : res.data) as { version?: unknown };
      return typeof data.version === "string" && parseNpmVersion(data.version) ? { ok: true, version: data.version } : { ok: false, error: "the plugin manifest has no version" };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };
}

/** The version of the plugin this CLI runs from, or undefined outside a plugin. */
export function installedPluginVersion(pluginRoot: string | undefined): string | undefined {
  if (!pluginRoot) return undefined;
  try {
    const v = (JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

interface UpdateCache {
  checkedAt: string;
  key: string;
  result: ViewResult;
}

export interface UpdateStatus {
  current: string;
  latest?: string;
  newer: boolean;
  error?: string;
  /** From the cache (checked less than a day ago). */
  cached: boolean;
  checkedAt: string;
}

/** Checks at most once a day per key (the documentation repository); never throws. */
export async function checkForUpdate(current: string, o: { dir: string; key: string; view: Viewer; now?: Date; force?: boolean }): Promise<UpdateStatus> {
  const now = o.now ?? new Date();
  const file = join(o.dir, "update-check.json");
  let cache: UpdateCache | undefined;
  try {
    cache = JSON.parse(readFileSync(file, "utf8")) as UpdateCache;
  } catch {
    cache = undefined;
  }
  const age = cache ? now.getTime() - Date.parse(cache.checkedAt) : NaN;
  const fresh = !o.force && !!cache && cache.key === o.key && age >= 0 && age < CHECK_INTERVAL_MS;
  let result: ViewResult;
  let checkedAt: string;
  if (fresh) {
    result = cache!.result;
    checkedAt = cache!.checkedAt;
  } else {
    result = await o.view().catch((e: Error) => ({ ok: false as const, error: e.message }));
    checkedAt = now.toISOString();
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ checkedAt, key: o.key, result } satisfies UpdateCache));
    } catch {
      // A read-only cache only means the check runs again next time.
    }
  }
  const cur = parseNpmVersion(current);
  const latest = result.ok ? parseNpmVersion(result.version) : undefined;
  return { current, latest: result.ok ? result.version : undefined, newer: !!cur && !!latest && newerThan(latest, cur), error: result.ok ? undefined : result.error, cached: fresh, checkedAt };
}

/** The notice for the agent, or undefined when the plugin is current. */
export function updateNotice(s: UpdateStatus): string | undefined {
  if (!s.newer) return undefined;
  return `A newer idc365-decisions plugin is available: ${s.latest} (installed ${s.current}). Ask the user for permission before updating; do not update on your own. The user updates in Claude Code with \`/plugin marketplace update ${MARKETPLACE}\`, then \`/reload-plugins\` (or in a terminal: \`claude plugin update ${PLUGIN_ID}\`, then restart).`;
}
