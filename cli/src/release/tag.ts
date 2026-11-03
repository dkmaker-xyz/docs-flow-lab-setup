import { DocRepo } from "../docs/docrepo.js";
import type { Refusal } from "../docs/write.js";
import { validateDocuments } from "../engine/index.js";
import { compareVersions, createBranchWithCommit, formatVersion, GitHubError, highestVersion, openPullRequest, parseVersion, type FileChange, type GitHubClient } from "../github/index.js";
import { applyEdit, type Edit } from "../postmerge/postmerge.js";
import { listRels, tagNames } from "./release.js";

export interface RecordResult {
  ok: true;
  version: string;
  kind: "release" | "patch";
  /** REL set to released (release), or the production REL the patch is added to. */
  rel: string;
  retired: string[];
  branch: string;
  commit: string;
  pr: { number: number; url: string };
}

const refuse = (message: string, nextAction: string): Refusal => ({ ok: false, message, nextAction });

/**
 * `release tag vX.Y.Z` (spec 5.4, 7.2, Question IBY2vKDsoZUi): records a
 * deployed version in the REL documents through a small PR to main. The
 * human approves by merging; after the merge the post-merge bot creates the
 * tag on the merge commit. The CLI never creates tags or starts workflows.
 * - A planned release with its own REL: that REL gets `phase: released` and
 *   `released_date`; the previously released REL gets `retired`.
 * - A patch without its own REL: the version is appended to `patches` of the
 *   production REL (the one with `phase: released`), which must have the
 *   same major.minor.
 */
export async function recordRelease(client: GitHubClient, version: string, today = new Date().toISOString().slice(0, 10)): Promise<RecordResult | Refusal> {
  const v = parseVersion(version);
  if (!v) return refuse(`\`${version}\` is not a version like v1.2.0`, "Use a full version vMAJOR.MINOR.PATCH.");
  const highest = highestVersion(await tagNames(client));
  if (highest && compareVersions(v, highest) <= 0) return refuse(`${version} is not higher than the highest tag ${formatVersion(highest)}`, "Record a higher version.");
  const repo = new DocRepo(client);
  const rels = await listRels(client, "main", repo);
  const own = rels.find((r) => r.version === version);
  const production = rels.find((r) => r.phase === "released");
  const edits: Edit[] = [];
  let kind: RecordResult["kind"];
  let relId: string;
  if (own) {
    if (own.phase === "released" || own.phase === "retired") return refuse(`${own.id} (${version}) is already ${own.phase}`, "Nothing to record.");
    kind = "release";
    relId = own.id;
    edits.push({ file: own.file, key: own.id, add: [], set: { phase: "released", released_date: today }, reasons: ["released"] });
    for (const r of rels) if (r.id !== own.id && r.phase === "released") edits.push({ file: r.file, key: r.id, add: [], set: { phase: "retired" }, reasons: ["retired"] });
  } else {
    const pv = production ? parseVersion(production.version) : undefined;
    if (!production || !pv) {
      return refuse(`${version} has no release document and no release is in production (phase released) to add it to as a patch`, `For a new release, create it first with \`idc365-decisions release create ${version}\`.`);
    }
    if (pv.major !== v.major || pv.minor !== v.minor) {
      return refuse(`${version} has no release document and is not a patch of the production release ${production.version} (${production.id})`, `Create the release first with \`idc365-decisions release create ${version}\`.`);
    }
    kind = "patch";
    relId = production.id;
    const patches = Array.isArray(production.fm.patches) ? (production.fm.patches as string[]) : [];
    edits.push({ file: production.file, key: production.id, add: [], set: { patches: [...patches, version] }, reasons: [`patch ${version}`] });
  }

  const head = (await client.request<{ object: { sha: string } }>("GET", client.repoPath("/git/ref/heads/main"))).data.object.sha;
  const changes: FileChange[] = [];
  for (const e of edits) {
    const text = (await repo.text(e.file, head)) ?? "";
    changes.push({ path: e.file, content: applyEdit(text, e) });
  }
  const { config, findings } = await repo.config(head);
  const invalid = config ? validateDocuments(config, changes.map((c) => ({ file: c.path, text: String(c.content) }))) : findings;
  const own_ = invalid.filter((f) => !["relation.target", "link.path", "link.relation"].includes(f.rule));
  if (own_.length) return { ok: false, message: "the release record would not validate; nothing was written", nextAction: "Fix the REL documents via PR first.", findings: own_ };

  const branch = `${version}/release-${version.replace(/\./g, "-")}`;
  const summary = kind === "release" ? `Release ${version}: ${relId} released${edits.length > 1 ? `, ${edits.slice(1).map((e) => e.key).join(", ")} retired` : ""}` : `Release ${version}: patch of ${relId}`;
  let commit: string;
  try {
    commit = (await createBranchWithCommit(client, branch, "main", changes, summary)).sha;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 422) return refuse(`\`${branch}\` already exists: ${version} is already being recorded`, "Ask the user to review and merge the open release PR.");
    throw err;
  }
  const pr = await openPullRequest(
    client,
    branch,
    "main",
    summary,
    [
      `Records that ${version} has been deployed, written by the idc365-decisions CLI.`,
      "",
      ...edits.map((e) => `- ${e.key}: ${e.reasons.join(", ")}`),
      "",
      `Merge this PR when ${version} is deployed. After the merge the bot creates the tag \`${version}\` on the merge commit. The CLI never merges.`,
    ].join("\n"),
  );
  return { ok: true, version, kind, rel: relId, retired: edits.filter((e) => e.set?.phase === "retired").map((e) => e.key), branch, commit, pr: { number: pr.number, url: pr.url } };
}
