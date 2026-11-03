import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { isRecord, parseYaml, splitFrontmatter } from "../engine/index.js";
import { downloadObject, parsePointer, pointerText, sha256, uploadObject } from "../github/index.js";
import { fetchIndex } from "../index/read.js";
import { DocRepo } from "./docrepo.js";
import { KINDS } from "./kinds.js";
import { showDocument } from "./read.js";
import { createDocument, loadConfig, normaliseId } from "./write.js";
const refuse = (message, nextAction) => ({ ok: false, message, nextAction });
export const ATT_FOLDER = "docs/attachment";
/** `.gitattributes` lines that put attachment binaries (not their .md) in Git LFS. */
export function lfsAttributes(config) {
    return Object.keys(config.attachment_types)
        .sort()
        .map((ext) => `${ATT_FOLDER}/*.${ext} filter=lfs diff=lfs merge=lfs -text`);
}
/** The .gitattributes content with the missing LFS lines added, or undefined when nothing is missing. */
export function withLfsAttributes(current, config) {
    const have = new Set((current ?? "").split("\n").map((l) => l.trim().replace(/\s+/g, " ")));
    const missing = lfsAttributes(config).filter((l) => !have.has(l));
    if (!missing.length)
        return undefined;
    const base = current && !current.endsWith("\n") ? `${current}\n` : current ?? "";
    return `${base}${base ? "\n" : ""}# Attachment binaries are stored with Git LFS (idc365-decisions).\n${missing.join("\n")}\n`;
}
/** Checks the file against the configured types and size; nothing else happens before this. */
export function checkFile(path, config) {
    const ext = extname(path).slice(1).toLowerCase();
    const mediaType = config.attachment_types[ext];
    if (!mediaType)
        return refuse(`\`.${ext || "(none)"}\` files are not allowed as attachments`, `Use one of: ${Object.keys(config.attachment_types).join(", ")}. Diagrams are mermaid in a document, not attachments.`);
    let size;
    try {
        size = statSync(path).size;
    }
    catch {
        return refuse(`cannot read \`${path}\``, "Pass an existing file.");
    }
    if (size > config.attachment_max_bytes)
        return refuse(`\`${basename(path)}\` is ${size} bytes; the maximum is ${config.attachment_max_bytes}`, "Reduce the file size, or split it into several attachments.");
    return { ext, mediaType, size };
}
/**
 * `att create <file>` (spec 5.5, 6.3): type and size first, then the ID, the
 * LFS upload, and one commit with the pointer `NNNN-<slug>.<ext>`, the
 * metadata `NNNN-<slug>.md` and, when missing, the .gitattributes LFS lines.
 */
export async function createAttachment(client, path, fields, body, opts) {
    const repo = new DocRepo(client);
    const early = await loadConfig(repo, opts.branch ?? "main");
    if ("ok" in early)
        return early;
    const file = checkFile(path, early);
    if ("ok" in file)
        return file;
    const data = readFileSync(path);
    let supersedes;
    if (opts.supersedes) {
        supersedes = normaliseId(KINDS.att, opts.supersedes);
        if (!supersedes)
            return refuse(`\`${opts.supersedes}\` is not an ATT ID`, "Pass an ID like ATT-0001.");
    }
    return createDocument(client, KINDS.att, { ...fields, extra: { media_type: file.mediaType, size: file.size, sha256: sha256(data) } }, body ?? `Attachment \`${basename(path)}\`.\n`, opts, {
        verb: "Attach",
        relations: supersedes ? [{ type: "supersedes", target: supersedes, why: opts.why ?? "New version of the attachment.", link: "" }] : [],
        extraFiles: async (_id, metaFile, refs, config) => {
            // Type and size again with the configuration of the branch being written.
            const again = checkFile(path, config);
            if ("ok" in again)
                return again;
            const uploaded = await uploadObject(client, data);
            const changes = [{ path: metaFile.replace(/\.md$/, `.${file.ext}`), content: pointerText(uploaded) }];
            const attrs = withLfsAttributes(await repo.findFirst([".gitattributes"], refs).then((f) => f?.text), config);
            if (attrs)
                changes.push({ path: ".gitattributes", content: attrs });
            return changes;
        },
    });
}
/** Documents that use `id` (forward relations except `supersedes`): from the ref's index when current, otherwise by reading the documents. */
export async function linkersOf(client, id, ref) {
    try {
        const f = await fetchIndex(client, ref);
        if (f.index && !f.stale) {
            const doc = f.index.documents.find((d) => d.id === id);
            return { linkers: (doc?.relations.incoming ?? []).filter((r) => r.type !== "supersedes").map((r) => ({ id: r.source, type: r.type })), source: "index" };
        }
    }
    catch {
        // fall back to reading the documents
    }
    const repo = new DocRepo(client);
    const linkers = [];
    for (const folder of ["adr", "procedure", "techstack", "release", "attachment"]) {
        for (const e of (await repo.folder(`docs/${folder}`, ref)) ?? []) {
            if (!e.name.endsWith(".md"))
                continue;
            const split = splitFrontmatter((await repo.text(e.path, ref)) ?? "");
            if (!split)
                continue;
            try {
                const fm = parseYaml(split.frontmatter);
                if (!isRecord(fm))
                    continue;
                for (const r of Array.isArray(fm.relations) ? fm.relations : []) {
                    if (isRecord(r) && r.target === id && !["supersedes", "superseded-by", "amended-by", "depended-on-by", "implemented-by", "used-by", "attached-to"].includes(String(r.type)))
                        linkers.push({ id: String(fm.id), type: String(r.type) });
                }
            }
            catch {
                // unreadable document: skip
            }
        }
    }
    return { linkers, source: "direct" };
}
async function binaryOf(repo, metaFile, ref) {
    const stem = basename(metaFile, ".md");
    return ((await repo.folder(ATT_FOLDER, ref)) ?? []).find((e) => e.name.startsWith(`${stem}.`) && !e.name.endsWith(".md"))?.path;
}
/** `att show`: metadata, the binary's path, and who links to it. */
export async function showAttachment(client, idInput, ref) {
    const shown = await showDocument(client, KINDS.att, idInput, ref);
    if (!shown.ok)
        return shown;
    const fm = shown.frontmatter;
    const supersededBy = (Array.isArray(fm.relations) ? fm.relations : []).filter((r) => isRecord(r) && r.type === "superseded-by").map((r) => String(r.target));
    const { linkers, source } = await linkersOf(client, shown.key, ref);
    return {
        ok: true,
        id: shown.key,
        file: shown.file,
        binary: await binaryOf(new DocRepo(client), shown.file, ref),
        ref,
        state: String(fm.state ?? ""),
        mediaType: String(fm.media_type ?? ""),
        size: Number(fm.size ?? 0),
        sha256: String(fm.sha256 ?? ""),
        supersededBy,
        linkers,
        linkSource: source,
        text: shown.text,
    };
}
/** `att get`: downloads the binary through Git LFS and checks it against the pointer and the metadata. */
export async function getAttachment(client, idInput, ref) {
    const info = await showAttachment(client, idInput, ref);
    if (!info.ok)
        return info;
    if (!info.binary)
        return refuse(`${info.id} has no binary next to its metadata on \`${ref}\``, "Report this; validation flags it as attachment.pair.");
    const repo = new DocRepo(client);
    const pointer = parsePointer((await repo.text(info.binary, ref)) ?? "");
    if (!pointer)
        return refuse(`\`${info.binary}\` is not a Git LFS pointer`, "Report this; the binary was committed without LFS.");
    const data = await downloadObject(client, pointer);
    if (info.sha256 && sha256(data) !== info.sha256)
        return refuse(`${info.id}: the downloaded file does not match the sha256 in its metadata`, "Report this; validation flags it as attachment.metadata.");
    return { ok: true, id: info.id, name: basename(info.binary), data, sha256: sha256(data) };
}
