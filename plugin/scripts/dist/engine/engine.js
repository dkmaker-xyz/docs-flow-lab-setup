import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix, resolve, join } from "node:path";
import { loadConfig } from "./config.js";
import { findMacros, isExternalUrl, scanLinks, splitFrontmatter } from "./markdown.js";
import { INSTRUCTIONS_FILE, SAMPLE_VARS, charCount, composeInstructions, placeholderProblems, primingFeatured } from "./priming.js";
import { validateFrontmatter } from "./schemas.js";
import { isRecord, parseYaml } from "./yaml.js";
/** Typed folders under docs/ and their ID prefix (spec 3.1). */
export const TYPE_FOLDERS = {
    adr: { type: "adr", prefix: "ADR" },
    procedure: { type: "procedure", prefix: "PROC" },
    techstack: { type: "techstack", prefix: "TECH" },
    release: { type: "release", prefix: "REL" },
    attachment: { type: "attachment", prefix: "ATT" },
};
const CATEGORY_TYPES = new Set(["adr", "procedure", "techstack"]);
/** Inverse relation type -> the forward type it mirrors (spec 4.3). relates-to is its own inverse and not checked. */
export const INVERSE_OF = {
    "superseded-by": "supersedes",
    "amended-by": "amends",
    "depended-on-by": "depends-on",
    "implemented-by": "implements",
    "used-by": "uses",
    "attached-to": "attachment",
};
const FILE_RE = /^([0-9]{4,})-(.*)$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_TARGET_RE = /^(ADR|PROC|TECH|REL|ATT)-[0-9]{4,}$/;
const CODE_TARGET_RE = /^CODE:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(\/\S+)?$/;
const JIRA_TARGET_RE = /^JIRA:[A-Z][A-Z0-9_]*-[0-9]+$/;
class Collector {
    findings = [];
    add(file, rule, message, nextAction) {
        this.findings.push({ file, rule, message, nextAction });
    }
}
function listDir(abs) {
    return readdirSync(abs, { withFileTypes: true })
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
/** Validates the documentation tree at `rootPath` against its own config/. */
export function validateTree(rootPath) {
    const root = resolve(rootPath);
    const { config, findings: configFindings } = loadConfig(root);
    if (!config)
        return { root, documents: 0, findings: configFindings, notes: [] };
    const out = new Collector();
    const docs = [];
    const binaries = [];
    walkDocs(root, out, docs, binaries);
    walkCode(root, config, out, docs);
    const registry = new Map();
    for (const doc of docs) {
        readDocument(root, config, doc, out);
        if (!doc.key)
            continue;
        const first = registry.get(doc.key);
        if (first) {
            out.add(doc.file, "id.duplicate", `${doc.key} is also used by ${first.file}`, "Keep one document per ID; the CLI allocates a new ID for the other.");
            out.add(first.file, "id.duplicate", `${doc.key} is also used by ${doc.file}`, "Keep one document per ID; the CLI allocates a new ID for the other.");
        }
        else
            registry.set(doc.key, doc);
    }
    for (const doc of docs) {
        checkRelationsAndLinks(config, doc, registry, out);
        checkInverses(doc, registry, out);
        checkMacros(doc, out);
        checkReleaseRepos(config, doc, out);
    }
    checkAttachments(root, config, docs, binaries, out);
    const primingNote = checkPriming(root, config, docs, out);
    const findings = out.findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
    return { root, documents: docs.length, findings, notes: [...(primingNote ? [primingNote] : []), ...attachmentNotes(docs, registry)] };
}
function walkDocs(root, out, docs, binaries) {
    const docsAbs = join(root, "docs");
    if (!existsSync(docsAbs))
        return;
    for (const entry of listDir(docsAbs)) {
        const rel = `docs/${entry.name}`;
        const folder = TYPE_FOLDERS[entry.name];
        if (!entry.dir || !folder) {
            out.add(rel, "path.layout", `unexpected ${entry.dir ? "folder" : "file"} in docs/`, `Only ${Object.keys(TYPE_FOLDERS).map((f) => `docs/${f}/`).join(", ")} belong in docs/; move or remove it.`);
            continue;
        }
        for (const file of listDir(join(docsAbs, entry.name))) {
            const frel = `${rel}/${file.name}`;
            if (file.dir) {
                out.add(frel, "path.layout", "sub-folders are not allowed in a type folder", `Move its documents directly into ${rel}/.`);
                continue;
            }
            const dot = file.name.lastIndexOf(".");
            const ext = dot > 0 ? file.name.slice(dot + 1) : "";
            const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
            const m = FILE_RE.exec(stem);
            if (ext !== "md" && folder.type !== "attachment") {
                out.add(frel, "path.layout", "only .md documents belong in this folder", "Remove the file, or store it as an attachment under docs/attachment/.");
                continue;
            }
            if (!m) {
                out.add(frel, "path.layout", `file name must be NNNN-<slug>.${ext || "md"} (number of at least 4 digits)`, "Rename the file to <number>-<slug> with the number of its ID.");
                if (ext === "md")
                    docs.push({ file: frel, type: folder.type });
                continue;
            }
            if (!SLUG_RE.test(m[2])) {
                out.add(frel, "path.slug", `slug \`${m[2]}\` must be lowercase letters and digits separated by single hyphens`, "Rename the file with a slug like `my-decision-title`.");
            }
            if (ext === "md")
                docs.push({ file: frel, type: folder.type, key: `${folder.prefix}-${m[1]}` });
            else
                binaries.push({ file: frel, stem, ext: ext.toLowerCase() });
        }
    }
}
function walkCode(root, config, out, docs) {
    const codeAbs = join(root, "code");
    if (!existsSync(codeAbs))
        return;
    const walk = (abs, segs) => {
        for (const e of listDir(abs)) {
            const next = [...segs, e.name];
            if (e.dir) {
                walk(join(abs, e.name), next);
                continue;
            }
            const rel = `code/${next.join("/")}`;
            if (!e.name.endsWith(".md")) {
                out.add(rel, "shadow.path", "only .md shadow documents belong under code/", "Remove the file; code itself lives in its own repository.");
                continue;
            }
            if (next.length < 3) {
                out.add(rel, "shadow.path", "shadow documents must be code/<org>/<repo>/<path>.md or code/<org>/<repo>/<dir>/_.md", "Move the file under its org and repository folder.");
                docs.push({ file: rel, type: "shadow" });
                continue;
            }
            const [org, repo, ...rest] = next;
            const repoId = `${org}/${repo}`;
            if (!config.repositories.includes(repoId)) {
                out.add(rel, "shadow.repo", `repository \`${repoId}\` is not configured`, "Add it to `repositories` in config/repositories.yaml via PR, or move the document.");
            }
            const last = rest[rest.length - 1];
            const codePath = last === "_.md" ? rest.slice(0, -1) : [...rest.slice(0, -1), last.slice(0, -3)];
            docs.push({ file: rel, type: "shadow", key: `CODE:${[repoId, ...codePath].join("/")}` });
        }
    };
    walk(codeAbs, []);
}
function readDocument(root, config, doc, out) {
    parseDocument(config, doc, readFileSync(join(root, doc.file), "utf8"), out);
}
function parseDocument(config, doc, text, out) {
    const split = splitFrontmatter(text);
    if (!split) {
        out.add(doc.file, "frontmatter.parse", "no YAML frontmatter: the file must start with `---`, the YAML, and `---`", "Add the frontmatter block for this document type.");
        return;
    }
    let data;
    try {
        data = parseYaml(split.frontmatter);
    }
    catch (err) {
        out.add(doc.file, "frontmatter.parse", `frontmatter YAML does not parse: ${err.message}`, "Fix the YAML syntax in the frontmatter.");
        return;
    }
    if (!isRecord(data)) {
        out.add(doc.file, "frontmatter.parse", "frontmatter must be a YAML mapping", "Write the frontmatter as `field: value` lines.");
        return;
    }
    doc.frontmatter = data;
    doc.body = split.body;
    for (const e of validateFrontmatter(doc.type, data)) {
        if (e.missingWhy || /^relations\[\d+\]\.why$/.test(e.path)) {
            out.add(doc.file, "relation.why", `${e.path.replace(/\.why$/, "")} has no \`why\``, "Add a `why` that says why the relation exists.");
        }
        else {
            out.add(doc.file, "frontmatter.schema", e.message, e.fix);
        }
    }
    if (doc.key && doc.type !== "shadow" && typeof data.id === "string" && data.id !== doc.key) {
        out.add(doc.file, "path.id-mismatch", `id \`${data.id}\` does not match the file, which implies \`${doc.key}\``, "Never change an ID: rename the file to match the id, or correct the id to match the file.");
    }
    if (CATEGORY_TYPES.has(doc.type) && typeof data.category === "string") {
        const list = config.categories[doc.type];
        if (!Object.hasOwn(list, data.category)) {
            out.add(doc.file, "category.unknown", `category \`${data.category}\` is not configured for ${doc.type}`, `Use one of: ${Object.keys(list).join(", ")}.`);
        }
    }
}
function relationsOf(doc) {
    const rel = doc.frontmatter?.relations;
    if (!Array.isArray(rel))
        return [];
    return rel.filter((r) => isRecord(r) && typeof r.target === "string");
}
/** Resolves a relative link from a document to a tree path (posix, no anchor). */
function resolveLink(from, url) {
    const path = url.split("#")[0];
    return posix.normalize(posix.join(posix.dirname(from), path));
}
function relativeLink(from, to) {
    return posix.relative(posix.dirname(from), to);
}
function checkRelationsAndLinks(config, doc, registry, out) {
    if (!doc.frontmatter || doc.body === undefined)
        return;
    const relations = relationsOf(doc);
    const targets = new Set();
    relations.forEach((r, i) => {
        const at = `relations[${i}]`;
        targets.add(r.target.toLowerCase());
        if (r.type === "attachment" && !r.target.startsWith("ATT-")) {
            out.add(doc.file, "relation.target", `${at}: type \`attachment\` needs an ATT target, not \`${r.target}\``, "Point the relation at the attachment ID, or use another relation type.");
        }
        if (ID_TARGET_RE.test(r.target) || CODE_TARGET_RE.test(r.target)) {
            const target = registry.get(r.target);
            if (!target) {
                out.add(doc.file, "relation.target", `${at}: target \`${r.target}\` does not exist in the tree`, "Correct the target, or remove the relation.");
            }
            else if (typeof r.link === "string" && resolveLink(doc.file, r.link) !== target.file) {
                out.add(doc.file, "link.path", `${at}: link \`${r.link}\` does not resolve to ${target.file}`, `Set link to \`${relativeLink(doc.file, target.file)}\`.`);
            }
        }
        else if (JIRA_TARGET_RE.test(r.target)) {
            if (config.jira_base_url === null) {
                out.add(doc.file, "relation.target", `${at}: Jira target \`${r.target}\` but no Jira base URL is configured`, "Set `jira_base_url` in config/jira.yaml via PR.");
            }
        }
        // Other targets are http(s) URLs (checked by the schema) and not validated further.
    });
    const scan = scanLinks(doc.body);
    const defined = new Map(scan.definitions.map((d) => [d.key, d]));
    for (const ref of scan.references) {
        if (!defined.has(ref.key)) {
            out.add(doc.file, "link.undefined", `reference \`[${ref.label}]\` has no definition`, `Add \`[${ref.label}]: <path>\` at the bottom, or write the reference as a macro so the CLI expands it.`);
        }
    }
    for (const url of scan.inline) {
        if (url === "" || url.startsWith("#") || isExternalUrl(url))
            continue;
        out.add(doc.file, "link.inline", `internal link \`${url}\` is inline; internal links must be reference-style`, "Write the reference as a macro (for example `{{ADR:0042|relates-to|<why>}}`) so the CLI writes the link and relation.");
    }
    for (const def of scan.definitions) {
        if (isExternalUrl(def.url))
            continue;
        const label = def.label.trim();
        if (!ID_TARGET_RE.test(label) && !CODE_TARGET_RE.test(label)) {
            out.add(doc.file, "link.relation", `internal link \`[${label}]\` is not labelled with a document ID or CODE:org/repo/path`, "Label internal links with the target ID, for example `[ADR-0042]`.");
            continue;
        }
        if (!targets.has(label.toLowerCase())) {
            out.add(doc.file, "link.relation", `link \`[${label}]\` has no matching entry in \`relations\``, `Add a relation with target \`${label}\`, a type and a \`why\`.`);
        }
        const target = registry.get(label);
        if (!target) {
            out.add(doc.file, "link.path", `link \`[${label}]\` points to a document that does not exist`, "Correct the reference, or remove it.");
        }
        else if (resolveLink(doc.file, def.url) !== target.file) {
            out.add(doc.file, "link.path", `link \`[${label}]: ${def.url}\` does not resolve to ${target.file}`, `Change the definition to \`[${label}]: ${relativeLink(doc.file, target.file)}\`.`);
        }
    }
}
function checkInverses(doc, registry, out) {
    relationsOf(doc).forEach((r, i) => {
        const forward = INVERSE_OF[r.type];
        if (!forward)
            return;
        const at = `relations[${i}]`;
        if (!ID_TARGET_RE.test(r.target) && !CODE_TARGET_RE.test(r.target)) {
            out.add(doc.file, "relation.inverse", `${at}: inverse type \`${r.type}\` must point to a document, not \`${r.target}\``, "Remove the entry; inverse relations only mirror relations between documents.");
            return;
        }
        const target = registry.get(r.target);
        if (!target?.frontmatter)
            return; // missing: relation.target; unreadable or unknown relations: not checkable
        const mirrored = relationsOf(target).some((t) => t.type === forward && t.target === doc.key);
        if (!mirrored) {
            out.add(doc.file, "relation.inverse", `${at}: \`${r.type} ${r.target}\` has no matching \`${forward} ${doc.key ?? doc.file}\` in ${target.file}`, `Remove the entry, or add the \`${forward}\` relation to ${target.file}; inverse types are written by the bot only.`);
        }
    });
}
function checkMacros(doc, out) {
    if (doc.body === undefined)
        return;
    for (const macro of new Set(findMacros(doc.body))) {
        out.add(doc.file, "macro.unexpanded", `macro \`${macro}\` was not expanded`, "Write the document through the CLI so it expands the macro into a link and relation.");
    }
}
function checkReleaseRepos(config, doc, out) {
    if (doc.type !== "release" || !Array.isArray(doc.frontmatter?.code))
        return;
    doc.frontmatter.code.forEach((c, i) => {
        if (!isRecord(c) || typeof c.repo !== "string")
            return;
        if (!config.repositories.includes(c.repo)) {
            out.add(doc.file, "release.repo", `code[${i}].repo \`${c.repo}\` is not a configured repository`, "Add it to `repositories` in config/repositories.yaml via PR, or correct the repository.");
        }
    });
}
/** Size and hash of the real content: from the Git LFS pointer when the file is one. */
function binaryFacts(abs) {
    const stat = statSync(abs);
    if (stat.size < 1024) {
        const text = readFileSync(abs, "utf8");
        const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text);
        const size = /^size ([0-9]+)$/m.exec(text);
        if (text.startsWith("version https://git-lfs.github.com/spec/v1") && oid && size) {
            return { size: Number(size[1]), sha256: oid[1] };
        }
    }
    return { size: stat.size, sha256: createHash("sha256").update(readFileSync(abs)).digest("hex") };
}
function checkAttachments(root, config, docs, binaries, out) {
    const metas = new Map();
    for (const d of docs) {
        if (d.type === "attachment")
            metas.set(posix.basename(d.file, ".md"), d);
    }
    const byStem = new Map();
    for (const b of binaries)
        byStem.set(b.stem, [...(byStem.get(b.stem) ?? []), b]);
    for (const [stem, list] of byStem) {
        if (!metas.has(stem)) {
            for (const b of list)
                out.add(b.file, "attachment.pair", `binary has no metadata file docs/attachment/${stem}.md`, "Add the metadata .md next to the binary.");
        }
        if (list.length > 1) {
            for (const b of list)
                out.add(b.file, "attachment.pair", `more than one binary for ${stem}: ${list.map((x) => x.ext).join(", ")}`, "Keep exactly one binary per attachment; a new version is a new attachment.");
        }
        for (const b of list) {
            const mediaType = config.attachment_types[b.ext];
            if (!mediaType) {
                out.add(b.file, "attachment.type", `extension \`.${b.ext}\` is not allowed`, `Use one of: ${Object.keys(config.attachment_types).join(", ")}.`);
            }
            const facts = binaryFacts(join(root, b.file));
            if (facts.size > config.attachment_max_bytes) {
                out.add(b.file, "attachment.size", `binary is ${facts.size} bytes; the maximum is ${config.attachment_max_bytes}`, "Reduce the file size or split it.");
            }
            const meta = metas.get(stem)?.frontmatter;
            if (!meta || list.length > 1)
                continue;
            const metaFile = metas.get(stem).file;
            if (mediaType && meta.media_type !== undefined && meta.media_type !== mediaType) {
                out.add(metaFile, "attachment.metadata", `media_type \`${String(meta.media_type)}\` does not match .${b.ext} (${mediaType})`, `Set media_type to \`${mediaType}\`.`);
            }
            if (meta.size !== undefined && meta.size !== facts.size) {
                out.add(metaFile, "attachment.metadata", `size ${String(meta.size)} does not match the binary (${facts.size} bytes)`, `Set size to ${facts.size}.`);
            }
            if (meta.sha256 !== undefined && meta.sha256 !== facts.sha256) {
                out.add(metaFile, "attachment.metadata", "sha256 does not match the binary", `Set sha256 to ${facts.sha256}.`);
            }
        }
    }
    for (const [stem, meta] of metas) {
        if (!byStem.has(stem) && FILE_RE.test(stem)) {
            out.add(meta.file, "attachment.pair", `metadata has no binary docs/attachment/${stem}.<ext>`, "Add the binary next to the metadata, or remove the metadata.");
        }
    }
}
/**
 * config/instructions.md (phase 13): it must exist and hold each placeholder
 * once, and the priming it gives (with realistic release text, one warning
 * and every featured document) must stay within priming_budget. Returns a
 * note with the character count for the PR check.
 */
function checkPriming(root, config, docs, out) {
    const path = join(root, INSTRUCTIONS_FILE);
    if (!existsSync(path)) {
        out.add(INSTRUCTIONS_FILE, "instructions.missing", "the session instructions file is missing", "Add config/instructions.md with the instruction text and the placeholders {{release}}, {{commands}} and {{featured}}.");
        return undefined;
    }
    const template = readFileSync(path, "utf8");
    const problems = placeholderProblems(template);
    for (const p of problems)
        out.add(INSTRUCTIONS_FILE, "instructions.placeholder", p, "Keep {{release}}, {{commands}} and {{featured}} exactly once each; the hook fills them in.");
    if (problems.length)
        return undefined;
    const featured = docs.filter((d) => d.frontmatter?.featured === true && d.body !== undefined);
    const blocks = featured.map((d) => ({ file: d.file, text: primingFeatured(d.key ?? d.file, String(d.frontmatter?.title ?? ""), d.body) }));
    const base = charCount(composeInstructions(template, SAMPLE_VARS, ""));
    const total = charCount(composeInstructions(template, SAMPLE_VARS, blocks.map((b) => b.text).join("\n")));
    const breakdown = blocks.map((b) => `${b.file} ${charCount(b.text)}`).join(", ");
    const summary = `priming is ${total} characters of ${config.priming_budget} (instructions with sample release text ${base}; featured: ${breakdown || "none"})`;
    if (total <= config.priming_budget)
        return { file: INSTRUCTIONS_FILE, message: summary };
    const largest = [...blocks].sort((a, b) => charCount(b.text) - charCount(a.text))[0];
    out.add(largest?.file ?? INSTRUCTIONS_FILE, "priming.budget", summary.replace(" of ", ", over the budget of "), "Shorten config/instructions.md or featured bodies, or set `featured: false` on some documents.");
    return undefined;
}
/**
 * Classifies a markdown path like the tree walk does: the type and the key
 * (ID or CODE:…) it provides, or the path findings.
 */
export function classifyPath(file, config) {
    const out = new Collector();
    const segs = file.split("/");
    if (segs[0] === "docs" && segs.length === 3) {
        const folder = TYPE_FOLDERS[segs[1]];
        const m = FILE_RE.exec(segs[2].replace(/\.md$/, ""));
        if (!folder || !segs[2].endsWith(".md") || !m) {
            out.add(file, "path.layout", "document path must be docs/<type>/NNNN-<slug>.md", "Use the path the CLI generates.");
            return { type: folder?.type, findings: out.findings };
        }
        if (!SLUG_RE.test(m[2]))
            out.add(file, "path.slug", `slug \`${m[2]}\` must be lowercase letters and digits separated by single hyphens`, "Use the slug the CLI generates.");
        return { type: folder.type, key: `${folder.prefix}-${m[1]}`, findings: out.findings };
    }
    if (segs[0] === "code" && segs.length >= 4 && file.endsWith(".md")) {
        const [, org, repo, ...rest] = segs;
        const repoId = `${org}/${repo}`;
        if (!config.repositories.includes(repoId)) {
            out.add(file, "shadow.repo", `repository \`${repoId}\` is not configured`, "Add it to `repositories` in config/repositories.yaml via PR, or move the document.");
        }
        const last = rest[rest.length - 1];
        const codePath = last === "_.md" ? rest.slice(0, -1) : [...rest.slice(0, -1), last.slice(0, -3)];
        return { type: "shadow", key: `CODE:${[repoId, ...codePath].join("/")}`, findings: out.findings };
    }
    out.add(file, "path.layout", "not a document path (docs/<type>/NNNN-<slug>.md or code/<org>/<repo>/<path>.md)", "Use the path the CLI generates.");
    return { findings: out.findings };
}
/**
 * Validates documents that are about to be written, without the full tree:
 * path, frontmatter schema, category, relations, links, inverse entries,
 * macros and release repositories. Targets must be in `written` or `known`.
 * Tree-wide rules (duplicates, attachments, priming budget) are left to the
 * full validation of the branch.
 */
export function validateDocuments(config, written, known = []) {
    const out = new Collector();
    const registry = new Map();
    for (const k of known)
        registry.set(k.key, { file: k.file, type: "shadow", key: k.key, frontmatter: k.relations ? { relations: k.relations } : undefined });
    const docs = [];
    for (const w of written) {
        const c = classifyPath(w.file, config);
        out.findings.push(...c.findings);
        if (!c.type)
            continue;
        const doc = { file: w.file, type: c.type, key: c.key };
        parseDocument(config, doc, w.text, out);
        docs.push(doc);
        if (doc.key)
            registry.set(doc.key, doc);
    }
    for (const doc of docs) {
        checkRelationsAndLinks(config, doc, registry, out);
        checkInverses(doc, registry, out);
        checkMacros(doc, out);
        checkReleaseRepos(config, doc, out);
    }
    return out.findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}
/**
 * Notes about attachments (spec 5.5), never failures: an attachment nothing
 * links to, and a document that still links to a superseded attachment.
 */
function attachmentNotes(docs, registry) {
    const notes = [];
    const linked = new Set();
    for (const d of docs) {
        for (const r of relationsOf(d)) {
            if (r.type in INVERSE_OF || !r.target.startsWith("ATT-"))
                continue;
            linked.add(r.target);
            // The new version itself is not "still linking" to the version it supersedes.
            if (r.type === "supersedes")
                continue;
            const att = registry.get(r.target);
            if (att?.frontmatter?.state === "superseded") {
                const by = relationsOf(att).filter((x) => x.type === "superseded-by").map((x) => x.target);
                notes.push({ file: d.file, message: `still links to the superseded ${r.target}${by.length ? ` (superseded by ${by.join(", ")})` : ""}` });
            }
        }
    }
    for (const d of docs) {
        if (d.type === "attachment" && d.key && !linked.has(d.key))
            notes.push({ file: d.file, message: `nothing links to ${d.key}` });
    }
    return notes.sort((a, b) => a.file.localeCompare(b.file));
}
