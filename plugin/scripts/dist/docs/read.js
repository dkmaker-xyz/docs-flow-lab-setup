import { isRecord, parseYaml, splitFrontmatter } from "../engine/index.js";
import { cacheDir, fetchIndex } from "../index/read.js";
import { DocRepo } from "./docrepo.js";
import { normaliseId } from "./write.js";
function parse(text) {
    const split = splitFrontmatter(text);
    if (!split)
        return { fm: {}, body: text };
    try {
        const fm = parseYaml(split.frontmatter);
        return { fm: isRecord(fm) ? fm : {}, body: split.body };
    }
    catch {
        return { fm: {}, body: split.body };
    }
}
/** `<noun> show <ID>` at a ref. */
export async function showDocument(client, kind, idInput, ref) {
    const id = normaliseId(kind, idInput);
    if (!id)
        return { ok: false, message: `\`${idInput}\` is not a ${kind.prefix} ID`, nextAction: `Pass an ID like ${kind.prefix}-0042.` };
    const repo = new DocRepo(client);
    const hit = await repo.findNumbered(kind.folder, id.slice(kind.prefix.length + 1), [ref]);
    if (!hit)
        return { ok: false, message: `${id} does not exist on \`${ref}\``, nextAction: `List the documents with \`idc365-decisions ${kind.noun} list --ref ${ref}\`.` };
    const text = (await repo.text(hit.file, ref));
    const { fm, body } = parse(text);
    return { ok: true, key: id, file: hit.file, ref, frontmatter: fm, body, text };
}
/** `code show <path>` at a ref. */
export async function showShadow(client, code, ref) {
    const text = await new DocRepo(client).text(code.file, ref);
    if (text === undefined)
        return { ok: false, message: `${code.key} has no shadow document on \`${ref}\``, nextAction: "Create it with `idc365-decisions code create`." };
    const { fm, body } = parse(text);
    return { ok: true, key: code.key, file: code.file, ref, frontmatter: fm, body, text };
}
/** `<noun> list` at a ref: reads every document in the type folder (until the index exists). */
export async function listDocuments(client, kind, ref, filter = {}) {
    const repo = new DocRepo(client);
    const entries = ((await repo.folder(`docs/${kind.folder}`, ref)) ?? []).filter((e) => e.type === "file" && /^[0-9]{4,}-.+\.md$/.test(e.name));
    const out = [];
    // Read in small batches to stay gentle on the API.
    for (let i = 0; i < entries.length; i += 8) {
        const batch = await Promise.all(entries.slice(i, i + 8).map(async (e) => ({ e, text: (await repo.text(e.path, ref)) ?? "" })));
        for (const { e, text } of batch) {
            const { fm } = parse(text);
            const doc = {
                id: typeof fm.id === "string" ? fm.id : `${kind.prefix}-${e.name.split("-")[0]}`,
                file: e.path,
                title: String(fm.title ?? ""),
                state: String(fm.state ?? ""),
                category: typeof fm.category === "string" ? fm.category : undefined,
                intent: String(fm.intent ?? ""),
            };
            if (filter.state && doc.state !== filter.state)
                continue;
            if (filter.category && doc.category !== filter.category)
                continue;
            out.push(doc);
        }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}
/**
 * `list` (spec 6.2): reads the ref's index from meta/index (cached with its
 * ETag). When there is no index, or it is behind the branch head, it reads
 * the documents directly and says why.
 */
export async function listFromIndexOrDirect(client, kind, ref, filter = {}, dir = cacheDir()) {
    const f = await fetchIndex(client, ref, dir);
    if (f.index && !f.stale) {
        const documents = f.index.documents
            .filter((d) => d.type === kind.type)
            .filter((d) => (!filter.state || d.state === filter.state) && (!filter.category || d.category === filter.category))
            .map((d) => ({ id: d.id, pending: d.pending, file: d.path, title: d.title ?? "", state: d.state ?? "", category: d.category ?? undefined, intent: d.intent ?? "" }));
        return { documents, source: { kind: "index", status: f.status, sourceSha: f.index.sourceSha, head: f.head, generatedAt: f.index.generatedAt } };
    }
    const documents = await listDocuments(client, kind, ref, filter);
    return { documents, source: { kind: "direct", reason: f.index ? "stale" : "missing", status: f.status, sourceSha: f.index?.sourceSha, head: f.head } };
}
