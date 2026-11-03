import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KINDS } from "../../src/docs/kinds.js";
import { listDocuments, showDocument, showShadow } from "../../src/docs/read.js";
import { createDocument, updateDocument, writeShadow, type DocFields, type WriteOk, type WriteResult } from "../../src/docs/write.js";
import { parseYaml, splitFrontmatter, validateDocuments } from "../../src/engine/index.js";
import { packageRoot } from "../../src/engine/package-root.js";
import { FakeRepo } from "./fakerepo.js";

const CONFIG_DIR = join(packageRoot(), "test", "fixtures", "valid", "config");
function config(overrides: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(CONFIG_DIR)) files[`config/${name}`] = readFileSync(join(CONFIG_DIR, name), "utf8");
  return { ...files, ...overrides };
}

function repo(extra: Record<string, string> = {}, cfg: Record<string, string> = {}): FakeRepo {
  const r = new FakeRepo();
  r.seed("main", { "README.md": "# docs\n", ...config(cfg), ...extra });
  return r;
}

const ADR_FIELDS: DocFields = {
  title: "Store service data in PostgreSQL",
  description: "All services keep relational data in PostgreSQL.",
  intent: "Where service data is stored.",
  when: "When a change stores data.",
  category: "data",
};
const BODY = "## Context\n\nNeed storage.\n\n## Decision\n\nUse PostgreSQL.\n\n## Consequences\n\nOne engine.\n";

function okResult(r: WriteResult): WriteOk {
  assert.ok(r.ok, `expected success, got ${JSON.stringify(r, null, 2)}`);
  return r;
}
function frontmatter(text: string): Record<string, unknown> {
  return parseYaml(splitFrontmatter(text)!.frontmatter) as Record<string, unknown>;
}

const existingAdr = (n: string, slug: string, extra = "") =>
  `---\nid: ADR-${n}\ntitle: Old ${n}\ndescription: d\nintent: i\nwhen: w\nstate: accepted\ncategory: data\n${extra}---\nOld body.\n`;

describe("adr create", () => {
  test("allocates the ID, writes the file on a new work branch from main and opens a PR", async () => {
    const r = repo();
    const res = okResult(await createDocument(r.client(), KINDS.adr, ADR_FIELDS, BODY, { version: "v1.0.1" }));
    assert.equal(res.key, "ADR-0001");
    assert.equal(res.file, "docs/adr/0001-store-service-data-in-postgresql.md");
    assert.equal(res.branch, "v1.0.1/adr-0001-store-service-data-in-postgresql");
    assert.equal(res.base, "main");
    assert.deepEqual(res.pr, { number: 1, url: "https://github.com/acme/docs/pull/1", opened: true });
    const text = r.files(res.branch).get(res.file)!;
    assert.deepEqual(frontmatter(text), { id: "ADR-0001", title: ADR_FIELDS.title, description: ADR_FIELDS.description, intent: ADR_FIELDS.intent, when: ADR_FIELDS.when, state: "accepted", category: "data" });
    assert.match(text, /## Context\n\nNeed storage\./);
    assert.equal(r.counters().ADR, 1);
    assert.equal(r.head(res.branch)!.message, "Add ADR-0001: Store service data in PostgreSQL");
    assert.equal(r.pulls[0]!.base, "main");
    assert.match(r.pulls[0]!.body, /- Add ADR-0001: Store service data in PostgreSQL \(`docs\/adr\/0001-store-service-data-in-postgresql\.md`\)/);
    assert.match(r.pulls[0]!.body, /The CLI never merges/);
    assert.equal(r.files("main").has(res.file), false, "main is untouched");
  });

  test("a new work branch is created at its first commit: one ref write, no fast-forward", async () => {
    const r = repo();
    const mainHead = r.refs.get("heads/main")!;
    const res = okResult(await createDocument(r.client(), KINDS.adr, ADR_FIELDS, BODY, { version: "v1.0.1" }));
    const refPosts = r.mock.callsTo("POST", "/repos/acme/docs/git/refs").map((c) => (c.body as { ref: string }).ref);
    assert.deepEqual(refPosts.filter((x) => x.startsWith("refs/heads/v1.0.1/")), [`refs/heads/${res.branch}`]);
    assert.equal(r.mock.callsTo("PATCH", new RegExp(`/git/refs/heads/${res.branch.replace(/[./]/g, "\\$&")}$`)).length, 0);
    const head = r.head(res.branch)!;
    assert.deepEqual(head.parents, [mainHead], "the first commit sits directly on main");
    assert.equal(r.refs.get(`heads/${res.branch}`), res.commit);
  });

  test("expands macros into reference links, definitions and relations", async () => {
    const r = repo({ "docs/adr/0007-old-storage.md": existingAdr("0007", "old-storage"), "docs/techstack/0003-postgresql.md": "---\nid: TECH-0003\n---\n" });
    const body = `${BODY}\nThis replaces {{ADR:7|supersedes|the old storage decision}} and uses {{TECH:3|uses|the engine}}; ticket {{JIRA:IDC-9|asked for it}}.\n`;
    const res = okResult(await createDocument(r.client(), KINDS.adr, ADR_FIELDS, body, { version: "v1.0.1" }));
    const text = r.files(res.branch).get(res.file)!;
    assert.match(text, /This replaces \[ADR-0007\]\[ADR-0007\] and uses \[TECH-0003\]\[TECH-0003\]; ticket \[JIRA:IDC-9\]\[JIRA:IDC-9\]\./);
    assert.match(text, /\n\[ADR-0007\]: \.\/0007-old-storage\.md\n\[TECH-0003\]: \.\.\/techstack\/0003-postgresql\.md\n\[JIRA:IDC-9\]: https:\/\/example\.atlassian\.net\/browse\/IDC-9\n$/);
    assert.deepEqual(frontmatter(text).relations, [
      { type: "supersedes", target: "ADR-0007", why: "the old storage decision", link: "./0007-old-storage.md" },
      { type: "uses", target: "TECH-0003", why: "the engine", link: "../techstack/0003-postgresql.md" },
      { type: "relates-to", target: "JIRA:IDC-9", why: "asked for it", link: "https://example.atlassian.net/browse/IDC-9" },
    ]);
    assert.deepEqual(validateDocuments(await cfg(r), [{ file: res.file, text }], [{ file: "docs/adr/0007-old-storage.md", key: "ADR-0007" }, { file: "docs/techstack/0003-postgresql.md", key: "TECH-0003" }]), []);
  });

  test("--branch adds to the existing work branch and its PR; references resolve on the branch", async () => {
    const r = repo();
    const c = r.client();
    const first = okResult(await createDocument(c, KINDS.adr, ADR_FIELDS, BODY, { version: "v1.0.1" }));
    const second = okResult(
      await createDocument(c, KINDS.adr, { ...ADR_FIELDS, title: "Use read replicas" }, `${BODY}\nSee {{ADR:1|supersedes|replaces the first}}.\n`, { branch: first.branch }),
    );
    assert.equal(second.key, "ADR-0002");
    assert.equal(second.branch, first.branch);
    assert.deepEqual(second.pr, { number: 1, url: first.pr.url, opened: false });
    assert.equal(r.pulls.length, 1);
    assert.match(r.pulls[0]!.body, /- Add ADR-0001.*\n- Add ADR-0002: Use read replicas/);
    const text = r.files(first.branch).get(second.file)!;
    assert.match(text, /\[ADR-0001\]: \.\/0001-store-service-data-in-postgresql\.md/);
    assert.equal(r.files(first.branch).size, r.files("main").size + 2);
  });

  test("a CODE reference without shadow document creates a placeholder in the same commit", async () => {
    const r = repo({ "code/idconnectdk/idc365/src/_.md": "---\ntitle: src\ndescription: d\nintent: i\nwhen: w\nstate: accepted\n---\n" });
    const proc = { title: "Deploy", description: "d", intent: "i", when: "w", category: "release" };
    const body = "## Trigger\n\nT\n\n## Roles\n\nR\n\n## Steps\n\n1. (agent) Run {{CODE:idconnectdk/idc365/deploy.sh|the script}} in {{CODE:idconnectdk/idc365/src/|the folder}}.\n\n## Done\n\nD\n";
    const res = okResult(await createDocument(r.client(), KINDS.proc, proc, body, { version: "v1.0.1" }));
    assert.deepEqual(res.placeholders, ["code/idconnectdk/idc365/deploy.sh.md"]);
    const files = r.files(res.branch);
    assert.deepEqual(frontmatter(files.get("code/idconnectdk/idc365/deploy.sh.md")!), { placeholder: true, relations: [] });
    assert.match(files.get(res.file)!, /\[CODE:idconnectdk\/idc365\/deploy\.sh\]: \.\.\/\.\.\/code\/idconnectdk\/idc365\/deploy\.sh\.md/);
    assert.match(files.get(res.file)!, /\[CODE:idconnectdk\/idc365\/src\]: \.\.\/\.\.\/code\/idconnectdk\/idc365\/src\/_\.md/);
    assert.match(r.head(res.branch)!.message, /\(\+ 1 placeholder shadow\)/);
  });

  test("TECH with packages and a BOM version", async () => {
    const r = repo();
    const res = okResult(
      await createDocument(
        r.client(),
        KINDS.tech,
        { title: "Spring Boot", description: "d", intent: "i", when: "w", category: "framework", ecosystem: "maven", bomVersion: "3.5.*", packages: [{ name: "org.springframework.boot:spring-boot-starter-web" }], rationale: "r", license: "Apache-2.0", lastReview: "2026-11-01", reviewIntervalMonths: 6 },
        "Notes.\n",
        { version: "v1.0.1" },
      ),
    );
    const fm = frontmatter(r.files(res.branch).get(res.file)!);
    assert.equal(fm.id, "TECH-0001");
    assert.equal(fm.version, "3.5.*");
    assert.deepEqual(fm.packages, [{ name: "org.springframework.boot:spring-boot-starter-web" }]);
    assert.equal(fm.last_review, "2026-11-01");
  });
});

async function cfg(r: FakeRepo) {
  const { loadConfigFromFiles } = await import("../../src/engine/index.js");
  const files = [...r.files("main")].filter(([p]) => p.startsWith("config/")).map(([p, text]) => ({ name: p.slice(7), text }));
  return loadConfigFromFiles(files).config!;
}

describe("refusals write nothing and allocate no ID", () => {
  const cases: [string, () => FakeRepo, DocFields, string, { version?: string; branch?: string }, RegExp][] = [
    ["macro without why", () => repo(), ADR_FIELDS, `${BODY}{{ADR:1}}`, { version: "v1.0.1" }, /no `why`/],
    ["unknown target", () => repo(), ADR_FIELDS, `${BODY}{{ADR:99|x}}`, { version: "v1.0.1" }, /ADR-0099` does not exist/],
    ["inverse type", () => repo({ "docs/adr/0001-a.md": existingAdr("0001", "a") }), ADR_FIELDS, `${BODY}{{ADR:1|superseded-by|x}}`, { version: "v1.0.1" }, /inverse relation/],
    ["unknown prefix", () => repo(), ADR_FIELDS, `${BODY}{{FOO:1|x}}`, { version: "v1.0.1" }, /unknown prefix/],
    ["Jira without base URL", () => repo({}, { "config/jira.yaml": "jira_base_url: null\n" }), ADR_FIELDS, `${BODY}{{JIRA:IDC-1|x}}`, { version: "v1.0.1" }, /no Jira base URL/],
    ["unconfigured code repository", () => repo(), ADR_FIELDS, `${BODY}{{CODE:other/repo/x.ts|x}}`, { version: "v1.0.1" }, /not configured/],
    ["unknown category", () => repo(), { ...ADR_FIELDS, category: "ui" }, BODY, { version: "v1.0.1" }, /category.unknown|does not validate/],
    ["intent over 200 characters", () => repo(), { ...ADR_FIELDS, intent: "x".repeat(201) }, BODY, { version: "v1.0.1" }, /does not validate/],
    ["missing version", () => repo(), ADR_FIELDS, BODY, {}, /no --version/],
    ["version that is not a patch and has no release branch", () => {
      const r = repo();
      r.tag("v1.0.0");
      return r;
    }, ADR_FIELDS, BODY, { version: "v1.1.0" }, /neither a patch/],
    ["missing work branch", () => repo(), ADR_FIELDS, BODY, { branch: "v1.0.1/nope" }, /does not exist/],
    ["--branch that is not a work branch", () => repo(), ADR_FIELDS, BODY, { branch: "main" }, /not a work branch/],
  ];
  for (const [name, make, fields, body, opts, re] of cases) {
    test(name, async () => {
      const r = make();
      const before = [...r.refs.keys()].sort();
      const res = await createDocument(r.client(), KINDS.adr, fields, body, opts);
      assert.equal(res.ok, false);
      if (!res.ok) {
        const all = [res.message, ...(res.problems ?? []).map((p) => p.message), ...(res.findings ?? []).map((f) => `${f.rule} ${f.message}`)].join("\n");
        assert.match(all, re);
        assert.ok(res.nextAction.length > 0);
      }
      assert.deepEqual([...r.refs.keys()].sort(), before, "no branch created");
      assert.equal(r.counters().ADR ?? 0, 0, "no ID allocated");
      assert.equal(r.pulls.length, 0);
    });
  }
});

describe("adr update", () => {
  test("corrects fields and body in the same file on a new work branch, refreshing links", async () => {
    const r = repo({
      "docs/adr/0001-store.md": existingAdr("0001", "store", "relations:\n  - type: uses\n    target: TECH-0003\n    why: engine\n    link: ../techstack/0003-old-slug.md\n").replace("Old body.\n", "Uses [TECH-0003][TECH-0003].\n\n[TECH-0003]: ../techstack/0003-old-slug.md\n"),
      "docs/techstack/0003-postgresql.md": "---\nid: TECH-0003\n---\n",
    });
    const res = okResult(await updateDocument(r.client(), KINDS.adr, "1", { state: "deprecated" }, undefined, { version: "v1.0.1" }));
    assert.equal(res.action, "updated");
    assert.equal(res.file, "docs/adr/0001-store.md");
    assert.equal(res.branch, "v1.0.1/update-adr-0001-old-0001");
    const text = r.files(res.branch).get(res.file)!;
    const fm = frontmatter(text);
    assert.equal(fm.state, "deprecated");
    assert.equal(fm.title, "Old 0001");
    assert.deepEqual(fm.relations, [{ type: "uses", target: "TECH-0003", why: "engine", link: "../techstack/0003-postgresql.md" }]);
    assert.match(text, /\[TECH-0003\]: \.\.\/techstack\/0003-postgresql\.md\n$/);
    assert.equal(r.head(res.branch)!.message, "Update ADR-0001: Old 0001");
  });
  test("replaces the body and adds relations from new macros", async () => {
    const r = repo({ "docs/adr/0001-a.md": existingAdr("0001", "a"), "docs/adr/0002-b.md": existingAdr("0002", "b") });
    const res = okResult(await updateDocument(r.client(), KINDS.adr, "ADR-0002", {}, "New body amending {{ADR:1|amends|adds a table}}.\n", { version: "v1.0.1" }));
    const fm = frontmatter(r.files(res.branch).get(res.file)!);
    assert.deepEqual(fm.relations, [{ type: "amends", target: "ADR-0001", why: "adds a table", link: "./0001-a.md" }]);
  });
  test("refuses a missing document", async () => {
    const res = await updateDocument(repo().client(), KINDS.adr, "ADR-0009", { state: "deprecated" }, undefined, { version: "v1.0.1" });
    assert.ok(!res.ok && /does not exist/.test(res.message));
  });
});

describe("tech update", () => {
  const TECH = "---\nid: TECH-0001\ntitle: React\ndescription: d\nintent: i\nwhen: w\nstate: accepted\ncategory: framework\necosystem: npm\npackages:\n  - name: react\n    version: \"19.*\"\n  - name: react-dom\n    version: \"19.*\"\nrationale: r\nlicense: MIT\nlast_review: \"2026-10-01\"\nreview_interval_months: 12\n---\nNotes.\n";
  test("--package replaces the package of that name and keeps the others; exemptions are added", async () => {
    const r = repo({ "docs/techstack/0001-react.md": TECH });
    const res = okResult(await updateDocument(r.client(), KINDS.tech, "1", { packages: [{ name: "react", version: "20.*" }, { name: "scheduler", version: "0.*" }], cooldownExemptions: [{ package: "react", version: "20.0.1", cve: "CVE-2026-12345", until: "2026-11-05" }] }, undefined, { version: "v1.0.1" }));
    const f = frontmatter(r.files(res.branch).get(res.file)!);
    assert.deepEqual(f.packages, [{ name: "react", version: "20.*" }, { name: "react-dom", version: "19.*" }, { name: "scheduler", version: "0.*" }]);
    assert.deepEqual(f.cooldown_exemptions, [{ package: "react", version: "20.0.1", cve: "CVE-2026-12345", until: "2026-11-05" }]);
  });
  test("a malformed exemption does not validate", async () => {
    const r = repo({ "docs/techstack/0001-react.md": TECH });
    const res = await updateDocument(r.client(), KINDS.tech, "1", { cooldownExemptions: [{ package: "react", version: "20.0.1", cve: "not-a-cve", until: "2026-11-05" }] }, undefined, { version: "v1.0.1" });
    assert.ok(!res.ok && (res.findings ?? []).some((x) => /cve/.test(x.message)));
  });
});

describe("show and list", () => {
  const r = repo({
    "docs/adr/0001-a.md": existingAdr("0001", "a"),
    "docs/adr/0002-b.md": existingAdr("0002", "b").replace("state: accepted", "state: deprecated"),
  });
  r.seed("v1.0.1/work", { "docs/adr/0003-c.md": existingAdr("0003", "c").replace("category: data", "category: security") }, "main");

  test("show prints frontmatter and body at a ref", async () => {
    const s = await showDocument(r.client(), KINDS.adr, "2", "main");
    assert.ok(s.ok);
    assert.equal(s.frontmatter.state, "deprecated");
    assert.equal(s.body, "Old body.\n");
    assert.equal((await showDocument(r.client(), KINDS.adr, "3", "main")).ok, false);
    assert.ok((await showDocument(r.client(), KINDS.adr, "3", "v1.0.1/work")).ok);
  });
  test("list with filters and --ref", async () => {
    assert.deepEqual((await listDocuments(r.client(), KINDS.adr, "main")).map((d) => `${d.id} ${d.state}`), ["ADR-0001 accepted", "ADR-0002 deprecated"]);
    assert.deepEqual((await listDocuments(r.client(), KINDS.adr, "main", { state: "accepted" })).map((d) => d.id), ["ADR-0001"]);
    assert.deepEqual((await listDocuments(r.client(), KINDS.adr, "v1.0.1/work", { category: "security" })).map((d) => d.id), ["ADR-0003"]);
    assert.deepEqual(await listDocuments(r.client(), KINDS.proc, "main"), []);
  });
});

describe("shadow documents", () => {
  const FIELDS = { title: "main.ts", description: "Entry point.", intent: "What starts the service.", when: "When changing startup." };
  const key = { key: "CODE:idconnectdk/idc365/src/main.ts", file: "code/idconnectdk/idc365/src/main.ts.md" };

  test("code create fills a placeholder and keeps its relations", async () => {
    const r = repo({ [key.file]: "---\nplaceholder: true\nrelations: []\n---\n" });
    const res = okResult(await writeShadow(r.client(), KINDS.code, "create", key, FIELDS, "Boots the service.\n", { version: "v1.0.1" }));
    assert.equal(res.branch, "v1.0.1/code-src-main-ts");
    const fm = frontmatter(r.files(res.branch).get(key.file)!);
    assert.deepEqual(fm, { title: "main.ts", description: "Entry point.", intent: "What starts the service.", when: "When changing startup.", state: "accepted" });
    const shown = await showShadow(r.client(), key, res.branch);
    assert.ok(shown.ok && shown.body === "Boots the service.\n");
  });
  test("code create refuses when a real document exists; update then works", async () => {
    const r = repo({ [key.file]: `---\ntitle: main.ts\ndescription: d\nintent: i\nwhen: w\nstate: accepted\n---\nBody\n` });
    const c = await writeShadow(r.client(), KINDS.code, "create", key, FIELDS, "x\n", { version: "v1.0.1" });
    assert.ok(!c.ok && /already documented/.test(c.message));
    const u = okResult(await writeShadow(r.client(), KINDS.code, "update", key, { intent: "Updated intent." }, undefined, { version: "v1.0.1" }));
    assert.equal(frontmatter(r.files(u.branch).get(key.file)!).intent, "Updated intent.");
  });
  test("refuses an unconfigured repository and update without document", async () => {
    const r = repo();
    const other = await writeShadow(r.client(), KINDS.code, "create", { key: "CODE:other/x/a.ts", file: "code/other/x/a.ts.md" }, FIELDS, "x\n", { version: "v1.0.1" });
    assert.ok(!other.ok && /not configured/.test(other.message));
    const upd = await writeShadow(r.client(), KINDS.code, "update", key, FIELDS, undefined, { version: "v1.0.1" });
    assert.ok(!upd.ok && /no shadow document/.test(upd.message));
  });
});

describe("markdown output", () => {
  test("a write ends with the PR URL and the review next action", async () => {
    const { renderWrite, renderRefusal } = await import("../../src/commands/docs.js");
    const r = repo();
    const res = await createDocument(r.client(), KINDS.adr, ADR_FIELDS, BODY, { version: "v1.0.1" });
    const md = renderWrite(KINDS.adr, res);
    assert.match(md, /^# Created ADR-0001\n/);
    assert.match(md, /- Pull request: #1 https:\/\/github\.com\/acme\/docs\/pull\/1 \(opened\)/);
    assert.match(md, /## Next action\n\nAsk the user to review and merge the PR: https:\/\/github\.com\/acme\/docs\/pull\/1\n/);
    const refused = await createDocument(r.client(), KINDS.adr, ADR_FIELDS, `${BODY}{{ADR:1}}`, { version: "v1.0.1" });
    assert.match(renderRefusal(refused as never), /^# Refused: 1 reference problem; nothing was written\n\n- `\{\{ADR:1\}\}` has no `why`\n  Fix: /);
  });
});
