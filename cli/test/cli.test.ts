import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { packageRoot } from "../src/engine/package-root.js";

// The compiled CLI next to this test (build-test/src/index.js).
const CLI = join(packageRoot(), "build-test", "src", "index.js");
const VALID = join(packageRoot(), "test", "fixtures", "valid");
const temp = mkdtempSync(join(tmpdir(), "idc365-cli-"));
after(() => rmSync(temp, { recursive: true, force: true }));

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function broken(): string {
  const root = join(temp, "broken");
  cpSync(VALID, root, { recursive: true });
  writeFileSync(join(root, "config", "priming.yaml"), "priming_budget: 100\n");
  return root;
}

test("bare run prints markdown with a next action", () => {
  const r = run();
  assert.equal(r.code, 0);
  assert.match(r.out, /^# idc365-decisions CLI v/);
  assert.match(r.out, /## Next action/);
  assert.match(r.out, /validate/);
});

test("validate: clean tree exits 0 with markdown", () => {
  const r = run("validate", VALID);
  assert.equal(r.code, 0);
  assert.match(r.out, /^# Validation passed/);
  assert.match(r.out, /## Next action\n\nNone\./);
});

test("validate: findings exit 1 with markdown per file", () => {
  const r = run("validate", broken());
  assert.equal(r.code, 1);
  assert.match(r.out, /^# Validation failed: 1 finding in 1 file/);
  assert.match(r.out, /## docs\/adr\/0001-store-data-in-postgresql\.md/);
  assert.match(r.out, /- `priming\.budget`: /);
  assert.match(r.out, /## Next action/);
});

test("validate --json: machine-readable findings", () => {
  const r = run("validate", broken(), "--json");
  assert.equal(r.code, 1);
  const data = JSON.parse(r.out) as { ok: boolean; documents: number; findings: { file: string; rule: string; message: string; nextAction: string }[] };
  assert.equal(data.ok, false);
  assert.equal(data.documents, 11);
  assert.equal(data.findings.length, 1);
  assert.deepEqual(Object.keys(data.findings[0]!).sort(), ["file", "message", "nextAction", "rule"]);
  assert.equal(data.findings[0]!.rule, "priming.budget");

  const ok = JSON.parse(run("validate", VALID, "--json").out) as { ok: boolean; findings: unknown[] };
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.findings, []);
});

test("validate defaults to the current directory", () => {
  const r = spawnSync(process.execPath, [CLI, "validate"], { cwd: VALID, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /in `\.`: no findings/);
});

test("validate: path that is not a directory exits 2", () => {
  const r = run("validate", join(temp, "nope"));
  assert.equal(r.code, 2);
  assert.match(r.out, /^# Error/);
  assert.match(r.out, /## Next action/);
});

test("unknown command is a markdown error with exit 1", () => {
  const r = run("frobnicate");
  assert.equal(r.code, 1);
  assert.match(r.err, /^# Error/);
});

test("setup without link file and token explains what to do and exits 1", () => {
  const r = spawnSync(process.execPath, [CLI, "setup"], { cwd: temp, encoding: "utf8", env: { ...process.env, IDC365_DECISIONS_TOKEN: "" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^# Setup incomplete/);
  assert.match(r.stdout, /\.idc365-decisions\.json/);
  assert.match(r.stdout, /IDC365_DECISIONS_TOKEN/);
  assert.match(r.stdout, /## Next action/);
});

test("noun help works without setup and lists verbs, macros and the writing instruction", () => {
  const r = spawnSync(process.execPath, [CLI, "adr"], { cwd: temp, encoding: "utf8", env: { ...process.env, IDC365_DECISIONS_TOKEN: "" } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^# Architecture decision record \(ADR\)/);
  assert.match(r.stdout, /`## Context`, `## Decision`, `## Consequences`/);
  assert.match(r.stdout, /Categories need the setup/);
  assert.match(r.stdout, /\{\{ADR:0042\|<why>\}\}/);
  assert.match(r.stdout, /idc365-decisions adr create --version/);
  assert.match(r.stdout, /## Next action/);
  for (const noun of ["proc", "tech", "code"]) {
    const j = spawnSync(process.execPath, [CLI, noun, "--json"], { cwd: temp, encoding: "utf8", env: { ...process.env, IDC365_DECISIONS_TOKEN: "" } });
    assert.equal(j.status, 0, noun);
    assert.equal((JSON.parse(j.stdout) as { noun: string }).noun, noun);
  }
});

test("create without setup explains the setup and exits 1 (options after the subcommand are its own)", () => {
  const body = join(temp, "body.md");
  writeFileSync(body, "x\n");
  const r = spawnSync(process.execPath, [CLI, "adr", "create", "--version", "v1.0.1", "--title", "T", "--body-file", body, "--json"], { cwd: temp, encoding: "utf8", env: { ...process.env, IDC365_DECISIONS_TOKEN: "" } });
  assert.equal(r.status, 1);
  assert.equal((JSON.parse(r.stdout) as { error: string }).error, "setup incomplete");
});

test("create without --body-file is refused", () => {
  const r = spawnSync(process.execPath, [CLI, "adr", "create", "--version", "v1.0.1"], { cwd: temp, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Refused: no --body-file given/);
});

test("code create outside a git repository is refused", () => {
  const r = spawnSync(process.execPath, [CLI, "code", "create", "src/x.ts", "--version", "v1.0.1"], { cwd: temp, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not inside a git repository/);
});

test("index build writes the index of a checkout; status and publish explain missing setup", () => {
  const root = join(temp, "idx-repo");
  cpSync(VALID, root, { recursive: true });
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init");
  const env = { ...process.env, IDC365_DECISIONS_TOKEN: "", GITHUB_REPOSITORY: "", GITHUB_REF_NAME: "" };
  const out = join(temp, "index.json");
  const r = spawnSync(process.execPath, [CLI, "index", "build", "--out", out], { cwd: root, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# Index built for main/);
  assert.match(r.stdout, /## Next action/);
  const idx = JSON.parse(readFileSync(out, "utf8")) as { branch: string; documents: unknown[] };
  assert.equal(idx.branch, "main");
  assert.equal(idx.documents.length, 11);
  const pub = spawnSync(process.execPath, [CLI, "index", "publish", out, "--repository", "acme/docs"], { cwd: root, encoding: "utf8", env });
  assert.equal(pub.status, 1);
  assert.match(pub.stdout, /IDC365_DECISIONS_TOKEN is not set/);
  const status = spawnSync(process.execPath, [CLI, "index", "status"], { cwd: temp, encoding: "utf8", env });
  assert.equal(status.status, 1);
  assert.match(status.stdout, /^# Setup incomplete/);
});
