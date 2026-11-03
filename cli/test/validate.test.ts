import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { loadConfig, validateTree, type RuleId } from "../src/engine/index.js";
import { packageRoot } from "../src/engine/package-root.js";

const VALID = join(packageRoot(), "test", "fixtures", "valid");
const temp = mkdtempSync(join(tmpdir(), "idc365-validate-"));
after(() => rmSync(temp, { recursive: true, force: true }));

let n = 0;
/** Copies the valid fixture tree to a fresh temp folder and applies a mutation. */
function tree(mutate: (t: Tree) => void): string {
  const root = join(temp, String(n++));
  cpSync(VALID, root, { recursive: true });
  mutate(new Tree(root));
  return root;
}

class Tree {
  constructor(readonly root: string) {}
  read(rel: string): string {
    return readFileSync(join(this.root, rel), "utf8");
  }
  write(rel: string, text: string | Buffer): void {
    mkdirSync(dirname(join(this.root, rel)), { recursive: true });
    writeFileSync(join(this.root, rel), text);
  }
  edit(rel: string, fn: (text: string) => string): void {
    this.write(rel, fn(this.read(rel)));
  }
  remove(rel: string): void {
    rmSync(join(this.root, rel), { recursive: true, force: true });
  }
}

const ADR1 = "docs/adr/0001-store-data-in-postgresql.md";
const ADR2 = "docs/adr/0002-partner-event-api.md";
const PROC1 = "docs/procedure/0001-documentation-workflow.md";
const TECH1 = "docs/techstack/0001-postgresql.md";
const ATT1 = "docs/attachment/0001-architecture-overview";
const ATT2 = "docs/attachment/0002-integration-spec";
const REL1 = "docs/release/0001-v2-0-0.md";
const DB = "code/idconnectdk/idc365/src/db.ts.md";

/** Asserts that validating the mutated tree yields `rule` (optionally on `file`). */
function expectRule(rule: RuleId, mutate: (t: Tree) => void, file?: string): void {
  const { findings } = validateTree(tree(mutate));
  const hit = findings.find((f) => f.rule === rule && (file === undefined || f.file === file));
  assert.ok(hit, `expected ${rule}${file ? ` on ${file}` : ""}, got:\n${findings.map((f) => `${f.file} ${f.rule} ${f.message}`).join("\n") || "(none)"}`);
  assert.ok(hit.message.length > 0 && hit.nextAction.length > 0);
}

describe("valid tree", () => {
  test("has no findings", () => {
    const r = validateTree(VALID);
    assert.deepEqual(r.findings, []);
    assert.equal(r.documents, 11);
  });
  test("the repository's default config/ is valid", () => {
    const { config, findings } = loadConfig(dirname(packageRoot()));
    assert.deepEqual(findings, []);
    assert.deepEqual(Object.keys(config!.categories.adr), ["architecture", "data", "security", "integration", "api", "infrastructure"]);
    assert.equal(config!.priming_budget, 8000);
  });
});

describe("configuration", () => {
  test("config.missing", () => expectRule("config.missing", (t) => t.remove("config")));
  test("config.parse", () => expectRule("config.parse", (t) => t.write("config/jira.yaml", "jira_base_url: [\n"), "config/jira.yaml"));
  test("config.schema: wrong type", () => expectRule("config.schema", (t) => t.write("config/priming.yaml", "priming_budget: lots\n"), "config/priming.yaml"));
  test("config.schema: key in two files", () => expectRule("config.schema", (t) => t.write("config/extra.yaml", "cooldown_days: 5\n"), "config/extra.yaml"));
  test("config.schema: missing key", () => expectRule("config.schema", (t) => t.remove("config/cooldown.yaml")));
});

describe("frontmatter", () => {
  test("frontmatter.parse: no frontmatter", () => expectRule("frontmatter.parse", (t) => t.write(PROC1, "# Just a body\n"), PROC1));
  test("frontmatter.parse: invalid YAML", () => expectRule("frontmatter.parse", (t) => t.edit(PROC1, (s) => s.replace("state: draft", "state: [draft")), PROC1));
  test("frontmatter.schema: unknown state", () => expectRule("frontmatter.schema", (t) => t.edit(PROC1, (s) => s.replace("state: draft", "state: rejected")), PROC1));
  test("frontmatter.schema: intent over 200 characters", () =>
    expectRule("frontmatter.schema", (t) => t.edit(PROC1, (s) => s.replace(/^intent: .*$/m, `intent: ${"x".repeat(201)}`)), PROC1));
  test("frontmatter.schema: unknown field", () => expectRule("frontmatter.schema", (t) => t.edit(PROC1, (s) => s.replace("state: draft", "state: draft\ndeciders: [me]")), PROC1));
  test("frontmatter.schema: missing required field", () => expectRule("frontmatter.schema", (t) => t.edit(PROC1, (s) => s.replace(/^when: .*\n/m, "")), PROC1));
  test("frontmatter.schema: TECH package without version and no BOM version", () =>
    expectRule("frontmatter.schema", (t) => t.edit(TECH1, (s) => s.replace('    version: "16.*"\n', "")), TECH1));
  test("frontmatter.schema: shadow document with an id", () =>
    expectRule("frontmatter.schema", (t) => t.edit("code/idconnectdk/idc365/src/_.md", (s) => s.replace("title: src", "id: CODE-1\ntitle: src")), "code/idconnectdk/idc365/src/_.md"));
  test("category.unknown", () => expectRule("category.unknown", (t) => t.edit(ADR1, (s) => s.replace("category: data", "category: ui")), ADR1));
});

describe("paths and IDs", () => {
  test("path.layout: unknown folder in docs/", () => expectRule("path.layout", (t) => t.write("docs/notes/x.md", "x"), "docs/notes"));
  test("path.layout: file name without number", () => expectRule("path.layout", (t) => t.write("docs/adr/readme.md", "x"), "docs/adr/readme.md"));
  test("path.layout: sub-folder in a type folder", () => expectRule("path.layout", (t) => t.write("docs/adr/old/0003-x.md", "x"), "docs/adr/old"));
  test("path.layout: non-markdown file in a type folder", () => expectRule("path.layout", (t) => t.write("docs/adr/0003-x.txt", "x"), "docs/adr/0003-x.txt"));
  test("path.slug", () =>
    expectRule("path.slug", (t) => {
      t.write("docs/procedure/0001-Documentation_Workflow.md", t.read(PROC1));
      t.remove(PROC1);
    }, "docs/procedure/0001-Documentation_Workflow.md"));
  test("path.id-mismatch", () => expectRule("path.id-mismatch", (t) => t.edit(PROC1, (s) => s.replace("id: PROC-0001", "id: PROC-0009")), PROC1));
  test("path.id-mismatch: wrong type prefix is a schema error", () => expectRule("frontmatter.schema", (t) => t.edit(PROC1, (s) => s.replace("id: PROC-0001", "id: ADR-0001")), PROC1));
  test("id.duplicate", () => expectRule("id.duplicate", (t) => t.write("docs/procedure/0001-copy.md", t.read(PROC1)), "docs/procedure/0001-copy.md"));
});

describe("shadow documents", () => {
  test("shadow.path: too shallow", () => expectRule("shadow.path", (t) => t.write("code/idconnectdk/readme.md", t.read("code/idconnectdk/idc365/src/_.md")), "code/idconnectdk/readme.md"));
  test("shadow.path: not markdown", () => expectRule("shadow.path", (t) => t.write("code/idconnectdk/idc365/src/main.ts", "code"), "code/idconnectdk/idc365/src/main.ts"));
  test("shadow.repo", () => expectRule("shadow.repo", (t) => t.write("code/other/repo/x.md", t.read("code/idconnectdk/idc365/src/_.md")), "code/other/repo/x.md"));
});

describe("relations", () => {
  test("relation.target: missing document", () => expectRule("relation.target", (t) => t.edit(ADR2, (s) => s.replace("target: ADR-0001", "target: ADR-0099")), ADR2));
  test("relation.target: missing shadow document", () => expectRule("relation.target", (t) => t.remove("code/idconnectdk/idc365/src/main.ts.md"), ADR1));
  test("relation.target: attachment relation to a non-attachment", () =>
    expectRule("relation.target", (t) => t.edit(ADR2, (s) => s.replace("type: amends", "type: attachment")), ADR2));
  test("relation.target: Jira without base URL", () => expectRule("relation.target", (t) => t.write("config/jira.yaml", "jira_base_url: null\n"), ADR1));
  test("relation.target: malformed target is a schema error", () => expectRule("frontmatter.schema", (t) => t.edit(ADR2, (s) => s.replace("target: ADR-0001", "target: adr 1")), ADR2));
  test("relation.why: missing", () => expectRule("relation.why", (t) => t.edit(ADR2, (s) => s.replace("    why: Adds an event store table to the data decision.\n", "")), ADR2));
  test("relation.why: empty", () => expectRule("relation.why", (t) => t.edit(ADR2, (s) => s.replace("why: Adds an event store table to the data decision.", 'why: ""')), ADR2));
});

describe("links", () => {
  test("link.undefined", () => expectRule("link.undefined", (t) => t.edit(ADR2, (s) => s.replace("Changes to the spec", "See [the other][ADR-0042]. Changes to the spec")), ADR2));
  test("link.inline", () => expectRule("link.inline", (t) => t.edit(ADR2, (s) => s.replace("Changes to the spec", "See [x](../techstack/0001-postgresql.md). Changes to the spec")), ADR2));
  test("link.relation: definition without relation", () =>
    expectRule("link.relation", (t) => t.edit(ADR1, (s) => `${s}[PROC-0001]: ../procedure/0001-documentation-workflow.md\n`), ADR1));
  test("link.relation: label that is not an ID", () => expectRule("link.relation", (t) => t.edit(ADR1, (s) => `${s}[notes]: ../procedure/0001-documentation-workflow.md\n`), ADR1));
  test("link.path: definition points elsewhere", () =>
    expectRule("link.path", (t) => t.edit(ADR2, (s) => s.replace("[ADR-0001]: 0001-store-data-in-postgresql.md", "[ADR-0001]: 0001-old-slug.md")), ADR2));
  test("link.path: relation link stale after a slug change", () =>
    expectRule("link.path", (t) => {
      t.write("docs/techstack/0001-postgres-database.md", t.read(TECH1));
      t.remove(TECH1);
    }, ADR1));
});

describe("attachments", () => {
  test("attachment.pair: metadata without binary", () => expectRule("attachment.pair", (t) => t.remove(`${ATT1}.png`), `${ATT1}.md`));
  test("attachment.pair: binary without metadata", () => expectRule("attachment.pair", (t) => t.remove(`${ATT2}.md`), `${ATT2}.pdf`));
  test("attachment.pair: two binaries", () => expectRule("attachment.pair", (t) => t.write(`${ATT1}.jpg`, "x"), `${ATT1}.jpg`));
  test("attachment.type", () =>
    expectRule("attachment.type", (t) => {
      t.write("docs/attachment/0003-notes.txt", "notes");
      t.write("docs/attachment/0003-notes.md", t.read(`${ATT2}.md`).replace("ATT-0002", "ATT-0003"));
    }, "docs/attachment/0003-notes.txt"));
  test("attachment.size (LFS pointer size counts)", () =>
    expectRule("attachment.size", (t) => t.edit("config/attachments.yaml", (s) => s.replace("attachment_max_bytes: 26214400", "attachment_max_bytes: 1000")), `${ATT2}.pdf`));
  test("attachment.metadata: size", () => expectRule("attachment.metadata", (t) => t.edit(`${ATT2}.md`, (s) => s.replace("size: 12345", "size: 1")), `${ATT2}.md`));
  test("attachment.metadata: sha256", () => expectRule("attachment.metadata", (t) => t.edit(`${ATT1}.md`, (s) => s.replace(/sha256: [0-9a-f]+/, `sha256: ${"0".repeat(64)}`)), `${ATT1}.md`));
  test("attachment.metadata: media type", () => expectRule("attachment.metadata", (t) => t.edit(`${ATT1}.md`, (s) => s.replace("media_type: image/png", "media_type: image/jpeg")), `${ATT1}.md`));
});

describe("priming budget", () => {
  test("priming.budget", () => expectRule("priming.budget", (t) => t.write("config/priming.yaml", "priming_budget: 100\n"), ADR1));
  test("fits when no document is featured; the PR check reports the character count", () => {
    const r = validateTree(tree((t) => {
      t.write("config/priming.yaml", "priming_budget: 5000\n");
      t.edit(ADR1, (s) => s.replace("featured: true\n", ""));
    }));
    assert.deepEqual(r.findings, []);
    assert.match(r.notes[0]!.message, /^priming is [0-9]+ characters of 5000 \(instructions with sample release text [0-9]+; featured: none\)$/);
    assert.equal(r.notes[0]!.file, "config/instructions.md");
  });
  test("the instructions count: a long instruction text alone goes over the budget", () => {
    const r = validateTree(tree((t) => {
      t.write("config/priming.yaml", "priming_budget: 5000\n");
      t.edit(ADR1, (s) => s.replace("featured: true\n", ""));
      t.edit("config/instructions.md", (s) => s + "\n" + "Extra line of instructions. ".repeat(80));
    }));
    assert.deepEqual(r.findings.map((f) => `${f.rule} ${f.file}`), ["priming.budget config/instructions.md"]);
    assert.match(r.findings[0]!.message, /over the budget of 5000/);
  });
  test("instructions.missing", () => expectRule("instructions.missing", (t) => t.remove("config/instructions.md"), "config/instructions.md"));
  test("instructions.placeholder: missing or twice", () => {
    expectRule("instructions.placeholder", (t) => t.edit("config/instructions.md", (s) => s.replace("{{commands}}", "")), "config/instructions.md");
    expectRule("instructions.placeholder", (t) => t.edit("config/instructions.md", (s) => s + "\n{{featured}}\n"), "config/instructions.md");
  });
});

describe("inverse relations", () => {
  test("relation.inverse: no forward relation in the target", () =>
    expectRule("relation.inverse", (t) => t.edit(ADR2, (s) => s.replace("type: amends", "type: relates-to")), ADR1));
  test("relation.inverse: forward relation of another type", () =>
    expectRule("relation.inverse", (t) => t.edit(ADR2, (s) => s.replace("type: amends", "type: supersedes")), ADR1));
  test("relation.inverse: attached-to without attachment relation", () =>
    expectRule("relation.inverse", (t) => t.edit(`${ATT1}.md`, (s) => s.replace("target: ADR-0001", "target: ADR-0002").replace("../adr/0001-store-data-in-postgresql.md", "../adr/0002-partner-event-api.md")), `${ATT1}.md`));
  test("relation.inverse: inverse type to Jira", () =>
    expectRule("relation.inverse", (t) => t.edit(ADR1, (s) => s.replace("type: relates-to\n    target: JIRA:IDC-123", "type: used-by\n    target: JIRA:IDC-123")), ADR1));
  test("unknown relation type is a schema error", () => expectRule("frontmatter.schema", (t) => t.edit(ADR2, (s) => s.replace("type: amends", "type: replaces")), ADR2));
});

describe("placeholder shadow documents", () => {
  test("placeholder with only relations passes (valid tree)", () => {
    const { findings } = validateTree(VALID);
    assert.equal(findings.filter((f) => f.file === DB).length, 0);
  });
  test("placeholder with other fields is a schema error", () =>
    expectRule("frontmatter.schema", (t) => t.edit(DB, (s) => s.replace("placeholder: true", "placeholder: true\ntitle: db.ts")), DB));
  test("placeholder without relations is a schema error", () =>
    expectRule("frontmatter.schema", (t) => t.write(DB, "---\nplaceholder: true\n---\n"), DB));
  test("placeholder: false is a schema error", () =>
    expectRule("frontmatter.schema", (t) => t.edit(DB, (s) => s.replace("placeholder: true", "placeholder: false")), DB));
  test("placeholder on another type is a schema error", () =>
    expectRule("frontmatter.schema", (t) => t.edit(PROC1, (s) => s.replace("state: draft", "state: draft\nplaceholder: true")), PROC1));
});

describe("releases", () => {
  test("release.repo", () => expectRule("release.repo", (t) => t.edit(REL1, (s) => s.replace("repo: idconnectdk/idc365", "repo: idconnectdk/unknown")), REL1));
});

describe("macros", () => {
  test("macro.unexpanded", () => expectRule("macro.unexpanded", (t) => t.edit(PROC1, (s) => s.replace("The PR is merged.", "The PR is merged. See {{ADR:0001|relates-to|why}}.")), PROC1));
  test("macro.unexpanded: unknown prefix too", () => expectRule("macro.unexpanded", (t) => t.edit(PROC1, (s) => s.replace("The PR is merged.", "The PR is merged {{ADRR:1}}.")), PROC1));
});
