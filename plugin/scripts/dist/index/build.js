import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPath, INVERSE_OF, isRecord, loadConfig, parseYaml, splitFrontmatter, TYPE_FOLDERS } from "../engine/index.js";
import { decideBase, highestVersion } from "../github/index.js";
import { INDEX_SCHEMA } from "./model.js";
const WORK_BRANCH_RE = /^(v[0-9]+\.[0-9]+\.[0-9]+)\/[^/].*$/;
const TRUTH_RE = /^(main|release\/v[0-9]+\.[0-9]+\.[0-9]+)$/;
export function localGit(root) {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const ref = (name) => {
        for (const candidate of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
            try {
                git("rev-parse", "--verify", "--quiet", candidate);
                return candidate;
            }
            catch {
                // try the next one
            }
        }
        return undefined;
    };
    return {
        head: () => git("rev-parse", "HEAD").trim(),
        latestCommits: () => {
            const out = new Map();
            let current;
            for (const line of git("log", "--format=%x00%H%x09%cI", "--name-only", "--", "docs", "code").split("\n")) {
                if (line.startsWith("\0")) {
                    const [sha, date] = line.slice(1).split("\t");
                    current = { sha: sha, date: date };
                }
                else if (line && current && !out.has(line))
                    out.set(line, current);
            }
            return out;
        },
        tags: () => git("tag", "--list", "v*").split("\n").filter(Boolean),
        branchExists: (name) => ref(name) !== undefined,
        releaseRefs: () => {
            const out = new Map();
            const refs = git("for-each-ref", "--format=%(refname)", "refs/remotes/origin/main", "refs/remotes/origin/release/", "refs/heads/main", "refs/heads/release/", "refs/tags/")
                .split("\n")
                .filter(Boolean);
            const names = new Map();
            for (const r of refs) {
                const name = r.replace(/^refs\/(remotes\/origin|heads|tags)\//, "");
                if (TRUTH_RE.test(name) || /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(name))
                    if (!names.has(name) || r.startsWith("refs/remotes/"))
                        names.set(name, r);
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
            if (!r)
                return new Set();
            return new Set(git("diff", "--name-only", `${r}...HEAD`, "--", "docs", "code").split("\n").filter(Boolean));
        },
    };
}
export function markdownFiles(root) {
    const out = [];
    const walk = (rel) => {
        const abs = join(root, rel);
        if (!existsSync(abs))
            return;
        for (const e of readdirSync(abs, { withFileTypes: true })) {
            if (e.name.startsWith("."))
                continue;
            const child = `${rel}/${e.name}`;
            if (e.isDirectory())
                walk(child);
            else if (e.name.endsWith(".md"))
                out.push(child);
        }
    };
    for (const folder of Object.keys(TYPE_FOLDERS))
        walk(`docs/${folder}`);
    walk("code");
    return out.sort();
}
const str = (v) => (typeof v === "string" ? v : null);
/** The base branch whose diff marks documents pending, or null. */
export function pendingBase(branch, git) {
    if (TRUTH_RE.test(branch))
        return null;
    const m = WORK_BRANCH_RE.exec(branch);
    if (!m)
        return null;
    const decision = decideBase(m[1], highestVersion(git.tags()), git.branchExists(`release/${m[1]}`));
    return decision.ok ? decision.base : null;
}
/**
 * Who merged the latest PR that touched the file. Bot commits (post-merge
 * edits) have no PR, so older commits of the file are tried, up to 10.
 */
async function mergedByFor(path, latest, git, lookup) {
    const shas = git.commitsFor ? git.commitsFor(path, 10) : [latest];
    for (const sha of shas.length ? shas : [latest]) {
        const who = await lookup(sha);
        if (who)
            return who;
    }
    return null;
}
/** Builds the index of the checkout at `root` (spec 6.2). */
export async function buildIndex(opts) {
    const { root, branch, git } = opts;
    const loaded = loadConfig(root);
    const config = loaded.config ?? { repositories: [] };
    const base = pendingBase(branch, git);
    const changed = base ? git.changedSince(base) : new Set();
    const commits = git.latestCommits();
    const releaseRefs = git.releaseRefs ? git.releaseRefs() : new Map();
    const skipped = [];
    const docs = [];
    for (const path of markdownFiles(root)) {
        const c = classifyPath(path, config);
        if (!c.type || !c.key) {
            skipped.push({ path, reason: c.findings[0]?.message ?? "not a document path" });
            continue;
        }
        const split = splitFrontmatter(readFileSync(join(root, path), "utf8"));
        let fm = {};
        try {
            const data = split ? parseYaml(split.frontmatter) : undefined;
            if (!isRecord(data))
                throw new Error("no frontmatter mapping");
            fm = data;
        }
        catch (err) {
            skipped.push({ path, reason: `frontmatter: ${err.message}` });
            continue;
        }
        const outgoing = (Array.isArray(fm.relations) ? fm.relations : [])
            // Inverse entries (written by the bot) only mirror forward relations; incoming is computed from those.
            .filter((r) => isRecord(r) && typeof r.target === "string" && !(String(r.type) in INVERSE_OF))
            .map((r) => ({ type: String(r.type), target: String(r.target), why: String(r.why ?? "") }));
        const commit = commits.get(path) ?? null;
        const file = path.split("/").pop();
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
        for (const r of d.relations.outgoing)
            byId.get(r.target)?.relations.incoming.push({ type: r.type, source: d.id, why: r.why });
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
