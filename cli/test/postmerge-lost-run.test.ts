import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { loadConfig } from "../src/engine/index.js";
import { packageRoot } from "../src/engine/package-root.js";
import { chooseBase, markerPath, readMarker, writeMarker } from "../src/postmerge/marker.js";
import { mergesIn, postMerge, readTree, releaseHooks } from "../src/postmerge/postmerge.js";
import { FakeRepo } from "./docs/fakerepo.js";

const VALID = join(packageRoot(), "test", "fixtures", "valid");
const temp = mkdtempSync(join(tmpdir(), "idc365-lostrun-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const git = (root: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" }).trim();
const REL = "docs/release/0001-v2-0-0.md";

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
---
## Context

Load grew.
`;

function filesOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      if (n === ".git") continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

/**
 * main: base (v2.0.0 released and tagged) → merge 1 (#11 records patch v2.0.1)
 * → merge 2 (#12 adds ADR-0003, which supersedes ADR-0002). The run for merge 1
 * was cancelled while pending; only the run for merge 2 happens.
 */
function twoMerges() {
  const root = join(temp, Math.random().toString(36).slice(2));
  cpSync(VALID, root, { recursive: true });
  const rel = readFileSync(join(root, REL), "utf8").replace("phase: development", 'phase: released\nreleased_date: "2026-11-01"');
  writeFileSync(join(root, REL), rel);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "tag", "v2.0.0");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, REL), rel.replace('released_date: "2026-11-01"', 'released_date: "2026-11-01"\npatches:\n  - v2.0.1'));
  git(root, "commit", "-qam", "Merge pull request #11 from acme/v2.0.1/release-v2-0-1");
  const merge1 = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "docs/adr/0003-separate-event-database.md"), ADR3);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "Merge pull request #12 from acme/v2.0.1/adr-0003");
  const merge2 = git(root, "rev-parse", "HEAD");
  const remote = new FakeRepo();
  remote.seed("main", filesOf(root));
  remote.tag("v2.0.0");
  remote.seed("meta/index", { "main.json": "{}" });
  return { root, base, merge1, merge2, remote };
}

describe("post-merge after a cancelled run (two merges, the first run lost)", () => {
  test("with only the push event's before, the first merge's tag is lost (the bug)", async () => {
    const { root, merge1, merge2 } = twoMerges();
    const r = await postMerge({ root, branch: "main", before: merge1, after: merge2, dryRun: true });
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.edits.map((e) => e.key), ["ADR-0002"]);
  });
  test("from the last handled commit, both effects land: the tag on the first merge, the inverse relation; then the marker moves", async () => {
    const { root, base, merge1, merge2, remote } = twoMerges();
    const client = remote.client();
    await writeMarker(client, root, "main", base);
    const { marker } = await readMarker(client, "main");
    const chosen = chooseBase(root, marker, merge1, merge2);
    assert.deepEqual(chosen, { before: base, from: "marker" });
    const r = await postMerge({ root, branch: "main", before: chosen.before, after: merge2, client });
    assert.equal(r.outcome, "committed");
    assert.deepEqual(r.actions.map((a) => `${a.kind} ${"tag" in a ? a.tag : a.branch} ${a.done ? "done" : a.skipped}`), ["create-tag v2.0.1 done"]);
    assert.equal(remote.refs.get("tags/v2.0.1"), merge1, "the tag is on the commit that recorded the patch");
    assert.deepEqual(r.edits.map((e) => `${e.key}: ${e.reasons.join(", ")}`), ["ADR-0002: superseded-by ADR-0003, state superseded (ADR-0003 supersedes it)"]);
    assert.equal(await writeMarker(client, root, "main", merge2), "written");
    assert.equal((await readMarker(client, "main")).marker?.sha, merge2);
    assert.ok(remote.files("meta/index").has(markerPath("main")));
  });
  test("idempotent: handling again changes nothing; the marker never moves backwards", async () => {
    const { root, base, merge2, remote } = twoMerges();
    const client = remote.client();
    await postMerge({ root, branch: "main", before: base, after: merge2, client });
    await writeMarker(client, root, "main", merge2);
    const { marker } = await readMarker(client, "main");
    const again = chooseBase(root, marker, merge2, merge2);
    const r = await postMerge({ root, branch: "main", before: again.before, after: merge2, client });
    assert.equal(r.outcome, "nothing");
    // A wide range is safe too: everything since base again.
    const wide = await postMerge({ root, branch: "main", before: base, after: merge2, client });
    assert.equal(wide.outcome, "nothing");
    assert.equal(await writeMarker(client, root, "main", base), "kept", "a re-run of an old run leaves a newer marker");
    assert.equal((await readMarker(client, "main")).marker?.sha, merge2);
  });
  test("the marker write retries when another commit to meta/index (an index build) wins the race", async () => {
    const { root, merge2, remote } = twoMerges();
    let conflicts = 2;
    remote.mock.on("PUT", /\/contents\/post-merge\/.+$/, () => (conflicts-- > 0 ? { status: 409, body: { message: "is at 1234 but expected 5678" } } : { status: 201, body: {} }));
    assert.equal(await writeMarker(remote.client(), root, "main", merge2), "written");
    assert.equal(conflicts, -1, "two conflicts, then the write");
  });
  test("without a marker (first run) the push event's before is used; a foreign marker falls back to it", () => {
    const { root, merge1, merge2 } = twoMerges();
    assert.deepEqual(chooseBase(root, undefined, merge1, merge2), { before: merge1, from: "event" });
    assert.deepEqual(chooseBase(root, { sha: "1".repeat(40), at: "x" }, merge1, merge2), { before: merge1, from: "event" });
    assert.deepEqual(chooseBase(root, undefined, undefined, merge2), { from: "none" });
  });
  test("a release-branch merge anywhere in the range deletes the branch", () => {
    const { root, merge2 } = twoMerges();
    git(root, "checkout", "-q", "-b", "release/v2.1.0");
    writeFileSync(join(root, "docs/adr/0001-store-data-in-postgresql.md"), readFileSync(join(root, "docs/adr/0001-store-data-in-postgresql.md"), "utf8") + "\nRelease note.\n");
    git(root, "commit", "-qam", "release work");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "release/v2.1.0", "-m", "Merge pull request #13 from acme/release/v2.1.0");
    const merge3 = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "README.md"), "later\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "Merge pull request #14 from acme/v2.1.0/readme");
    const head = git(root, "rev-parse", "HEAD");
    assert.ok(mergesIn(root, merge2, head).includes(merge3));
    const docs = readTree(root, loadConfig(root).config!);
    const hooks = releaseHooks(docs, new Set(), "main", root, head, merge2);
    assert.deepEqual(hooks.actions.map((a) => `${a.kind} ${"branch" in a ? a.branch : a.tag}`), ["delete-branch release/v2.1.0"]);
    assert.deepEqual(releaseHooks(docs, new Set(), "main", root, head, merge3).actions, [], "outside the range: nothing");
  });
});
