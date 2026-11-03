import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { loadConfig, parseYaml, splitFrontmatter, validateTree } from "../src/engine/index.js";
import { packageRoot } from "../src/engine/package-root.js";
import { applyEdit, planEdits, postMerge, readTree } from "../src/postmerge/postmerge.js";
import { FakeRepo } from "./docs/fakerepo.js";

const VALID = join(packageRoot(), "test", "fixtures", "valid");
const temp = mkdtempSync(join(tmpdir(), "idc365-postmerge-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const git = (root: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" }).trim();
const fm = (text: string) => parseYaml(splitFrontmatter(text)!.frontmatter) as Record<string, unknown>;

const ADR3 = `---
id: ADR-0003
title: Store partner events in a separate database
description: Replaces the partner event decision.
intent: Where partner events are stored now.
when: When code sends or receives partner events.
state: accepted
category: api
relations:
  - type: supersedes
    target: ADR-0002
    why: Events move to their own database.
    link: ./0002-partner-event-api.md
  - type: relates-to
    target: PROC-0001
    why: Written with the documentation workflow.
    link: ../procedure/0001-documentation-workflow.md
  - type: relates-to
    target: JIRA:IDC-7
    why: The ticket.
    link: https://example.atlassian.net/browse/IDC-7
---
## Context

Load grew; see [ADR-0002][ADR-0002].

## Decision

A separate database.

## Consequences

Two databases.

[ADR-0002]: ./0002-partner-event-api.md
`;

/** A git checkout of the valid tree: `before` commit, then ADR-0003 that supersedes ADR-0002. */
function checkout() {
  const root = join(temp, Math.random().toString(36).slice(2));
  cpSync(VALID, root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "before");
  const before = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "docs/adr/0003-separate-event-database.md"), ADR3);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "merge ADR-0003");
  return { root, before, after: git(root, "rev-parse", "HEAD") };
}

/** A FakeRepo whose main holds the checkout's files. */
function remoteOf(root: string): FakeRepo {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(root, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  const r = new FakeRepo();
  r.seed("main", files);
  return r;
}

describe("post-merge planning", () => {
  test("supersedes → superseded-by plus state superseded; relates-to → relates-to; Jira and existing inverses are skipped", () => {
    const { root } = checkout();
    const docs = readTree(root, loadConfig(root).config!);
    const edits = planEdits(docs, new Set(["docs/adr/0003-separate-event-database.md"]));
    assert.deepEqual(
      edits.map((e) => ({ key: e.key, add: e.add.map((a) => `${a.type} ${a.target} ${a.link}`), state: e.state })),
      [
        { key: "ADR-0002", add: ["superseded-by ADR-0003 ./0003-separate-event-database.md"], state: "superseded" },
        { key: "PROC-0001", add: ["relates-to ADR-0003 ../adr/0003-separate-event-database.md"], state: undefined },
      ],
    );
  });

  test("amends writes amended-by only; inverses that exist are not written again", () => {
    const { root } = checkout();
    const docs = readTree(root, loadConfig(root).config!);
    // The fixture already has ADR-0002 amends ADR-0001 with ADR-0001's amended-by, and the TECH/ATT inverses.
    const all = planEdits(docs, "all");
    assert.equal(all.find((e) => e.key === "ADR-0001")?.add.some((a) => a.type === "amended-by"), undefined);
    assert.equal(all.find((e) => e.key === "ADR-0001")?.state, undefined, "amends sets no state");
  });

  test("applyEdit keeps the body and is idempotent", () => {
    const { root } = checkout();
    const docs = readTree(root, loadConfig(root).config!);
    const edit = planEdits(docs, new Set(["docs/adr/0003-separate-event-database.md"]))[0]!;
    const before = readFileSync(join(root, edit.file), "utf8");
    const once = applyEdit(before, edit);
    assert.equal(applyEdit(once, edit), once);
    assert.equal(fm(once).state, "superseded");
    assert.equal(splitFrontmatter(once)!.body, splitFrontmatter(before)!.body);
  });
});

describe("post-merge run", () => {
  test("commits the edits as one bot commit on the branch head; the result validates clean", async () => {
    const { root, before, after: head } = checkout();
    const remote = remoteOf(root);
    const mainBefore = remote.refs.get("heads/main")!;
    const r = await postMerge({ root, branch: "main", before, after: head, client: remote.client() });
    assert.equal(r.outcome, "committed");
    assert.deepEqual(r.changed, ["docs/adr/0003-separate-event-database.md"]);
    assert.deepEqual(r.findings, []);
    const commit = remote.head("main")!;
    assert.deepEqual(commit.parents, [mainBefore]);
    assert.match(commit.message, /^Post-merge: ADR-0002 ← superseded-by ADR-0003, state superseded \(ADR-0003 supersedes it\); PROC-0001 ← relates-to ADR-0003$/);
    const adr2 = fm(remote.files("main").get("docs/adr/0002-partner-event-api.md")!);
    assert.equal(adr2.state, "superseded");
    assert.ok((adr2.relations as { type: string; target: string }[]).some((x) => x.type === "superseded-by" && x.target === "ADR-0003"));
    // The bot's result validates as a whole tree.
    const out = join(temp, "result");
    rmSync(out, { recursive: true, force: true });
    cpSync(root, out, { recursive: true });
    for (const [p, text] of remote.files("main")) if (p.endsWith(".md")) writeFileSync(join(out, p), text);
    assert.deepEqual(validateTree(out).findings, []);
  });

  test("the run after the bot's commit finds nothing to do and writes nothing", async () => {
    const { root, before, after: head } = checkout();
    const remote = remoteOf(root);
    await postMerge({ root, branch: "main", before, after: head, client: remote.client() });
    // The checkout of the bot's commit: apply the same edits locally and commit.
    const docs = readTree(root, loadConfig(root).config!);
    for (const e of planEdits(docs, "all")) writeFileSync(join(root, e.file), applyEdit(readFileSync(join(root, e.file), "utf8"), e));
    git(root, "commit", "-qam", "bot");
    const botCommit = git(root, "rev-parse", "HEAD");
    const headBefore = remote.refs.get("heads/main");
    const again = await postMerge({ root, branch: "main", before: head, after: botCommit, client: remote.client() });
    assert.equal(again.outcome, "nothing");
    assert.equal(remote.refs.get("heads/main"), headBefore, "no new commit");
  });

  test("a concurrent run that already wrote the edits leads to no commit", async () => {
    const { root, before, after: head } = checkout();
    const remote = remoteOf(root);
    await postMerge({ root, branch: "main", before, after: head, client: remote.client() });
    const headAfterFirst = remote.refs.get("heads/main");
    git(root, "checkout", "-q", "--", ".");
    const second = await postMerge({ root, branch: "main", before, after: head, client: remote.client() });
    assert.equal(second.outcome, "nothing");
    assert.equal(remote.refs.get("heads/main"), headAfterFirst);
  });

  test("a branch that moved meanwhile gets the edits applied on its new head", async () => {
    const { root, before, after: head } = checkout();
    const remote = remoteOf(root);
    remote.seed("main", { "docs/procedure/0001-documentation-workflow.md": readFileSync(join(root, "docs/procedure/0001-documentation-workflow.md"), "utf8").replace("The PR is merged.", "The PR is merged and indexed.") });
    const r = await postMerge({ root, branch: "main", before, after: head, client: remote.client() });
    assert.equal(r.outcome, "committed");
    const proc = remote.files("main").get("docs/procedure/0001-documentation-workflow.md")!;
    assert.match(proc, /merged and indexed/, "the other merge is kept");
    assert.ok((fm(proc).relations as { target: string }[]).some((x) => x.target === "ADR-0003"));
  });

  test("an edit that would not validate is not committed", async () => {
    const { root, before, after: head } = checkout();
    // Break the tree in a way the edits do not fix: a duplicate ID.
    writeFileSync(join(root, "docs/adr/0003-duplicate.md"), ADR3);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "dup");
    const remote = remoteOf(root);
    const headBefore = remote.refs.get("heads/main");
    const r = await postMerge({ root, branch: "main", before, after: git(root, "rev-parse", "HEAD"), client: remote.client() });
    assert.equal(r.outcome, "invalid");
    assert.ok(r.findings.some((f) => f.rule === "id.duplicate"));
    assert.equal(remote.refs.get("heads/main"), headBefore);
    void head;
  });

  test("without a previous head every document is checked; dry run writes nothing remote", async () => {
    const { root, after: head } = checkout();
    const remote = remoteOf(root);
    const headBefore = remote.refs.get("heads/main");
    const r = await postMerge({ root, branch: "main", before: "0".repeat(40), after: head, client: remote.client(), dryRun: true });
    assert.equal(r.changed, "all");
    assert.equal(r.outcome, "dry-run");
    assert.ok(r.edits.some((e) => e.key === "ADR-0002"));
    assert.equal(remote.refs.get("heads/main"), headBefore);
  });
});
