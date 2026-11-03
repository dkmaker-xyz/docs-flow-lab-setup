import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { openCommand } from "../src/commands/site-cmd.js";
import { packageRoot } from "../src/engine/package-root.js";
import { localGit } from "../src/index/build.js";
import { blobSha, publishSite, removeSite } from "../src/site/publish.js";
import { buildSite, folderName, pagePath, plainText, refOfFolder, renderMarkdown, resolveHref, safeHref, type SiteManifest } from "../src/site/render.js";
import { createViewer, hostAllowed, parseCookies, safePage, searchEntries, tabOf, TABS } from "../src/site/server.js";
import { cacheFile, SiteSource } from "../src/site/source.js";
import { FakeRepo, gitBlobSha } from "./docs/fakerepo.js";

const VALID = join(packageRoot(), "test", "fixtures", "valid");
const temp = mkdtempSync(join(tmpdir(), "idc365-site-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const uniq = (p: string) => join(temp, `${p}-${Math.random().toString(36).slice(2)}`);
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();

/** A checkout of the fixture tree in which ADR-0003 supersedes ADR-0002. */
function checkout(): string {
  const root = uniq("tree");
  cpSync(VALID, root, { recursive: true });
  writeFileSync(
    join(root, "docs/adr/0003-separate-event-database.md"),
    "---\nid: ADR-0003\ntitle: Store partner events separately\ndescription: d\nintent: Where partner events are stored now.\nwhen: w\nstate: accepted\ncategory: api\nrelations:\n  - type: supersedes\n    target: ADR-0002\n    why: Events move to their own database.\n    link: ./0002-partner-event-api.md\n---\n# Overview\n\n## Context\n\nThe old [ADR-0002][ADR-0002] is replaced. Unique word: flamingo.\n\n### Details\n\n<script>alert(1)</script> and [bad](javascript:alert(1)) and ![img](data:image/png;base64,xx).\n\n## Context\n\nSecond heading with the same text.\n\n[ADR-0002]: ./0002-partner-event-api.md\n",
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "docs");
  return root;
}

describe("rendering", () => {
  let files: Map<string, string>;
  let manifest: SiteManifest;
  let root: string;
  before(async () => {
    root = checkout();
    ({ files, manifest } = await buildSite({ root, ref: "main", kind: "branch", repository: "acme/docs", git: localGit(root) }));
  });
  test("one page per document plus site.json and search.json; folder and page names", () => {
    assert.equal(manifest.documents.length, 12);
    assert.ok(files.has("site.json") && files.has("search.json"));
    assert.ok(files.has("docs/adr/0003-separate-event-database.html"));
    assert.ok(files.has("code/idconnectdk/idc365/src/_.html"));
    assert.deepEqual([folderName("main"), folderName("release/v0.3.0"), folderName("v0.2.0")], ["main", "release__v0.3.0", "v0.2.0"]);
    assert.equal(refOfFolder("release__v0.3.0"), "release/v0.3.0");
    assert.equal(pagePath("docs\\adr\\0001-x.md"), "docs/adr/0001-x.html", "Windows separators become /");
    assert.equal(manifest.generatedAt, new Date(git(root, "log", "-1", "--format=%cI")).toISOString(), "deterministic: the commit date");
  });
  test("superseded banner links the replacing document; relations in both directions with why", () => {
    const old = files.get("docs/adr/0002-partner-event-api.html")!;
    assert.match(old, /<div class="banner superseded"><p>Superseded by <a href="0003-separate-event-database.html">ADR-0003 Store partner events separately<\/a>: Events move to their own database\.<\/p><\/div>/);
    assert.match(old, /<span class="badge s-proposed">proposed<\/span>/);
    // outgoing: amends ADR-0001, attachment ATT-0002; incoming: supersedes from ADR-0003
    assert.match(old, /<h3>Outgoing<\/h3><ul>\n<li><span class="rtype">amends<\/span> <a href="0001-store-data-in-postgresql.html">ADR-0001<\/a> Store service data in PostgreSQL<span class="why">Adds an event store table to the data decision\.<\/span>/);
    assert.match(old, /<h3>Incoming<\/h3><ul>\n<li><a href="0003-separate-event-database.html">ADR-0003<\/a> Store partner events separately <span class="rtype">supersedes this<\/span><span class="why">Events move to their own database\.<\/span>/);
    const adr1 = files.get("docs/adr/0001-store-data-in-postgresql.html")!;
    assert.match(adr1, /<div class="banner"><p>Amended by <a href="0002-partner-event-api.html">ADR-0002 /, "amended-by banner");
    assert.match(adr1, /<a href="https:\/\/example\.atlassian\.net\/browse\/IDC-123" rel="noreferrer noopener">JIRA:IDC-123<\/a>/, "JIRA relation is a real link");
    assert.match(adr1, /<a href="\.\.\/\.\.\/code\/idconnectdk\/idc365\/src\/main\.ts\.html">CODE idc365\/src\/main\.ts<\/a><span class="why">/, "CODE relation: the path once, no repeated title");
    assert.doesNotMatch(files.get("docs/adr/0003-separate-event-database.html")!, /class="banner/);
    const db = files.get("code/idconnectdk/idc365/src/db.ts.html")!;
    assert.match(db, /<span class="badge s-placeholder">placeholder<\/span> · <span class="id">CODE idc365\/src\/db\.ts<\/span>/);
    assert.doesNotMatch(Object.values(Object.fromEntries(files)).join(""), /unknown/);
  });
  test("intent on one line, table of contents with unique ids, body links to .html pages", () => {
    const page = files.get("docs/adr/0003-separate-event-database.html")!;
    assert.match(page, /<p class="intent">Where partner events are stored now\.<\/p>/);
    assert.match(page, /<li class="d2"><a href="#context">Context<\/a><\/li>\n<li class="d3"><a href="#details">Details<\/a><\/li>\n<li class="d2"><a href="#context-2">Context<\/a><\/li>/);
    assert.match(page, /<h2 id="overview">Overview<\/h2>/, "a body h1 becomes h2; the title is the only h1");
    assert.match(page, /<a href="\.\/0002-partner-event-api\.html">ADR-0002<\/a>/);
  });
  test("sanitizing: raw HTML is text, javascript: and data: targets are dropped", () => {
    const page = files.get("docs/adr/0003-separate-event-database.html")!;
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(page, /<script|href="javascript:|src="data:/);
    const r = renderMarkdown('<img src=x onerror=alert(1)>\n\n[x](JaVaScRiPt:alert(1)) [y](//evil.test/a) [z](vbscript:x) <a href="https://ok.test">a</a> ![i](data:image/png;base64,xx)', { docPath: "docs/adr/0001-a.md", repository: "acme/docs", ref: "main" });
    assert.doesNotMatch(r.html, /<img|<a href="javascript|href="\/\/evil|href="vbscript|<a href="https:\/\/ok|src="data/i);
    assert.match(r.html, /<p>&lt;img src=x onerror=alert\(1\)&gt;<\/p>/);
    assert.match(r.html, /<p>x y z &lt;a href=&quot;https:\/\/ok\.test&quot;&gt;a&lt;\/a&gt; i<\/p>/);
    assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
    assert.equal(safeHref("data:text/html,x"), undefined);
  });
  test("link resolution: .md → .html, other files → github.com, external stays", () => {
    const ctx = { docPath: "docs/adr/0001-a.md", repository: "acme/docs", ref: "release/v0.3.0" };
    assert.equal(resolveHref("../procedure/0001-x.md#step-2", ctx), "../procedure/0001-x.html#step-2");
    assert.equal(resolveHref("../attachment/0001-overview.png", ctx), "https://github.com/acme/docs/raw/release/v0.3.0/docs/attachment/0001-overview.png");
    assert.equal(resolveHref("https://example.com/a.md", ctx), "https://example.com/a.md");
  });
  test("attachment pages link the binary; search text without Markdown syntax", () => {
    assert.match(files.get("docs/attachment/0001-architecture-overview.html")!, /File: <a href="https:\/\/github\.com\/acme\/docs\/raw\/main\/docs\/attachment\/0001-architecture-overview\.png"/);
    const search = JSON.parse(files.get("search.json")!) as { id: string; text: string }[];
    assert.match(search.find((s) => s.id === "ADR-0003")!.text, /Unique word: flamingo/);
    assert.equal(plainText("## A\n\nSee [ADR-1][ADR-1] and `x`.\n\n[ADR-1]: ./a.md"), "A See ADR-1 and x .");
  });
});

describe("publishing to meta/site", () => {
  const manifestFor = (r: FakeRepo, ref: string, kind: "branch" | "tag" = "branch") => ({ schema: 1, ref, kind, repository: "acme/docs", sourceSha: r.refs.get(`${kind === "branch" ? "heads" : "tags"}/${ref}`) ?? "", generatedAt: "x", documents: [] }) as SiteManifest;
  test("creates the orphan branch, then replaces only its folder; unchanged is a no-op; a moved ref is skipped", async () => {
    const r = new FakeRepo();
    r.seed("main", { "README.md": "x" });
    r.seed("release/v0.3.0", { "README.md": "y" }, "main");
    const m = manifestFor(r, "main");
    assert.deepEqual(await publishSite(r.client(), m, new Map([["site.json", "{}"], ["docs/adr/0001-a.html", "<p>a</p>"]])), { folder: "main", outcome: "created-branch" });
    assert.equal((await publishSite(r.client(), manifestFor(r, "release/v0.3.0"), new Map([["site.json", "{}"]]))).outcome, "written");
    assert.equal((await publishSite(r.client(), m, new Map([["site.json", "{}"], ["docs/adr/0001-a.html", "<p>a</p>"]]))).outcome, "unchanged");
    await publishSite(r.client(), m, new Map([["site.json", "{ }"]]));
    assert.deepEqual([...r.files("meta/site").keys()].sort(), ["main/site.json", "release__v0.3.0/site.json"]);
    assert.equal(r.files("meta/site").get("main/site.json"), "{ }");
    r.seed("main", { "README.md": "z" });
    assert.equal((await publishSite(r.client(), m, new Map([["site.json", "old"]]))).outcome, "skipped-superseded");
    assert.equal(blobSha("abc"), gitBlobSha(Buffer.from("abc")));
  });
  test("tags render; a deleted branch's folder is removed and never comes back", async () => {
    const r = new FakeRepo();
    r.seed("main", { "README.md": "x" });
    r.tag("v0.2.0");
    r.seed("release/v0.3.0", { "README.md": "y" }, "main");
    assert.equal((await publishSite(r.client(), manifestFor(r, "v0.2.0", "tag"), new Map([["site.json", "{}"]]))).outcome, "created-branch");
    const rel = manifestFor(r, "release/v0.3.0");
    await publishSite(r.client(), rel, new Map([["site.json", "{}"]]));
    await r.client().request("DELETE", r.client().repoPath("/git/refs/heads/release/v0.3.0"));
    assert.equal(await removeSite(r.client(), "release/v0.3.0"), "removed");
    assert.equal(await removeSite(r.client(), "release/v0.3.0"), "absent");
    assert.equal((await publishSite(r.client(), rel, new Map([["site.json", "{}"]]))).outcome, "skipped-deleted");
    assert.deepEqual([...r.files("meta/site").keys()], ["v0.2.0/site.json"]);
  });
});

/** A FakeRepo with a rendered meta/site (main and v0.2.0) and meta/index for main. */
async function siteRepo(indexSha?: string) {
  const root = checkout();
  const r = new FakeRepo();
  r.seed("main", { "README.md": "x" });
  r.tag("v0.2.0");
  const files: Record<string, string> = {};
  for (const [ref, folder] of [["main", "main"], ["v0.2.0", "v0.2.0"]] as const) {
    const built = await buildSite({ root, ref, kind: ref === "main" ? "branch" : "tag", repository: "acme/docs", git: localGit(root) });
    for (const [p, c] of built.files) files[`${folder}/${p}`] = c;
  }
  r.seed("meta/site", files);
  const sha = JSON.parse(files["main/site.json"]!).sourceSha as string;
  r.seed("meta/index", { "main.json": JSON.stringify({ sourceSha: indexSha ?? sha }) });
  return r;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("viewer server", () => {
  async function started(r: FakeRepo, fetchOverride?: typeof fetch) {
    const client = r.client();
    if (fetchOverride) (client as unknown as { fetchImpl: typeof fetch }).fetchImpl = fetchOverride;
    const viewer = createViewer({ source: new SiteSource(client, uniq("cache"), 0), repository: "acme/docs", key: "k1", secret: "s1" });
    const { url, port } = await viewer.listen();
    after(() => viewer.close());
    return { viewer, url, port, cookie: { cookie: "idc365_view=s1" } };
  }

  test("binds 127.0.0.1; the one-time key becomes an HttpOnly SameSite=Strict cookie; without it everything is refused", async () => {
    const { viewer, url, port } = await started(await siteRepo());
    assert.equal((viewer.server.address() as { address: string }).address, "127.0.0.1");
    assert.equal(url, `http://127.0.0.1:${port}/?key=k1`);
    assert.equal((await get(port, "/v/main/")).status, 403);
    assert.equal((await get(port, "/?key=wrong")).status, 403);
    const ok = await get(port, "/?key=k1");
    assert.equal(ok.status, 302);
    assert.match(String(ok.headers["set-cookie"]), /^idc365_view=s1; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/);
    assert.equal((await get(port, "/?key=k1")).status, 403, "the key works once");
    assert.equal((await get(port, "/v/main/", { cookie: "idc365_view=other" })).status, 403);
  });
  test("a foreign Host header (DNS rebinding) and writes are refused", async () => {
    const { port, cookie } = await started(await siteRepo());
    assert.equal((await get(port, "/v/main/", { ...cookie, host: `evil.test:${port}` })).status, 421);
    assert.equal((await get(port, "/v/main/", { ...cookie, host: `127.0.0.1:${port + 1}` })).status, 421);
    assert.equal((await get(port, "/v/main/", { ...cookie, host: `localhost:${port}` })).status, 200);
    assert.ok(hostAllowed(`localhost:${port}`, port) && !hostAllowed(undefined, port) && !hostAllowed(`127.0.0.1`, port));
    const post = await new Promise<number>((res) => request({ host: "127.0.0.1", port, path: "/", method: "POST", headers: { host: `127.0.0.1:${port}`, ...cookie } }, (r) => res(r.statusCode!)).end());
    assert.equal(post, 405);
  });
  test("start page, document page, search by ID and body word, version switch; security headers; no token in pages", async () => {
    const { port, cookie } = await started(await siteRepo());
    const start = await get(port, "/v/main/", cookie);
    assert.equal(start.status, 200);
    assert.match(start.body, /<h1>Recent changes<\/h1>/);
    assert.match(start.body, /<td><a href="\/v\/main\/code\/idconnectdk\/idc365\/src\/db\.ts\.html">CODE idc365\/src\/db\.ts<\/a><\/td><td><\/td><td><span class="badge s-placeholder">placeholder<\/span>/);
    assert.match(start.body, /<option value="main" selected>main<\/option><option value="v0\.2\.0">v0\.2\.0<\/option>/);
    for (const label of ["Architecture decisions", "Procedures", "Tech stack", "Releases", "Attachments", "Code"]) assert.match(start.body, new RegExp(`<h2>${label}</h2>`));
    assert.match(String(start.headers["content-security-policy"]), /default-src 'none'; style-src 'self'; script-src 'self'/);
    const page = await get(port, "/v/main/docs/adr/0002-partner-event-api.html", cookie);
    assert.match(page.body, /Superseded by/);
    assert.match(page.body, /<li class="current"><a href="\/v\/main\/docs\/adr\/0002-partner-event-api\.html" aria-current="page">ADR-0002 /);
    assert.doesNotMatch(page.body + start.body, /Bearer|token "t"|github_pat/);
    const byId = await get(port, "/search?v=main&q=adr-3", cookie);
    assert.match(byId.body, /1 result for “adr-3”/);
    assert.match(byId.body, /<a href="\/v\/main\/docs\/adr\/0003-separate-event-database\.html"><span class="id">ADR-0003<\/span> Store partner events separately<\/a> <span class="badge s-accepted">accepted<\/span>/);
    assert.match((await get(port, "/search?v=main&q=flamingo", cookie)).body, /ADR-0003/);
    const sw = await get(port, "/switch?v=v0.2.0&p=docs/adr/0002-partner-event-api.html", cookie);
    assert.equal(sw.headers.location, "/v/v0.2.0/docs/adr/0002-partner-event-api.html");
    assert.equal((await get(port, "/switch?v=../x&p=a", cookie)).status, 400);
    assert.equal((await get(port, "/v/main/../../etc/passwd", cookie)).status, 404);
    assert.equal((await get(port, "/assets/style.css", cookie)).headers["content-type"], "text/css; charset=utf-8");
  });
  test("stale notice when meta/index is ahead; offline from cache with a note", async () => {
    const stale = await started(await siteRepo("f".repeat(40)));
    assert.match((await get(stale.port, "/v/main/", stale.cookie)).body, /<p class="note">This page may not be up to date yet\.<\/p>/);
    const fresh = await started(await siteRepo());
    assert.doesNotMatch((await get(fresh.port, "/v/main/", fresh.cookie)).body, /may not be up to date/);
    // Offline: the first view fills the cache, then the network fails.
    const r = await siteRepo();
    let online = true;
    const base = r.mock.fetch;
    const { port, cookie } = await started(r, ((i: string | URL | Request, init?: RequestInit) => (online ? base(i, init) : Promise.reject(new TypeError("fetch failed")))) as typeof fetch);
    await get(port, "/v/main/docs/adr/0001-store-data-in-postgresql.html", cookie);
    online = false;
    const off = await get(port, "/v/main/docs/adr/0001-store-data-in-postgresql.html", cookie);
    assert.equal(off.status, 200);
    assert.match(off.body, /Offline: GitHub could not be reached; showing the copy cached at /);
  });
});

describe("viewer type tabs", () => {
  async function viewer() {
    const r = await siteRepo();
    const v = createViewer({ source: new SiteSource(r.client(), uniq("cache"), 0), repository: "acme/docs", key: "k", secret: "s" });
    const { port } = await v.listen();
    after(() => v.close());
    const c = { cookie: "idc365_view=s" };
    return (path: string) => get(port, path, c);
  }
  const active = (body: string) => /<nav class="tabs"[^]*?<a href="[^"]*" class="active" aria-current="true">([^<]+)<\/a>/.exec(body)?.[1];
  const menuGroups = (body: string) => [...(/<nav class="side"[^]*?<\/nav>/.exec(body)?.[0] ?? "").matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
  test("tabs: All, ADR, Procedures, Tech stack, Releases, Attachments, Code, as plain links in the URL", async () => {
    const page = (await (await viewer())("/v/main/")).body;
    assert.deepEqual(TABS.map((t) => t.label), ["All", "ADR", "Procedures", "Tech stack", "Releases", "Attachments", "Code"]);
    assert.match(page, /<nav class="tabs" aria-label="Document types"><a href="\/v\/main\/" class="active" aria-current="true">All<\/a><a href="\/v\/main\/\?t=adr">ADR<\/a><a href="\/v\/main\/\?t=procedure">Procedures<\/a><a href="\/v\/main\/\?t=techstack">Tech stack<\/a><a href="\/v\/main\/\?t=release">Releases<\/a><a href="\/v\/main\/\?t=attachment">Attachments<\/a><a href="\/v\/main\/\?t=shadow">Code<\/a><\/nav>/);
    assert.equal(tabOf("nope"), "all");
    assert.equal(tabOf("techstack"), "techstack");
  });
  test("the menu shows only the selected type; All shows every group", async () => {
    const g = await viewer();
    assert.deepEqual(menuGroups((await g("/v/main/")).body), ["Architecture decisions", "Procedures", "Tech stack", "Releases", "Attachments", "Code"]);
    const adr = (await g("/v/main/?t=adr")).body;
    assert.deepEqual(menuGroups(adr), ["Architecture decisions"]);
    assert.equal(active(adr), "ADR");
    assert.doesNotMatch(/<nav class="side"[^]*?<\/nav>/.exec(adr)![0], /TECH-0001/);
  });
  test("the start page is filtered by the tab", async () => {
    const g = await viewer();
    const tech = (await g("/v/main/?t=techstack")).body;
    const rows = [...tech.matchAll(/<tr><td><a href="[^"]+">([^<]+)<\/a>/g)].map((m) => m[1]);
    assert.deepEqual(rows.sort(), ["TECH-0001", "TECH-0002"]);
    assert.match(tech, /main: 2 documents of type Tech stack\./);
    const all = (await g("/v/main/")).body;
    assert.ok([...all.matchAll(/<tr><td>/g)].length > 2);
  });
  test("a document page activates its own type's tab; relations to other types lead to pages with their own tab", async () => {
    const g = await viewer();
    const adr = (await g("/v/main/docs/adr/0001-store-data-in-postgresql.html?t=techstack")).body;
    assert.equal(active(adr), "ADR");
    assert.match(adr, /<a href="\.\.\/techstack\/0001-postgresql\.html">TECH-0001<\/a>/);
    assert.equal(active((await g("/v/main/docs/techstack/0001-postgresql.html")).body), "Tech stack");
    assert.equal(active((await g("/v/main/code/idconnectdk/idc365/src/db.ts.html")).body), "Code");
  });
  test("search covers every type whatever the tab, and shows each result's type", async () => {
    const g = await viewer();
    const r = (await g("/search?v=main&t=adr&q=postgresql")).body;
    assert.equal(active(r), "ADR", "the tab stays for the menu");
    const types = [...r.matchAll(/<li><span class="type">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.ok(types.includes("ADR") && types.includes("Tech stack"), types.join());
    assert.match(r, /all types/);
  });
  test("the tab is kept across a version switch", async () => {
    const g = await viewer();
    assert.match((await g("/v/main/?t=techstack")).body, /<input type="hidden" name="t" value="techstack">/);
    assert.equal((await g("/switch?v=v0.2.0&p=&t=techstack")).headers.location, "/v/v0.2.0/?t=techstack");
    assert.equal((await g("/switch?v=v0.2.0&p=docs/techstack/0001-postgresql.html&t=techstack")).headers.location, "/v/v0.2.0/docs/techstack/0001-postgresql.html");
    assert.equal((await g("/switch?v=v0.2.0&p=docs/adr/0099-none.html&t=adr")).headers.location, "/v/v0.2.0/?t=adr", "a missing page falls back to the tab's start page");
    assert.equal((await g("/switch?v=v0.2.0&t=evil")).headers.location, "/v/v0.2.0/");
  });
});

describe("helpers (paths, Windows, search)", () => {
  test("safePage accepts only site pages", () => {
    assert.equal(safePage("docs/adr/0001-a.html"), "docs/adr/0001-a.html");
    assert.equal(safePage("code/acme/app/src/_.html"), "code/acme/app/src/_.html");
    for (const bad of ["../x.html", "docs/../../x.html", "docs\\adr\\0001-a.html", "docs/adr/a.md", "/docs/a.html", "docs/%2e%2e/x.html", "site.json"]) assert.equal(safePage(bad), undefined, bad);
  });
  test("cache files are hashes, valid file names on Windows", () => {
    const f = cacheFile("C:\\Users\\a\\AppData\\Local\\idc365-decisions\\site", "acme/docs\0meta/site\0main/docs/adr/0001-a.html\0true");
    assert.match(f.split(/[\\/]/).pop()!, /^[0-9a-f]{64}\.json$/);
  });
  test("browser command per platform", () => {
    assert.deepEqual(openCommand("win32", "http://127.0.0.1:5/?key=a"), { command: "cmd", args: ["/c", "start", '""', "http://127.0.0.1:5/?key=a"] });
    assert.deepEqual(openCommand("linux", "u"), { command: "xdg-open", args: ["u"] });
    assert.deepEqual(openCommand("darwin", "u"), { command: "open", args: ["u"] });
  });
  test("cookies and search ranking", () => {
    assert.deepEqual(parseCookies("a=1; idc365_view=xyz"), { a: "1", idc365_view: "xyz" });
    const e = [
      { id: "ADR-0010", title: "Queue", state: "accepted", type: "adr", page: "a", text: "uses adr-1 words" },
      { id: "ADR-0001", title: "Database", state: "accepted", type: "adr", page: "b", text: "postgres" },
    ];
    assert.deepEqual(searchEntries(e, "ADR-0001").map((x) => x.id), ["ADR-0001"]);
    assert.deepEqual(searchEntries(e, "adr 1").map((x) => x.id)[0], "ADR-0001");
    assert.deepEqual(searchEntries(e, "postgres").map((x) => x.id), ["ADR-0001"]);
    assert.deepEqual(searchEntries(e, ""), []);
  });
});
