import { stringify } from "yaml";
import { CODE_KEY_RE, expandMacros, folderForPrefix, ID_KEY_RE, JIRA_KEY_RE, mergeRelations, referencedKeys, relativeLink, stripTargetDefinitions, } from "./macros.js";
/** Shadow document path for a CODE key; `folder` forces the `_.md` form. */
export function shadowPaths(key, folder = false) {
    const m = CODE_KEY_RE.exec(key);
    const rest = m[3].replace(/^\//, "");
    const base = `code/${m[1]}/${m[2]}`;
    if (!rest)
        return [`${base}/_.md`];
    return folder ? [`${base}/${rest}/_.md`] : [`${base}/${rest}.md`, `${base}/${rest}/_.md`];
}
/**
 * Resolves reference targets on the work branch first, then the base
 * (spec 4.2). Documents written in this same change count as existing.
 */
export class Resolver {
    repo;
    refs;
    config;
    pending;
    cache = new Map();
    /** Placeholder shadow documents to create in the same commit. */
    placeholders = new Map();
    constructor(repo, refs, config, 
    /** Files written in this change, by key. */
    pending = new Map()) {
        this.repo = repo;
        this.refs = refs;
        this.config = config;
        this.pending = pending;
    }
    resolve(key, folder = false) {
        if (!this.cache.has(key))
            this.cache.set(key, this.lookup(key, folder));
        return this.cache.get(key);
    }
    async lookup(key, folder) {
        const own = this.pending.get(key);
        if (own)
            return { kind: "file", key, file: own, placeholder: false };
        const id = ID_KEY_RE.exec(key);
        if (id) {
            const hit = await this.repo.findNumbered(folderForPrefix(id[1]), id[2], this.refs);
            if (!hit)
                return { message: `\`${key}\` does not exist on ${this.refs.join(" or ")}`, nextAction: `Check the ID with \`idc365-decisions ${nounFor(id[1])} list\`.` };
            return { kind: "file", key, file: hit.file, placeholder: false };
        }
        const jira = JIRA_KEY_RE.exec(key);
        if (jira) {
            if (!this.config.jira_base_url)
                return { message: `\`${key}\`: no Jira base URL is configured`, nextAction: "Ask the user to set `jira_base_url` in config/jira.yaml via PR, or remove the Jira reference." };
            return { kind: "url", key, url: `${this.config.jira_base_url}${jira[1]}` };
        }
        const code = CODE_KEY_RE.exec(key);
        if (code) {
            const repo = `${code[1]}/${code[2]}`;
            if (!this.config.repositories.includes(repo))
                return { message: `\`${key}\`: repository \`${repo}\` is not configured`, nextAction: "Ask the user to add it to `repositories` in config/repositories.yaml via PR." };
            const paths = shadowPaths(key, folder);
            const hit = await this.repo.findFirst(paths, this.refs);
            if (hit)
                return { kind: "file", key, file: hit.file, placeholder: false };
            this.placeholders.set(key, paths[0]);
            return { kind: "file", key, file: paths[0], placeholder: true };
        }
        if (/^https?:\/\//.test(key))
            return { kind: "url", key, url: key };
        return { message: `\`${key}\` is not a reference target`, nextAction: "Use an ID like ADR-0042, CODE:org/repo/path, JIRA:KEY-1 or a URL." };
    }
}
function nounFor(prefix) {
    return { ADR: "adr", PROC: "proc", TECH: "tech", REL: "release", ATT: "att" }[prefix] ?? prefix.toLowerCase();
}
/**
 * Expands macros, refreshes every relation link and reference definition
 * from the current resolution, and renders the file.
 */
export async function compose(input, resolver) {
    const problems = [];
    const expanded = expandMacros(input.body);
    problems.push(...expanded.errors.map((e) => ({ message: e.message, nextAction: e.nextAction })));
    const added = [];
    for (const m of expanded.macros) {
        const r = await resolver.resolve(m.key, m.folder);
        if ("message" in r) {
            problems.push(r);
            continue;
        }
        added.push({ type: m.type, target: m.key, why: m.why, link: r.kind === "file" ? relativeLink(input.file, r.file) : r.url });
    }
    // Refresh links of existing relations; keep external URLs as they are.
    const existing = [];
    for (const rel of input.relations) {
        if (/^https?:\/\//.test(rel.target)) {
            existing.push(rel);
            continue;
        }
        const r = await resolver.resolve(rel.target);
        if ("message" in r)
            problems.push(r);
        existing.push({ ...rel, link: "message" in r ? rel.link : r.kind === "file" ? relativeLink(input.file, r.file) : r.url });
    }
    const relations = mergeRelations(existing, added);
    let body = stripTargetDefinitions(expanded.body);
    const defs = [];
    for (const key of referencedKeys(body)) {
        const r = await resolver.resolve(key);
        if ("message" in r) {
            problems.push(r);
            continue;
        }
        defs.push(`[${key}]: ${r.kind === "file" ? relativeLink(input.file, r.file) : r.url}`);
    }
    if (defs.length)
        body = `${body.replace(/\n+$/, "")}\n\n${defs.join("\n")}\n`;
    const known = [];
    for (const key of new Set([...relations.map((r) => r.target), ...referencedKeys(body)])) {
        const r = await resolver.resolve(key);
        if (!("message" in r) && r.kind === "file")
            known.push({ file: r.file, key });
    }
    const unique = [...new Map(problems.map((p) => [p.message, p])).values()];
    problems.length = 0;
    problems.push(...unique);
    const fm = { ...input.fields };
    if (relations.length)
        fm.relations = relations;
    return { text: renderDocument(fm, body), relations, known, problems };
}
export function renderDocument(frontmatter, body) {
    const clean = Object.fromEntries(Object.entries(frontmatter).filter(([, v]) => v !== undefined));
    const yaml = stringify(clean, { lineWidth: 0 });
    return `---\n${yaml}---\n${body.replace(/^\n+/, "")}`;
}
/** A placeholder shadow document (spec 5.6): only `placeholder` and `relations`. */
export function placeholderDocument() {
    return renderDocument({ placeholder: true, relations: [] }, "");
}
