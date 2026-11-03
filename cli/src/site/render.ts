import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Marked, type Tokens } from "marked";
import { isRecord, parseYaml, splitFrontmatter } from "../engine/index.js";
import { buildIndex, type GitInfo } from "../index/build.js";
import type { IndexDocument } from "../index/model.js";

/**
 * Static HTML for the local documentation viewer (phase 11). The site
 * workflow renders one folder per documentation branch or v* tag into
 * meta/site; `idc365-decisions view` serves it with the layout (navigation,
 * search, version picker) around these fragments.
 *
 * Folder layout:
 *   site.json    manifest: ref, kind, sourceSha, documents (id, type, title, state, intent, page, date)
 *   search.json  ID, title, state, type, page and plain body text per document
 *   <path>.html  one fragment per document, `docs/adr/0001-x.md` → `docs/adr/0001-x.html`
 */

export const SITE_SCHEMA = 1;
export const SITE_BRANCH = "meta/site";

export interface SiteDoc {
  id: string;
  type: string;
  title: string;
  state: string;
  intent: string;
  page: string;
  /** Date of the last commit that changed the document (ISO). */
  date: string | null;
}

export interface SiteManifest {
  schema: number;
  ref: string;
  kind: "branch" | "tag";
  repository: string;
  sourceSha: string;
  generatedAt: string;
  documents: SiteDoc[];
}

export interface SearchEntry {
  id: string;
  title: string;
  state: string;
  type: string;
  page: string;
  text: string;
}

export interface TocEntry {
  depth: number;
  id: string;
  text: string;
}

/** `main` → `main`, `release/v0.3.0` → `release__v0.3.0`, `v0.2.0` → `v0.2.0` (the meta/index naming). */
export function folderName(ref: string): string {
  return ref.replace(/\//g, "__");
}

/** The inverse of folderName. */
export function refOfFolder(folder: string): string {
  return folder.replace(/__/g, "/");
}

/** Refs the site renders: main, release/vX.Y.Z and vX.Y.Z tags. */
export const SITE_REF_RE = /^(main|release\/v[0-9]+\.[0-9]+\.[0-9]+|v[0-9]+\.[0-9]+\.[0-9]+)$/;
export const FOLDER_RE = /^(main|release__v[0-9]+\.[0-9]+\.[0-9]+|v[0-9]+\.[0-9]+\.[0-9]+)$/;

/** `docs/adr/0001-x.md` → `docs/adr/0001-x.html`; always forward slashes. */
export function pagePath(docPath: string): string {
  return docPath.split("\\").join("/").replace(/\.md$/, ".html");
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** http(s), mailto, fragment or a relative path; everything else (javascript:, data:, vbscript:, …) is dropped. */
export function safeHref(href: string, images = false): string | undefined {
  const h = href.trim();
  if (!h) return undefined;
  if (/^https?:\/\//i.test(h)) return h;
  if (!images && (/^mailto:/i.test(h) || h.startsWith("#"))) return h;
  // A scheme is letters followed by ":" before any "/", "?" or "#".
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return undefined;
  if (h.startsWith("//")) return undefined;
  return h;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

export interface RenderContext {
  /** Repository-relative path of the document (`docs/adr/0001-x.md`). */
  docPath: string;
  /** org/repo of the documentation repository, for attachment binaries on github.com. */
  repository: string;
  /** Ref the site is rendered from. */
  ref: string;
}

/**
 * Resolves a link in a document body: `.md` links to other documents become
 * `.html` pages of the site; relative links to other files (attachment
 * binaries) point to the file on github.com, which uses the reader's own
 * GitHub login; external links stay.
 */
export function resolveHref(href: string, ctx: RenderContext): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return href;
  const [path, hash] = splitHash(href);
  if (path.endsWith(".md")) return `${path.slice(0, -3)}.html${hash}`;
  const target = posix.normalize(posix.join(posix.dirname(ctx.docPath), path));
  if (target.startsWith("..")) return href;
  return `https://github.com/${ctx.repository}/raw/${encodeURI(ctx.ref)}/${target.split("/").map(encodeURIComponent).join("/")}${hash}`;
}

function splitHash(href: string): [string, string] {
  const i = href.indexOf("#");
  return i < 0 ? [href, ""] : [href.slice(0, i), href.slice(i)];
}

/**
 * Markdown to HTML with marked. Raw HTML in the source is shown as text, not
 * interpreted (bodies are agent-written input), and only safe link targets
 * are kept. Headings get ids for the table of contents.
 */
export function renderMarkdown(body: string, ctx: RenderContext): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = [];
  const used = new Map<string, number>();
  const marked = new Marked({ gfm: true, async: false });
  marked.use({
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag) {
        return "block" in token && token.block ? `<p>${escapeHtml(token.text)}</p>\n` : escapeHtml(token.text);
      },
      heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, { tokens, depth, text }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const plain = text.replace(/[*_`[\]]/g, "");
        let id = slugify(plain);
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n + 1}`;
        if (depth >= 2 && depth <= 3) toc.push({ depth, id, text: plain });
        // The document title is the page's only h1; a body h1 becomes h2.
        const level = Math.max(2, depth);
        return `<h${level} id="${id}">${inner}</h${level}>\n`;
      },
      link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, { href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const safe = safeHref(href);
        if (!safe) return inner;
        const url = resolveHref(safe, ctx);
        const external = /^https?:/i.test(url);
        return `<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' rel="noreferrer noopener"' : ""}>${inner}</a>`;
      },
      image({ href, title, text }: Tokens.Image) {
        const safe = safeHref(href, true);
        if (!safe) return escapeHtml(text);
        return `<img src="${escapeHtml(resolveHref(safe, ctx))}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""}>`;
      },
    },
  });
  const html = marked.parse(body) as string;
  return { html, toc };
}

/** Plain text of a body for search: Markdown syntax removed. */
export function plainText(body: string): string {
  return body
    .replace(/^\[[^\]]+\]:\s*\S+.*$/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*([-*+]|[0-9]+\.)\s+/gm, " ")
    .replace(/[#>*_`|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const TYPE_LABELS: Record<string, string> = {
  adr: "Architecture decisions",
  procedure: "Procedures",
  techstack: "Tech stack",
  release: "Releases",
  attachment: "Attachments",
  shadow: "Code",
};
export const TYPE_ORDER = ["adr", "procedure", "techstack", "release", "attachment", "shadow"];
const SINGULAR: Record<string, string> = { adr: "Architecture decision", procedure: "Procedure", techstack: "Tech stack entry", release: "Release", attachment: "Attachment", shadow: "Code documentation" };

/** What a relation type reads like from the other document's side. */
const INCOMING_LABEL: Record<string, string> = {
  supersedes: "supersedes this",
  amends: "amends this",
  "depends-on": "depends on this",
  implements: "implements this",
  uses: "uses this",
  "relates-to": "relates to this",
  attachment: "uses this attachment",
};

export interface DocInput {
  doc: IndexDocument;
  fm: Record<string, unknown>;
  body: string;
}

/** Display title: the frontmatter title, or the code path for shadow documents. */
export function titleOf(doc: IndexDocument): string {
  if (doc.title) return doc.title;
  if (doc.id.startsWith("CODE:")) return doc.id.slice(5);
  return doc.id;
}

/** How an ID is shown: `CODE <repo>/<path>` for code documentation (the org is the same everywhere), else the ID. */
export function displayId(id: string): string {
  const m = /^CODE:[A-Za-z0-9-]+\/(.+)$/.exec(id);
  return m ? `CODE ${m[1]}` : id;
}

/** A title worth showing next to an ID: not just the ID or the code path again. */
export function extraTitle(id: string, title: string): string {
  if (!title || title === id || `CODE:${title}` === id || id.endsWith(`/${title}`) || displayId(id) === `CODE ${title}`) return "";
  return title;
}

/** Status shown for a document: its state, "placeholder" for a placeholder without one. */
export function stateOf(doc: IndexDocument): string {
  return doc.state ?? (doc.placeholder ? "placeholder" : "");
}

/** A link to a relation target: its page when it is in the tree, else a real external link. */
function targetLink(target: string, fromPage: string, byId: Map<string, IndexDocument>, fmLink: string | undefined): string {
  const doc = byId.get(target);
  if (doc) {
    const t = extraTitle(target, titleOf(doc));
    return `<a href="${escapeHtml(posix.relative(posix.dirname(fromPage), pagePath(doc.path)))}">${escapeHtml(displayId(target))}</a>${t ? ` ${escapeHtml(t)}` : ""}`;
  }
  if (fmLink && /^https?:\/\//i.test(fmLink)) return `<a href="${escapeHtml(fmLink)}" rel="noreferrer noopener">${escapeHtml(target)}</a>`;
  const code = /^CODE:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/?(.*)$/.exec(target);
  if (code) {
    const path = code[3] ?? "";
    const url = `https://github.com/${code[1]}/${code[2]}${path ? `/tree/HEAD/${path.replace(/\/_$/, "")}` : ""}`;
    return `<a href="${escapeHtml(url)}" rel="noreferrer noopener">${escapeHtml(displayId(target))}</a>`;
  }
  return escapeHtml(target);
}

/** The HTML fragment of one document page (without the viewer's layout). */
export function renderDocument(input: DocInput, byId: Map<string, IndexDocument>, ctx: { repository: string; ref: string }): { html: string; toc: TocEntry[] } {
  const { doc, fm, body } = input;
  const page = pagePath(doc.path);
  const rel = (d: IndexDocument) => posix.relative(posix.dirname(page), pagePath(d.path));
  const state = stateOf(doc);
  const out: string[] = [];
  out.push(`<article class="doc" data-id="${escapeHtml(doc.id)}">`);
  const meta = [...(state ? [`<span class="badge s-${escapeHtml(slugify(state))}">${escapeHtml(state)}</span>`] : []), `<span class="id">${escapeHtml(displayId(doc.id))}</span>`, escapeHtml(SINGULAR[doc.type] ?? doc.type)];
  if (doc.category) meta.push(escapeHtml(doc.category));
  if (doc.commit?.date) meta.push(`updated ${escapeHtml(doc.commit.date.slice(0, 10))}`);
  out.push(`<p class="meta">${meta.join(" · ")}</p>`);
  out.push(`<h1>${escapeHtml(titleOf(doc))}</h1>`);

  // Superseded / amended banner (from the incoming forward relations).
  const banners: string[] = [];
  for (const r of doc.relations.incoming) {
    if (r.type !== "supersedes" && r.type !== "amends") continue;
    const src = byId.get(r.source!);
    const t = src ? extraTitle(src.id, titleOf(src)) : "";
    const link = src ? `<a href="${escapeHtml(rel(src))}">${escapeHtml(displayId(src.id))}${t ? ` ${escapeHtml(t)}` : ""}</a>` : escapeHtml(r.source!);
    banners.push(`<p>${r.type === "supersedes" ? "Superseded by" : "Amended by"} ${link}${r.why ? `: ${escapeHtml(r.why)}` : ""}</p>`);
  }
  if (banners.length) out.push(`<div class="banner${doc.relations.incoming.some((r) => r.type === "supersedes") ? " superseded" : ""}">${banners.join("")}</div>`);

  if (doc.intent) out.push(`<p class="intent">${escapeHtml(doc.intent)}</p>`);
  if (doc.type === "attachment") {
    const binary = Object.keys(fm).length ? attachmentBinary(doc.path, fm) : undefined;
    if (binary) {
      const url = `https://github.com/${ctx.repository}/raw/${encodeURI(ctx.ref)}/${binary.split("/").map(encodeURIComponent).join("/")}`;
      out.push(`<p class="file">File: <a href="${escapeHtml(url)}" rel="noreferrer noopener">${escapeHtml(binary.split("/").pop()!)}</a>${fm.media_type ? ` (${escapeHtml(String(fm.media_type))}${typeof fm.size === "number" ? `, ${fm.size} bytes` : ""})` : ""}</p>`);
    }
  }

  const rendered = renderMarkdown(body, { docPath: doc.path, repository: ctx.repository, ref: ctx.ref });
  if (rendered.toc.length) {
    out.push(`<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>`);
    for (const t of rendered.toc) out.push(`<li class="d${t.depth}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`);
    out.push(`</ul></nav>`);
  }
  out.push(`<div class="body">${rendered.html}</div>`);

  // Relations in both directions, each with its why.
  const fmRels = (Array.isArray(fm.relations) ? fm.relations : []).filter(isRecord);
  const linkOf = (target: string) => fmRels.find((r) => r.target === target && typeof r.link === "string")?.link as string | undefined;
  const outgoing = doc.relations.outgoing;
  const incoming = doc.relations.incoming;
  if (outgoing.length || incoming.length) {
    out.push(`<section class="relations"><h2 id="relations">Relations</h2>`);
    if (outgoing.length) {
      out.push(`<h3>Outgoing</h3><ul>`);
      for (const r of outgoing) out.push(`<li><span class="rtype">${escapeHtml(r.type)}</span> ${targetLink(r.target!, page, byId, linkOf(r.target!))}${r.why ? `<span class="why">${escapeHtml(r.why)}</span>` : ""}</li>`);
      out.push(`</ul>`);
    }
    if (incoming.length) {
      out.push(`<h3>Incoming</h3><ul>`);
      for (const r of incoming) out.push(`<li>${targetLink(r.source!, page, byId, undefined)} <span class="rtype">${escapeHtml(INCOMING_LABEL[r.type] ?? `${r.type} this`)}</span>${r.why ? `<span class="why">${escapeHtml(r.why)}</span>` : ""}</li>`);
      out.push(`</ul>`);
    }
    out.push(`</section>`);
  }
  out.push(`</article>`);
  return { html: out.join("\n") + "\n", toc: rendered.toc };
}

/** The binary next to an attachment's metadata (same number and slug, the configured extension). */
function attachmentBinary(metaPath: string, fm: Record<string, unknown>): string | undefined {
  const ext = typeof fm.media_type === "string" ? MEDIA_EXT[fm.media_type] : undefined;
  return ext ? metaPath.replace(/\.md$/, `.${ext}`) : undefined;
}
const MEDIA_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "image/svg+xml": "svg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

function commitDate(root: string): Date {
  try {
    return new Date(execFileSync("git", ["log", "-1", "--format=%cI"], { cwd: root, encoding: "utf8" }).trim());
  } catch {
    return new Date(0);
  }
}

export interface BuildSiteOptions {
  root: string;
  ref: string;
  kind: "branch" | "tag";
  repository: string;
  git: GitInfo;
  now?: () => Date;
}

/** Renders a checkout into the files of one site folder (paths relative to the folder). */
export async function buildSite(o: BuildSiteOptions): Promise<{ manifest: SiteManifest; files: Map<string, string> }> {
  // generatedAt is the source commit's date (not the clock), so rendering the same commit twice gives identical files and publish skips it.
  const index = await buildIndex({ root: o.root, branch: o.ref, git: o.git, now: o.now ?? (() => commitDate(o.root)) });
  const byId = new Map(index.documents.map((d) => [d.id, d]));
  const files = new Map<string, string>();
  const search: SearchEntry[] = [];
  const documents: SiteDoc[] = [];
  for (const doc of index.documents) {
    const text = readFileSync(join(o.root, doc.path), "utf8");
    const split = splitFrontmatter(text);
    let fm: Record<string, unknown> = {};
    try {
      const data = split ? parseYaml(split.frontmatter) : undefined;
      if (isRecord(data)) fm = data;
    } catch {
      fm = {};
    }
    const body = split?.body ?? text;
    const page = pagePath(doc.path);
    files.set(page, renderDocument({ doc, fm, body }, byId, { repository: o.repository, ref: o.ref }).html);
    const entry = { id: doc.id, type: doc.type, title: titleOf(doc), state: stateOf(doc), page };
    documents.push({ ...entry, intent: doc.intent ?? "", date: doc.commit?.date ?? null });
    search.push({ ...entry, text: plainText(body).slice(0, 20000) });
  }
  const manifest: SiteManifest = {
    schema: SITE_SCHEMA,
    ref: o.ref,
    kind: o.kind,
    repository: o.repository,
    sourceSha: index.sourceSha,
    generatedAt: index.generatedAt,
    documents,
  };
  files.set("site.json", JSON.stringify(manifest, null, 1) + "\n");
  files.set("search.json", JSON.stringify(search) + "\n");
  return { manifest, files };
}
