import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { checkFile, createAttachment, getAttachment, lfsAttributes, showAttachment, withLfsAttributes } from "../src/docs/attachments.js";
import { loadConfigFromFiles, parseYaml, splitFrontmatter, validateTree } from "../src/engine/index.js";
import { packageRoot } from "../src/engine/package-root.js";
import { downloadObject, GitHubError, parsePointer, pointerText, sha256, uploadObject } from "../src/github/index.js";
import { FakeRepo } from "./docs/fakerepo.js";
import { R } from "./github/mock.js";

const VALID = join(packageRoot(), "test", "fixtures", "valid");
const CONFIG_DIR = join(VALID, "config");
const temp = mkdtempSync(join(tmpdir(), "idc365-att-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const fm = (text: string) => parseYaml(splitFrontmatter(text)!.frontmatter) as Record<string, unknown>;
const configFiles = () => Object.fromEntries(readdirSync(CONFIG_DIR).map((n) => [`config/${n}`, readFileSync(join(CONFIG_DIR, n), "utf8")]));
const config = () => loadConfigFromFiles(readdirSync(CONFIG_DIR).map((n) => ({ name: n, text: readFileSync(join(CONFIG_DIR, n), "utf8") }))).config!;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");

/** FakeRepo plus a fake Git LFS server (batch, object storage, verify). */
function lfsRepo(extra: Record<string, string> = {}) {
  const r = new FakeRepo();
  r.seed("main", { "README.md": "x", ...configFiles(), ...extra });
  const store = new Map<string, Buffer>();
  const calls: string[] = [];
  const base = r.mock.fetch;
  const fetchWithLfs = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    if (url.endsWith(".git/info/lfs/objects/batch")) {
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push(`batch ${JSON.parse(String(init?.body)).operation} auth=${h.Authorization?.startsWith("Basic ") ? "basic" : "none"} accept=${h.Accept}`);
      const body = JSON.parse(String(init?.body)) as { operation: string; objects: { oid: string; size: number }[] };
      const o = body.objects[0]!;
      const actions = body.operation === "upload"
        ? store.has(o.oid) ? undefined : { upload: { href: `https://store.test/${o.oid}`, header: { "x-amz-content-sha256": o.oid } }, verify: { href: "https://lfs.test/verify", header: { Authorization: "RemoteAuth v" } } }
        : store.has(o.oid) ? { download: { href: `https://store.test/${o.oid}` } } : undefined;
      const obj = actions ? { ...o, actions } : body.operation === "download" ? { ...o, error: { code: 404, message: "Object does not exist on the server" } } : o;
      return new Response(JSON.stringify({ objects: [obj] }), { status: 200, headers: { "content-type": "application/vnd.git-lfs+json" } });
    }
    if (url.startsWith("https://store.test/")) {
      const oid = url.split("/").pop()!;
      if (init?.method === "PUT") {
        calls.push("PUT object");
        store.set(oid, Buffer.from(init.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      calls.push("GET object");
      return new Response(new Uint8Array(store.get(oid)!), { status: 200 });
    }
    if (url === "https://lfs.test/verify") {
      calls.push(`verify ${String(init?.body)}`);
      return new Response(null, { status: 200 });
    }
    return base(input, init);
  }) as typeof fetch;
  const client = () => {
    const c = r.client();
    Object.defineProperty(c, "fetcher", { get: () => fetchWithLfs });
    (c as unknown as { fetchImpl: typeof fetch }).fetchImpl = fetchWithLfs;
    return c;
  };
  return { r, store, calls, client };
}

function file(name: string, data: Buffer): string {
  const p = join(temp, `${Math.random().toString(36).slice(2)}-${name}`);
  writeFileSync(p, data);
  return p;
}

const FIELDS = { title: "Architecture overview", description: "Overview diagram.", intent: "The big picture of the system.", when: "When you need the overall structure." };

describe("pointer format and LFS client", () => {
  test("pointer text round-trips", () => {
    const p = { oid: sha256(PNG), size: PNG.length };
    assert.equal(pointerText(p), `version https://git-lfs.github.com/spec/v1\noid sha256:${p.oid}\nsize ${PNG.length}\n`);
    assert.deepEqual(parsePointer(pointerText(p)), p);
    assert.equal(parsePointer("not a pointer"), undefined);
  });
  test("upload: batch with basic auth and LFS media type, PUT to the href with its headers, then verify; a stored object is not uploaded again", async () => {
    const { client, calls, store } = lfsRepo();
    const up = await uploadObject(client(), PNG);
    assert.deepEqual(up, { oid: sha256(PNG), size: PNG.length, uploaded: true, verified: true });
    assert.deepEqual(calls.slice(0, 3), [`batch upload auth=basic accept=application/vnd.git-lfs+json`, "PUT object", `verify {"oid":"${sha256(PNG)}","size":${PNG.length}}`]);
    assert.ok(store.get(sha256(PNG))!.equals(PNG));
    const again = await uploadObject(client(), PNG);
    assert.deepEqual([again.uploaded, again.verified], [false, false]);
  });
  test("download checks size and sha256; a missing object is a clear error", async () => {
    const { client, store } = lfsRepo();
    await uploadObject(client(), PNG);
    assert.ok((await downloadObject(client(), { oid: sha256(PNG), size: PNG.length })).equals(PNG));
    store.set(sha256(PNG), Buffer.from("tampered"));
    await assert.rejects(downloadObject(client(), { oid: sha256(PNG), size: PNG.length }), /does not match its pointer/);
    await assert.rejects(downloadObject(client(), { oid: "0".repeat(64), size: 1 }), (e: unknown) => e instanceof GitHubError && /no object/.test(e.message));
  });
});

describe("att create", () => {
  test("refuses a disallowed type or an oversize file before anything else (no ID, no upload, no branch)", async () => {
    const { r, client, calls } = lfsRepo();
    const txt = await createAttachment(client(), file("notes.txt", Buffer.from("x")), FIELDS, undefined, { version: "v1.0.1" });
    assert.ok(!txt.ok && /`\.txt` files are not allowed/.test(txt.message));
    const big = Buffer.alloc(config().attachment_max_bytes + 1);
    const huge = await createAttachment(client(), file("huge.png", big), FIELDS, undefined, { version: "v1.0.1" });
    assert.ok(!huge.ok && /the maximum is/.test(huge.message));
    assert.equal(r.counters().ATT ?? 0, 0);
    assert.deepEqual(calls, []);
    assert.equal(r.pulls.length, 0);
  });
  test("uploads, commits pointer + metadata + .gitattributes in one commit and opens the PR; the result validates", async () => {
    const { r, client, store } = lfsRepo();
    const res = await createAttachment(client(), file("overview.png", PNG), FIELDS, undefined, { version: "v1.0.1" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.key, "ATT-0001");
    assert.equal(res.file, "docs/attachment/0001-architecture-overview.md");
    const files = r.files(res.branch);
    assert.deepEqual(parsePointer(files.get("docs/attachment/0001-architecture-overview.png")!), { oid: sha256(PNG), size: PNG.length });
    assert.deepEqual(Object.fromEntries(Object.entries(fm(files.get(res.file)!)).filter(([k]) => ["media_type", "size", "sha256"].includes(k))), { media_type: "image/png", size: PNG.length, sha256: sha256(PNG) });
    assert.ok(lfsAttributes(config()).every((l) => files.get(".gitattributes")!.includes(l)));
    assert.ok(!files.get(".gitattributes")!.includes("*.md"), "metadata stays plain text");
    assert.ok(store.has(sha256(PNG)));
    assert.match(r.head(res.branch)!.message, /^Attach ATT-0001: Architecture overview$/);
    // The branch as a tree validates (pointer matches the metadata).
    const root = join(temp, `tree-${Math.random().toString(36).slice(2)}`);
    cpSync(VALID, root, { recursive: true });
    rmSync(join(root, "docs"), { recursive: true });
    rmSync(join(root, "code"), { recursive: true });
    for (const [p, text] of files) if (p.startsWith("docs/")) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    const v = validateTree(root);
    assert.deepEqual(v.findings, []);
    assert.deepEqual(v.notes.filter((n) => !n.message.startsWith("priming is")).map((n) => n.message), ["nothing links to ATT-0001"]);
  });
  test("an existing .gitattributes is kept and only completed", () => {
    const c = config();
    assert.equal(withLfsAttributes(lfsAttributes(c).join("\n") + "\n", c), undefined);
    const merged = withLfsAttributes("*.sh text eol=lf\n", c)!;
    assert.match(merged, /^\*\.sh text eol=lf\n\n# Attachment binaries/);
  });
  test("--supersedes adds the relation; show lists the documents still linking to the old version", async () => {
    const old = "---\nid: ATT-0001\ntitle: Old\ndescription: d\nintent: i\nwhen: w\nstate: superseded\nmedia_type: image/png\nsize: 1\nsha256: " + "a".repeat(64) + "\nrelations:\n  - type: superseded-by\n    target: ATT-0002\n    why: New version\n    link: ./0002-new.md\n---\n";
    const adr = "---\nid: ADR-0001\ntitle: A\ndescription: d\nintent: i\nwhen: w\nstate: accepted\ncategory: data\nrelations:\n  - type: attachment\n    target: ATT-0001\n    why: The diagram.\n    link: ../attachment/0001-old.md\n---\nSee [ATT-0001][ATT-0001].\n\n[ATT-0001]: ../attachment/0001-old.md\n";
    const { r, client } = lfsRepo({ "docs/attachment/0001-old.md": old, "docs/attachment/0001-old.png": pointerText({ oid: "a".repeat(64), size: 1 }), "docs/adr/0001-a.md": adr });
    r.seed("meta/ids", { "counters.json": JSON.stringify({ ADR: 1, PROC: 0, TECH: 0, REL: 0, ATT: 1 }) });
    const res = await createAttachment(client(), file("v2.png", PNG), { ...FIELDS, title: "New" }, undefined, { version: "v1.0.1", supersedes: "1", why: "Updated colours." });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(fm(r.files(res.branch).get(res.file)!).relations, [{ type: "supersedes", target: "ATT-0001", why: "Updated colours.", link: "./0001-old.md" }]);
    const shown = await showAttachment(client(), "ATT-0001", "main");
    assert.ok(shown.ok);
    assert.deepEqual([shown.state, shown.supersededBy, shown.linkers], ["superseded", ["ATT-0002"], [{ id: "ADR-0001", type: "attachment" }]]);
    assert.equal(shown.binary, "docs/attachment/0001-old.png");
  });
});

describe("att get", () => {
  test("downloads through LFS and checks the sha256 against the metadata", async () => {
    const { client } = lfsRepo();
    const created = await createAttachment(client(), file("overview.png", PNG), FIELDS, undefined, { version: "v1.0.1" });
    assert.ok(created.ok);
    const got = await getAttachment(client(), "ATT-0001", created.branch);
    assert.ok(got.ok);
    assert.ok(got.data.equals(PNG));
    assert.equal(got.name, "0001-architecture-overview.png");
  });
});

describe("checkFile and validation notes", () => {
  test("checkFile", () => {
    const c = config();
    assert.deepEqual(checkFile(file("a.PNG", PNG), c), { ext: "png", mediaType: "image/png", size: PNG.length });
    assert.equal("ok" in checkFile(file("a.exe", PNG), c), true);
  });
  test("a document still linking to a superseded attachment is a note, not a failure", () => {
    const root = join(temp, `notes-${Math.random().toString(36).slice(2)}`);
    cpSync(VALID, root, { recursive: true });
    const p = join(root, "docs/attachment/0001-architecture-overview.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("state: accepted", "state: superseded"));
    const v = validateTree(root);
    assert.deepEqual(v.findings, []);
    assert.deepEqual(v.notes.filter((n) => !n.message.startsWith("priming is")), [{ file: "docs/adr/0001-store-data-in-postgresql.md", message: "still links to the superseded ATT-0001" }]);
  });
  test("the new version that supersedes an attachment is not counted as still linking to it", () => {
    const root = join(temp, `sup-${Math.random().toString(36).slice(2)}`);
    cpSync(VALID, root, { recursive: true });
    const p = join(root, "docs/attachment/0001-architecture-overview.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("state: accepted", "state: superseded"));
    const p2 = join(root, "docs/attachment/0002-integration-spec.md");
    writeFileSync(p2, readFileSync(p2, "utf8").replace("state: accepted", "state: accepted\nrelations:\n  - type: supersedes\n    target: ATT-0001\n    why: New version.\n    link: ./0001-architecture-overview.md"));
    const notes = validateTree(root).notes.map((n) => `${n.file} ${n.message}`);
    assert.ok(!notes.some((n) => n.startsWith("docs/attachment/0002-integration-spec.md still links")), notes.join("\n"));
    assert.ok(notes.some((n) => n.startsWith("docs/adr/0001-store-data-in-postgresql.md still links")));
  });
  test("an oversize or disallowed binary in a PR fails validation", () => {
    const root = join(temp, `bad-${Math.random().toString(36).slice(2)}`);
    cpSync(VALID, root, { recursive: true });
    writeFileSync(join(root, "docs/attachment/0003-notes.txt"), "x");
    writeFileSync(join(root, "docs/attachment/0003-notes.md"), readFileSync(join(root, "docs/attachment/0002-integration-spec.md"), "utf8").replace("ATT-0002", "ATT-0003"));
    writeFileSync(join(root, "docs/attachment/0002-integration-spec.pdf"), pointerText({ oid: "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393", size: 30 * 1024 * 1024 }));
    const rules = validateTree(root).findings.map((f) => `${f.rule} ${f.file}`);
    assert.ok(rules.includes("attachment.type docs/attachment/0003-notes.txt"));
    assert.ok(rules.includes("attachment.size docs/attachment/0002-integration-spec.pdf"));
  });
});

void R;
