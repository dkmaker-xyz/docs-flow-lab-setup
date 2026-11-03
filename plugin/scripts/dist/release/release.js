import { execFileSync } from "node:child_process";
import { DocRepo } from "../docs/docrepo.js";
import { findGitRoot, originRepository } from "../docs/gitrepo.js";
import { KINDS } from "../docs/kinds.js";
import { createDocument, normaliseId, updateDocument } from "../docs/write.js";
import { isRecord, parseYaml, splitFrontmatter } from "../engine/index.js";
import { compareVersions, formatVersion, highestVersion, parseVersion } from "../github/index.js";
const refuse = (message, nextAction) => ({ ok: false, message, nextAction });
export function parseRel(file, text) {
    const split = splitFrontmatter(text);
    if (!split)
        return undefined;
    let fm;
    try {
        fm = parseYaml(split.frontmatter);
    }
    catch {
        return undefined;
    }
    if (!isRecord(fm) || typeof fm.id !== "string")
        return undefined;
    const code = (Array.isArray(fm.code) ? fm.code : []).filter((c) => isRecord(c) && typeof c.repo === "string" && typeof c.branch === "string");
    return { id: fm.id, file, title: String(fm.title ?? ""), version: String(fm.version ?? ""), phase: String(fm.phase ?? ""), docsBranch: String(fm.docs_branch ?? ""), code, fm };
}
/** Every REL in docs/release at a ref. */
export async function listRels(client, ref = "main", repo = new DocRepo(client)) {
    const entries = ((await repo.folder("docs/release", ref)) ?? []).filter((e) => e.type === "file" && /^[0-9]{4,}-.+\.md$/.test(e.name));
    const texts = await Promise.all(entries.map((e) => repo.text(e.path, ref)));
    const rels = entries.map((e, i) => parseRel(e.path, texts[i] ?? "")).filter((r) => !!r);
    return rels.sort((a, b) => a.id.localeCompare(b.id));
}
/** All v* tag names. */
export async function tagNames(client) {
    const res = await client.request("GET", client.repoPath("/git/matching-refs/tags/v"));
    return res.data.map((r) => r.ref.replace(/^refs\/tags\//, ""));
}
/**
 * `release create vX.Y.Z` (spec 5.4, 7.2 step 1): the REL with phase
 * planned on a work branch, in a PR to main. Refuses a version that already
 * has a REL or is not higher than the released version.
 */
export async function createRelease(client, version, o = {}) {
    const v = parseVersion(version);
    if (!v)
        return refuse(`\`${version}\` is not a version like v1.2.0`, "Use a full version vMAJOR.MINOR.PATCH.");
    const released = highestVersion(await tagNames(client));
    if (released && compareVersions(v, released) <= 0) {
        return refuse(`${version} is not higher than the released ${formatVersion(released)}`, `Create a release with a version above ${formatVersion(released)}.`);
    }
    const existing = (await listRels(client, "main")).find((r) => r.version === version);
    if (existing)
        return refuse(`${version} already has a release document: ${existing.id}`, `Show it with \`idc365-decisions release show ${existing.id}\`.`);
    const body = o.body ?? `## Scope\n\nRelease ${version} of the product.\n`;
    return createDocument(client, KINDS.release, {
        title: o.title ?? `Release ${version}`,
        description: o.description ?? `Documentation for product release ${version}.`,
        intent: o.intent ?? `What release ${version} is and where its documentation and code live.`,
        when: o.when ?? `When you work on ${version}.`,
        state: "accepted",
        extra: {
            version,
            phase: "planned",
            docs_branch: `release/${version}`,
            ...(o.code?.length ? { code: o.code.map((c) => ({ repo: c.repo, branch: c.branch })) } : {}),
            ...(o.jiraFixVersion ? { jira_fix_version: o.jiraFixVersion } : {}),
            ...(o.plannedDate ? { planned_date: o.plannedDate } : {}),
        },
    }, body, { version, base: "main" });
}
/** `release map --repo --branch <REL-ID>`: adds or updates the REL's mapping for one code repository via PR. */
export async function mapRelease(client, relInput, repo, branch) {
    const id = normaliseId(KINDS.release, relInput);
    if (!id)
        return refuse(`\`${relInput}\` is not a REL ID`, "Pass an ID like REL-0001.");
    const rel = (await listRels(client, "main")).find((r) => r.id === id);
    if (!rel)
        return refuse(`${id} does not exist on main`, "List the releases with `idc365-decisions release list`.");
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo))
        return refuse(`\`${repo}\` is not org/repo`, "Pass --repo org/repo.");
    const code = rel.code.filter((c) => c.repo !== repo).concat([{ repo, branch }]).map((c) => ({ ...c }));
    const same = rel.code.find((c) => c.repo === repo);
    if (same?.branch === branch)
        return refuse(`${id} already maps ${repo} to \`${branch}\``, "Nothing to change.");
    return updateDocument(client, KINDS.release, id, { extra: { code } }, undefined, { version: rel.version, base: "main" });
}
/** `release for vX.Y.Z`: the docs tag that applies to a product version: the highest tag ≤ it (spec 7.1). */
export function docsTagFor(version, tags) {
    let best;
    for (const t of tags) {
        const v = parseVersion(t);
        if (v && compareVersions(v, version) <= 0 && (!best || compareVersions(v, best) > 0))
            best = v;
    }
    return best ? formatVersion(best) : undefined;
}
function git(root, ...args) {
    try {
        return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch {
        return undefined;
    }
}
/** The commit a local or remote-tracking branch points at. */
function tip(root, branch) {
    return git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`) ?? git(root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`);
}
/** The default branch of the code repository: origin/HEAD, else main or master. */
function defaultBranch(root) {
    const head = git(root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
    if (head)
        return head.replace("refs/remotes/origin/", "");
    return ["main", "master"].find((b) => tip(root, b));
}
/**
 * `release current` (spec 7.3), inside a code repository:
 * 1. the current branch is mapped in a REL → that release;
 * 2. otherwise, if it descends from exactly one mapped branch → inherited;
 *    "descends" means the merge base with the mapped branch is a commit of
 *    that branch that the default branch does not have (so a branch from the
 *    default branch never inherits a release branch);
 * 3. otherwise orphaned; the next action suggests `release map`.
 */
export async function currentRelease(client, cwd, rels) {
    const root = findGitRoot(cwd);
    const orphan = (message, nextAction, extra = {}) => ({ ok: false, orphaned: true, candidates: [], message, nextAction, ...extra });
    if (!root)
        return orphan("not inside a git repository", "Run the command inside a code repository.");
    const repo = originRepository(root);
    if (!repo)
        return orphan("the `origin` remote is not a GitHub repository", "Run the command in a clone of a GitHub code repository.");
    const branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD");
    if (!branch)
        return orphan("HEAD is detached, so there is no current branch", "Check out a branch and run the command again.", { repo });
    const all = (rels ?? (await listRels(client, "main"))).filter((r) => r.phase !== "retired");
    const mapped = all.flatMap((rel) => rel.code.filter((c) => c.repo === repo).map((c) => ({ rel, branch: c.branch })));
    const result = async (how, rel, mappedBranch) => {
        const docsBranch = rel.docsBranch || "main";
        const exists = (await new DocRepo(client).exists(docsBranch)) || docsBranch === "main";
        return { ok: true, how, rel, repo, branch, mappedBranch, docsBranch: exists ? docsBranch : "main", docsBranchExists: exists };
    };
    const direct = mapped.filter((m) => m.branch === branch);
    if (direct.length === 1)
        return result("direct", direct[0].rel, branch);
    if (direct.length > 1) {
        return orphan(`\`${branch}\` is mapped by more than one release: ${direct.map((d) => d.rel.id).join(", ")}`, "Ask the user which release applies, and correct the mappings with `release map`.", { repo, branch, candidates: direct.map((d) => d.rel.id) });
    }
    const head = git(root, "rev-parse", "HEAD");
    const def = defaultBranch(root);
    const defTip = def ? tip(root, def) : undefined;
    const parents = mapped.filter((m) => {
        const t = tip(root, m.branch);
        if (!t)
            return false;
        const base = git(root, "merge-base", head, t);
        if (!base)
            return false;
        if (m.branch === def)
            return true;
        // The shared commit must be on the mapped branch only, not on the default branch.
        return !(defTip && git(root, "merge-base", "--is-ancestor", base, defTip) !== undefined);
    });
    const unique = [...new Map(parents.map((p) => [`${p.rel.id}:${p.branch}`, p])).values()];
    if (unique.length === 1)
        return result("inherited", unique[0].rel, unique[0].branch);
    const list = all.map((r) => r.id).join(", ") || "none yet";
    if (unique.length > 1) {
        return orphan(`\`${branch}\` descends from several mapped branches: ${unique.map((u) => `${u.branch} (${u.rel.id})`).join(", ")}`, `Ask the user which release applies, then map the branch with \`idc365-decisions release map --repo ${repo} --branch ${branch} <REL-ID>\`.`, { repo, branch, candidates: unique.map((u) => u.rel.id) });
    }
    return orphan(`\`${branch}\` in ${repo} is not mapped to a release and does not descend from a mapped branch`, `Ask the user which release this branch belongs to (releases: ${list}), then map it with \`idc365-decisions release map --repo ${repo} --branch ${branch} <REL-ID>\`. Do not guess.`, { repo, branch });
}
