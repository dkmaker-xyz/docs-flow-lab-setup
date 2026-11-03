import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { runSetup } from "../src/commands/setup.js";
import { charCount, composeInstructions, FALLBACK_INSTRUCTIONS, placeholderProblems, SAMPLE_VARS } from "../src/engine/index.js";
import { packageRoot } from "../src/engine/package-root.js";
import { composePriming, hookOutput, prime } from "../src/hook/prime.js";
import { isOurHandler, mergeProjectSettings, PLUGIN_ID, removeHook } from "../src/hook/settings.js";
import { checkForUpdate, installedPluginVersion, marketplaceViewer, updateNotice, type Viewer } from "../src/hook/update.js";
import { FakeRepo } from "./docs/fakerepo.js";
import { REPO } from "./github/mock.js";

const temp = mkdtempSync(join(tmpdir(), "idc365-hook-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const uniq = (p: string) => join(temp, `${p}-${Math.random().toString(36).slice(2)}`);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

function ok<T>(r: T | { error: string }): T {
  assert.ok(!(r && typeof r === "object" && "error" in r), JSON.stringify(r));
  return r as T;
}

const OLD = { type: "command", command: "idc365-decisions", args: ["hook", "session-start"], timeout: 15 };
const MARKET = { "idc365-decisions": { source: { source: "github", repo: "acme/docs", ref: "meta/plugin" }, autoUpdate: true } };

describe("project settings for the plugin", () => {
  test("adds the marketplace and enables the plugin in empty settings; idempotent", () => {
    const r = ok(mergeProjectSettings({}, "acme/docs"));
    assert.deepEqual(r, { settings: { extraKnownMarketplaces: MARKET, enabledPlugins: { [PLUGIN_ID]: true } }, changed: true, removedOldHook: false });
    assert.equal(PLUGIN_ID, "idc365-decisions@idc365-decisions");
    const again = ok(mergeProjectSettings(r.settings, "acme/docs"));
    assert.equal(again.changed, false);
    assert.deepEqual(again.settings, r.settings);
  });
  test("keeps every other setting, marketplace, plugin and hook; input not mutated", () => {
    const settings = {
      permissions: { allow: ["Bash(ls)"] },
      extraKnownMarketplaces: { other: { source: { source: "github", repo: "x/y" } } },
      enabledPlugins: { "fmt@other": true },
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }] },
    };
    const before = JSON.stringify(settings);
    const r = ok(mergeProjectSettings(settings, "acme/docs"));
    assert.equal(JSON.stringify(settings), before);
    assert.deepEqual(r.settings, { ...settings, extraKnownMarketplaces: { ...settings.extraKnownMarketplaces, ...MARKET }, enabledPlugins: { "fmt@other": true, [PLUGIN_ID]: true } });
  });
  test("corrects a stale source, keeps the user's autoUpdate choice and an explicit disable", () => {
    const r = ok(mergeProjectSettings({ extraKnownMarketplaces: { "idc365-decisions": { source: { source: "github", repo: "old/docs" }, autoUpdate: false } }, enabledPlugins: { [PLUGIN_ID]: false } }, "acme/docs"));
    assert.deepEqual(r.settings, { extraKnownMarketplaces: { "idc365-decisions": { source: { source: "github", repo: "acme/docs", ref: "meta/plugin" }, autoUpdate: false } }, enabledPlugins: { [PLUGIN_ID]: false } });
  });
  test("removes the phase 9 project hook (exec or shell form), which the plugin replaces, and nothing else", () => {
    const other = { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] };
    const r = ok(mergeProjectSettings({ hooks: { SessionStart: [other, { hooks: [OLD] }, { hooks: [{ type: "command", command: "idc365-decisions  hook session-start" }] }], Stop: [] } }, "acme/docs"));
    assert.equal(r.removedOldHook, true);
    assert.deepEqual(r.settings.hooks, { SessionStart: [other], Stop: [] });
    assert.deepEqual(ok(removeHook({ model: "x", hooks: { SessionStart: [{ hooks: [OLD] }] } })), { settings: { model: "x" }, changed: true });
    assert.deepEqual(ok(removeHook({ model: "x" })), { settings: { model: "x" }, changed: false });
    assert.equal(isOurHandler({ type: "command", command: "idc365-decisions", args: ["hook", "other"] }), false);
  });
  test("refuses sections of the wrong shape", () => {
    assert.deepEqual(mergeProjectSettings({ hooks: { SessionStart: {} } }, "acme/docs"), { error: "`hooks.SessionStart` is not an array" });
    assert.deepEqual(mergeProjectSettings({ extraKnownMarketplaces: [] }, "acme/docs"), { error: "`extraKnownMarketplaces` is not an object" });
    assert.deepEqual(mergeProjectSettings({ enabledPlugins: "x" }, "acme/docs"), { error: "`enabledPlugins` is not an object" });
  });
});

// A code repository with a mapped release branch, a feature branch from it and an unrelated branch.
function codeRepo(link = true): string {
  const root = uniq("code");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "https://github.com/acme/app.git");
  if (link) writeFileSync(join(root, ".idc365-decisions.json"), JSON.stringify({ repository: REPO }));
  writeFileSync(join(root, "a.txt"), "a");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "main");
  git(root, "checkout", "-q", "-b", "release/2.0");
  writeFileSync(join(root, "b.txt"), "b");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "release");
  git(root, "checkout", "-q", "-b", "feature/x");
  git(root, "checkout", "-q", "main");
  git(root, "checkout", "-q", "-b", "other/y");
  writeFileSync(join(root, "c.txt"), "c");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "other");
  git(root, "checkout", "-q", "release/2.0");
  return root;
}

const REL = "---\nid: REL-0001\ntitle: Release v2.0.0\ndescription: d\nintent: i\nwhen: w\nstate: accepted\nversion: v2.0.0\nphase: development\ndocs_branch: release/v2.0.0\ncode:\n  - repo: acme/app\n    branch: release/2.0\n---\n";
const doc = (id: string, body: string) => `---\nid: ${id}\ntitle: Overview ${id}\ndescription: d\nintent: i\nwhen: w\nstate: accepted\ncategory: architecture\nfeatured: true\n---\n${body}\n`;

const INSTR = readFileSync(join(packageRoot(), "test", "fixtures", "valid", "config", "instructions.md"), "utf8");

function docsRepo(featured: Record<string, string> = { "ADR-0001": "The repository has two apps: web and api." }, budget = 8000, instructions: string | null = INSTR) {
  const r = new FakeRepo();
  r.seed("main", { "README.md": "x", "docs/release/0001-release-v2-0-0.md": REL, "config/priming.yaml": "priming_budget: 8000\n", ...(instructions ? { "config/instructions.md": instructions } : {}) });
  const files: Record<string, string> = { "config/priming.yaml": `priming_budget: ${budget}\n` };
  for (const [id, body] of Object.entries(featured)) files[`docs/adr/${id.slice(4)}-overview.md`] = doc(id, body);
  const head = r.seed("release/v2.0.0", files, "main");
  const documents = Object.keys(featured).map((id) => ({ id, type: "ADR", path: `docs/adr/${id.slice(4)}-overview.md`, title: `Overview ${id}`, state: "accepted", featured: true, commit: { sha: head, date: "2026-11-01" } }));
  documents.push({ id: "ADR-0099", type: "ADR", path: "docs/adr/0099-x.md", title: "Not featured", state: "accepted", featured: false, commit: { sha: head, date: "2026-11-01" } });
  r.seed("meta/index", { "release__v2.0.0.json": JSON.stringify({ schema: 1, branch: "release/v2.0.0", sourceSha: head, generatedAt: "x", base: null, documents, skipped: [] }) });
  return r;
}

const noUpdate: Viewer = async () => ({ ok: true, version: "0.1.0" });
const offline = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;
const env = (token?: string) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...(token ? { IDC365_DECISIONS_TOKEN: token } : {}) });

describe("priming (hook session-start)", () => {
  test("online: release, documentation branch, commands and the featured body; cache written", async () => {
    const r = docsRepo();
    const cwd = codeRepo();
    const cache = uniq("cache");
    const p = await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    assert.equal(p.mode, "online");
    assert.equal(p.docsBranch, "release/v2.0.0");
    assert.match(p.context, /Documentation repository: `acme\/docs`/);
    assert.match(p.context, /Release: v2\.0\.0 \(REL-0001, phase development\), the branch is mapped/);
    assert.match(p.context, /Documentation branch: `release\/v2\.0\.0`: read with `--ref release\/v2\.0\.0`/);
    assert.match(p.context, /idc365-decisions tech check/);
    assert.match(p.context, /## Featured: ADR-0001 Overview ADR-0001\n\nThe repository has two apps: web and api\./);
    assert.doesNotMatch(p.context, /Not featured|Primed from the cache/);
    assert.ok(charCount(p.context) <= 8000);
    assert.ok(existsSync(join(cache, "priming", "acme", "docs", "release__v2.0.0.json")));
    const out = JSON.parse(hookOutput(p.context));
    assert.deepEqual(Object.keys(out.hookSpecificOutput), ["hookEventName", "additionalContext"]);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  });
  test("a feature branch inherits the release; an unrelated branch is orphaned with the map command", async () => {
    const r = docsRepo();
    const cwd = codeRepo();
    git(cwd, "checkout", "-q", "feature/x");
    const inherited = await prime({ cwd, env: env("t"), cacheDir: uniq("cache"), version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    assert.match(inherited.context, /inherited from the mapped branch `release\/2\.0` \(git merge-base\)/);
    git(cwd, "checkout", "-q", "other/y");
    const orphan = await prime({ cwd, env: env("t"), cacheDir: uniq("cache"), version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    assert.equal(orphan.docsBranch, "main");
    assert.match(orphan.context, /Release: none\. This branch is orphaned/);
    assert.match(orphan.context, /release map --repo acme\/app --branch other\/y <REL-ID>/);
  });
  test("a cached body is reused while the document is unchanged", async () => {
    const r = docsRepo();
    const cwd = codeRepo();
    const cache = uniq("cache");
    await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    const reads = () => r.mock.calls.filter((c) => c.path.endsWith("/contents/docs/adr/0001-overview.md")).length;
    const n = reads();
    await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    assert.equal(reads(), n);
  });
  test("featured documents over the budget are left out by name; the result stays within it", async () => {
    const r = docsRepo({ "ADR-0001": "a".repeat(500), "ADR-0002": "b".repeat(3000), "ADR-0003": "c".repeat(200) }, 5000);
    const p = await prime({ cwd: codeRepo(), env: env("t"), cacheDir: uniq("cache"), version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    assert.match(p.context, /## Featured: ADR-0001/);
    assert.match(p.context, /## Featured: ADR-0003/);
    assert.doesNotMatch(p.context, /## Featured: ADR-0002/);
    assert.match(p.context, /left out to stay within the budget of 5000 characters: ADR-0002/);
    assert.ok(charCount(p.context) <= 5000 + 200);
    assert.ok(charCount(composePriming(INSTR + "x".repeat(20000), "a/b", [], [], [], 20000)) <= 10000);
  });
  test("offline: primes from the cache with a stale warning and the reason", async () => {
    const r = docsRepo();
    const cwd = codeRepo();
    const cache = uniq("cache");
    await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: r.mock.fetch, view: noUpdate, now: new Date("2026-11-03T08:00:00Z") });
    const p = await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: offline, view: noUpdate });
    assert.equal(p.mode, "cache");
    assert.match(p.context, /Primed from the cache of 2026-11-03 08:00 UTC because the documentation repository could not be read: could not reach GitHub/);
    assert.match(p.context, /may be out of date/);
    assert.match(p.context, /Release: v2\.0\.0/);
    assert.match(p.context, /The repository has two apps/);
  });
  test("missing token: the cache, and what is missing", async () => {
    const r = docsRepo();
    const cwd = codeRepo();
    const cache = uniq("cache");
    await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    const p = await prime({ cwd, env: env(), cacheDir: cache, version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    assert.equal(p.mode, "cache");
    assert.match(p.context, /`IDC365_DECISIONS_TOKEN` is not set\. Fix: Create a fine-grained personal access token/);
    assert.match(p.context, /The repository has two apps/);
  });
  test("a rejected token is named; no cache at all still primes and says so", async () => {
    const reject = (async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const p = await prime({ cwd: codeRepo(), env: env("bad"), cacheDir: uniq("cache"), version: "0.1.0", fetch: reject, view: noUpdate });
    assert.equal(p.mode, "none");
    assert.match(p.context, /No cached priming exists .* the token in `IDC365_DECISIONS_TOKEN` was rejected \(401\)/);
    assert.match(p.context, /## Most important commands/);
  });
  test("a slow documentation repository stops at the deadline and falls back", async () => {
    const slow = (async () => new Promise(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    const p = await prime({ cwd: codeRepo(), env: env("t"), cacheDir: uniq("cache"), version: "0.1.0", fetch: slow, view: noUpdate, deadlineMs: 300 });
    assert.ok(Date.now() - started < 2000);
    assert.match(p.context, /did not answer within 0\.3 s/);
  });
  test("a repository without the link file gets a short notice", async () => {
    const p = await prime({ cwd: codeRepo(false), env: env("t"), cacheDir: uniq("cache"), version: "0.1.0", view: noUpdate });
    assert.equal(p.mode, "none");
    assert.match(p.context, /not linked to a documentation repository/);
  });
  test("the sample the validator counts covers a realistic session", async () => {
    const r = docsRepo({});
    const p = await prime({ cwd: codeRepo(), env: env("t"), cacheDir: uniq("cache"), version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    const sample = charCount(composeInstructions(INSTR, SAMPLE_VARS, ""));
    assert.ok(charCount(p.context) <= sample, `${charCount(p.context)} > ${sample}`);
  });
  test("an update notice reaches the priming", async () => {
    const r = docsRepo();
    const pluginRoot = uniq("plugin");
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "idc365-decisions", version: "0.1.5" }));
    const newer = await prime({ cwd: codeRepo(), env: env("t"), cacheDir: uniq("cache"), version: "0.1.0", pluginRoot, fetch: r.mock.fetch, view: async () => ({ ok: true, version: "0.1.7" }) });
    assert.match(newer.context, /> A newer idc365-decisions plugin is available: 0\.1\.7 \(installed 0\.1\.5\)\. Ask the user for permission before updating; do not update on your own\. The user updates in Claude Code with `\/plugin marketplace update idc365-decisions`, then `\/reload-plugins` \(or in a terminal: `claude plugin update idc365-decisions@idc365-decisions`, then restart\)\./);
    let called = false;
    const outside = await prime({ cwd: codeRepo(), env: env("t"), cacheDir: uniq("cache"), version: "0.1.0", fetch: r.mock.fetch, view: async () => ((called = true), { ok: true, version: "9.9.9" }) });
    assert.doesNotMatch(outside.context, /newer/);
    assert.equal(called, false, "no check outside the plugin");
  });
});

describe("instructions from config/instructions.md", () => {
  test("placeholders: release, commands and featured filled in at their places; warnings first; text kept as written", () => {
    const t = "# Rules\n\nCost: $& $1 {{x}}\n\n{{release}}\nMiddle.\n{{commands}}\n{{featured}}\n";
    const out = composeInstructions(t, { docs: "acme/docs", release: ["- Release: v1"], warnings: ["Stale."] }, "## Featured: ADR-1 A\n\nBody\n");
    assert.match(out, /^> Stale\.\n\n# Rules\n\nCost: \$& \$1 \{\{x\}\}\n\n## This code branch\n\n- Documentation repository: `acme\/docs`\n- Release: v1\n\nMiddle\.\n## Most important commands\n\n- `idc365-decisions adr/);
    assert.match(out, /\n## Featured: ADR-1 A\n\nBody\n$/);
    assert.deepEqual(placeholderProblems(t), []);
    assert.deepEqual(placeholderProblems("{{release}}{{release}}{{featured}}"), ["{{release}} appears 2 times; it must appear exactly once", "{{commands}} appears nowhere; it must appear exactly once"]);
  });
  test("the hook primes with the file from the documentation branch, verbatim, and reads it again only when it changed (ETag)", async () => {
    const r = docsRepo();
    r.seed("release/v2.0.0", { "config/instructions.md": INSTR.replace("Use web search actively", "Use web search very actively") });
    const cwd = codeRepo();
    const cache = uniq("cache");
    const p = await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    assert.match(p.context, /(^|\n)# How you work in this project\n\nYou have the `idc365-decisions` CLI\./);
    assert.match(p.context, /Use web search very actively/, "the documentation branch's own copy");
    assert.match(p.context, /## This code branch\n\n- Documentation repository: `acme\/docs`\n- Code: `acme\/app` branch `release\/2\.0`/);
    assert.doesNotMatch(p.context, /\{\{(release|commands|featured)\}\}/);
    const before = r.rawReads.length;
    await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    assert.ok(r.rawReads.slice(before).includes(304), "a conditional read");
  });
  test("offline: the cached instructions; a missing or broken file keeps the cached copy; no cache at all: the built-in line", async () => {
    const r = docsRepo();
    const cwd = codeRepo();
    const cache = uniq("cache");
    await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    const off = await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: offline, view: noUpdate });
    assert.match(off.context, /# How you work in this project/);
    r.seed("release/v2.0.0", { "config/instructions.md": "No placeholders here.\n" });
    const broken = await prime({ cwd, env: env("t"), cacheDir: cache, version: "0.1.0", fetch: r.mock.fetch, view: noUpdate });
    assert.match(broken.context, /# How you work in this project/, "a text without placeholders is not used");
    const none = await prime({ cwd: codeRepo(), env: env("t"), cacheDir: uniq("cache"), version: "0.1.0", fetch: docsRepo(undefined, 8000, null).mock.fetch, view: noUpdate });
    assert.match(none.context, /^Run `idc365-decisions` for the guide .* could not be loaded: tell the user\./);
    assert.match(none.context, /## This code branch/);
    assert.ok(placeholderProblems(FALLBACK_INSTRUCTIONS).length === 0);
  });
});

describe("update notice (plugin version)", () => {
  test("newer version: notice with the update commands; checked at most once a day per repository", async () => {
    const dir = uniq("upd");
    let calls = 0;
    const view: Viewer = async () => (calls++, { ok: true, version: "0.1.10" });
    const s = await checkForUpdate("0.1.9", { dir, key: "acme/docs", now: new Date("2026-11-03T08:00:00Z"), view });
    assert.deepEqual([s.newer, s.latest, s.cached], [true, "0.1.10", false]);
    await checkForUpdate("0.1.9", { dir, key: "acme/docs", now: new Date("2026-11-03T20:00:00Z"), view });
    assert.equal(calls, 1);
    await checkForUpdate("0.1.9", { dir, key: "acme/docs", now: new Date("2026-11-04T09:00:00Z"), view });
    assert.equal(calls, 2);
    await checkForUpdate("0.1.9", { dir, key: "other/docs", now: new Date("2026-11-04T10:00:00Z"), view });
    assert.equal(calls, 3, "another repository is checked anew");
  });
  test("same or older version, or a failed check: no notice", async () => {
    assert.equal(updateNotice(await checkForUpdate("0.1.10", { dir: uniq("u"), key: "k", view: async () => ({ ok: true, version: "0.1.10" }) })), undefined);
    assert.equal(updateNotice(await checkForUpdate("0.2.0", { dir: uniq("u"), key: "k", view: async () => ({ ok: true, version: "0.1.10" }) })), undefined);
    const failed = await checkForUpdate("0.1.0", { dir: uniq("u"), key: "k", view: async () => { throw new Error("offline"); } });
    assert.deepEqual([failed.newer, failed.error], [false, "offline"]);
  });
  test("reads plugin.json on meta/plugin with the documentation token; the installed version from the plugin root", async () => {
    const r = new FakeRepo();
    r.seed("main", { "README.md": "x" });
    assert.deepEqual(await marketplaceViewer(r.client())(), { ok: false, error: "no plugin on `meta/plugin`" });
    r.seed("meta/plugin", { "plugin/.claude-plugin/plugin.json": JSON.stringify({ name: "idc365-decisions", version: "0.1.42" }) });
    assert.deepEqual(await marketplaceViewer(r.client())(), { ok: true, version: "0.1.42" });
    const root = uniq("pr");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.1.41" }));
    assert.equal(installedPluginVersion(root), "0.1.41");
    assert.equal(installedPluginVersion(undefined), undefined);
    assert.equal(installedPluginVersion(uniq("none")), undefined);
  });
});

function capture<T>(fn: () => Promise<T> | T): Promise<{ value: T; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ value, out }))
    .finally(() => {
      process.stdout.write = original;
    });
}

describe("setup (link file, project settings, token)", () => {
  const ghOk = (async () => new Response(JSON.stringify({ full_name: REPO, permissions: { push: true } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const gh401 = (async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const settingsOf = (root: string) => JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
  test("--repository: link file, marketplace + plugin in the project settings, token check; idempotent; never writes CLAUDE.md", async () => {
    const root = codeRepo(false);
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(.env)"] }, hooks: { SessionStart: [{ hooks: [OLD] }] } }));
    const run = () => capture(() => runSetup(join(root), { repository: REPO, env: env("t"), fetch: ghOk, interactive: false }));
    const first = await run();
    assert.equal(first.value, 0, first.out);
    assert.match(first.out, /^# Setup complete/);
    assert.match(first.out, /OK: Link file: created `\.idc365-decisions\.json` naming `acme\/docs`/);
    assert.match(first.out, /OK: Project settings: updated `\.claude\/settings\.json`: marketplace `idc365-decisions` .*plugin `idc365-decisions@idc365-decisions` enabled; removed the old `idc365-decisions hook session-start` project hook/);
    assert.match(first.out, /OK: Token: .* can read and write `acme\/docs`/);
    assert.match(first.out, /Commit `\.idc365-decisions\.json` and `\.claude\/settings\.json`/);
    assert.deepEqual(settingsOf(root), { permissions: { deny: ["Read(.env)"] }, extraKnownMarketplaces: MARKET, enabledPlugins: { [PLUGIN_ID]: true } });
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".idc365-decisions.json"), "utf8")), { repository: REPO });
    const second = await run();
    assert.match(second.out, /already set in `\.claude\/settings\.json`/);
    assert.match(second.out, /Next action\n\nNone\. Continue/);
    assert.equal(readdirSync(root).includes("CLAUDE.md"), false);
  });
  test("an existing link file is used without --repository; a different --repository is reported, not written", async () => {
    const root = codeRepo();
    const plain = await capture(() => runSetup(root, { env: env("t"), fetch: ghOk, interactive: false }));
    assert.equal(plain.value, 0, plain.out);
    assert.deepEqual(settingsOf(root).enabledPlugins, { [PLUGIN_ID]: true });
    const other = await capture(() => runSetup(root, { repository: "acme/other", env: env("t"), fetch: ghOk, interactive: false }));
    assert.equal(other.value, 1);
    assert.match(other.out, /names `acme\/docs`, not `acme\/other`; it was left unchanged/);
  });
  test("no token: the steps with the pre-filled link for the organisation, Windows and Linux; exit 1", async () => {
    const root = codeRepo();
    const { value, out } = await capture(() => runSetup(root, { env: env(), interactive: false }));
    assert.equal(value, 1);
    assert.match(out, /Missing: Token: `IDC365_DECISIONS_TOKEN` is not set/);
    assert.match(out, /## Documentation token \(the user does this; never ask for the token in the chat\)/);
    assert.match(out, /https:\/\/github\.com\/settings\/personal-access-tokens\/new\?name=idc365-decisions&description=[^ ]*&target_name=acme&expires_in=90&contents=write&pull_requests=write/);
    assert.match(out, /select `acme` again in the dropdown/);
    assert.match(out, /Only select repositories\* → `acme\/docs` only/);
    assert.match(out, /\[Environment\]::SetEnvironmentVariable\("IDC365_DECISIONS_TOKEN", "<token>", "User"\)/);
    assert.match(out, /export IDC365_DECISIONS_TOKEN=<token>` to `~\/\.bashrc`/);
    assert.match(out, /Give the user the token steps above, wait until they have restarted Claude Code/);
  });
  test("a rejected token is named, with the steps", async () => {
    const { value, out } = await capture(() => runSetup(codeRepo(), { env: env("bad"), fetch: gh401, interactive: false }));
    assert.equal(value, 1);
    assert.match(out, /Missing: Token: The token in `IDC365_DECISIONS_TOKEN` was rejected \(401\)/);
    assert.match(out, /personal-access-tokens\/new\?/);
  });
  test("no link file: asks in a terminal; otherwise says how to link", async () => {
    const asked = codeRepo(false);
    await capture(() => runSetup(asked, { env: env("t"), fetch: ghOk, interactive: true, prompt: async () => "acme/docs" }));
    assert.deepEqual(JSON.parse(readFileSync(join(asked, ".idc365-decisions.json"), "utf8")), { repository: REPO });
    const quiet = codeRepo(false);
    const { value, out } = await capture(() => runSetup(quiet, { env: env("t"), fetch: ghOk, interactive: false }));
    assert.equal(value, 1);
    assert.match(out, /Missing: Link file: `\.idc365-decisions\.json` is missing\n  Fix: Ask the user for the documentation repository and run `idc365-decisions setup --repository/);
    assert.equal(existsSync(join(quiet, ".claude", "settings.json")), false);
  });
  test("invalid settings JSON is not overwritten", async () => {
    const root = codeRepo();
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), "{ not json");
    const { value, out } = await capture(() => runSetup(root, { env: env("t"), fetch: ghOk, interactive: false }));
    assert.equal(value, 1);
    assert.match(out, /`\.claude\/settings\.json` was not changed: it is not valid JSON/);
    assert.equal(readFileSync(join(root, ".claude", "settings.json"), "utf8"), "{ not json");
  });
});

describe("hook session-start binary", () => {
  test("prints valid hook JSON and exits 0 even with no setup", () => {
    const root = codeRepo(false);
    const cache = uniq("c");
    mkdirSync(cache);
    const out = execFileSync(process.execPath, [join(packageRoot(), "build-test", "src", "index.js"), "hook", "session-start"], { cwd: root, input: JSON.stringify({ hook_event_name: "SessionStart", source: "clear", cwd: root }), env: { PATH: process.env.PATH, HOME: process.env.HOME, IDC365_DECISIONS_CACHE: cache }, encoding: "utf8" });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /not linked/);
  });
});
