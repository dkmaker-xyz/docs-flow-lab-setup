import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { packageRoot } from "../src/engine/package-root.js";
import { assemble, CMD_WRAPPER, hooksJson, POSIX_WRAPPER, runtimeLock, wrapperFor } from "../src/plugin/assemble.js";

const temp = mkdtempSync(join(tmpdir(), "idc365-plugin-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const CLI = packageRoot();

/** A repository root like main: cli/ (built) and the plugin/ templates. */
function repoRoot(): string {
  const root = join(temp, `root-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, "cli"), { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) cpSync(join(CLI, f), join(root, "cli", f));
  cpSync(join(CLI, "schemas"), join(root, "cli", "schemas"), { recursive: true });
  cpSync(join(CLI, "build-test", "src"), join(root, "cli", "dist"), { recursive: true });
  cpSync(join(CLI, "..", "plugin"), join(root, "plugin"), { recursive: true });
  return root;
}

describe("plugin assembly", () => {
  const root = repoRoot();
  const out = join(temp, "out");
  const files = assemble({ root, out, repository: "acme/docs", version: "0.1.42", sourceSha: "abc123" });
  const read = (p: string) => readFileSync(join(out, p), "utf8");
  const json = (p: string) => JSON.parse(read(p));

  test("layout: marketplace at the root, plugin under ./plugin, no top-level files outside it besides README and .gitattributes", () => {
    for (const f of [".claude-plugin/marketplace.json", ".gitattributes", "README.md", "plugin/.claude-plugin/plugin.json", "plugin/hooks/hooks.json", "plugin/skills/idc365-decisions/SKILL.md", "plugin/bin/idc365-decisions", "plugin/bin/idc365-decisions.cmd", "plugin/scripts/package.json", "plugin/scripts/dist/index.js", "plugin/package.json", "plugin/package-lock.json"]) assert.ok(files.includes(f), f);
    assert.ok(files.every((f) => !f.includes("\\")), "forward slashes only");
    assert.ok(files.some((f) => f.startsWith("plugin/scripts/schemas/")));
    assert.deepEqual(json(".claude-plugin/marketplace.json").plugins, [{ name: "idc365-decisions", source: "./plugin", description: json(".claude-plugin/marketplace.json").plugins[0].description }]);
    assert.equal(json(".claude-plugin/marketplace.json").name, "idc365-decisions");
    assert.deepEqual([json("plugin/.claude-plugin/plugin.json").name, json("plugin/.claude-plugin/plugin.json").version, json("plugin/scripts/package.json").version], ["idc365-decisions", "0.1.42", "0.1.42"]);
    assert.equal(json("plugin/scripts/package.json").scripts, undefined);
    assert.equal(json("plugin/scripts/package.json").devDependencies, undefined);
    assert.match(read("README.md"), /acme\/docs#meta\/plugin/);
  });
  test("hook: exec form, node from PATH, the script under ${CLAUDE_PLUGIN_ROOT} with forward slashes, no matcher", () => {
    assert.deepEqual(json("plugin/hooks/hooks.json"), hooksJson());
    assert.deepEqual(hooksJson(), { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/dist/index.js", "hook", "session-start"], timeout: 15 }] }] } });
  });
  test("wrappers: Bash takes the extensionless script (LF), PowerShell and CMD the .cmd (CRLF); both call node on the bundled CLI", () => {
    assert.equal(wrapperFor("bash"), "bin/idc365-decisions");
    assert.equal(wrapperFor("powershell"), "bin/idc365-decisions.cmd");
    assert.equal(wrapperFor("cmd"), "bin/idc365-decisions.cmd");
    assert.equal(read("plugin/bin/idc365-decisions"), POSIX_WRAPPER);
    assert.ok(!POSIX_WRAPPER.includes("\r"));
    assert.equal(read("plugin/bin/idc365-decisions.cmd"), CMD_WRAPPER);
    assert.ok(CMD_WRAPPER.split("\n").slice(0, -1).every((l) => l.endsWith("\r")), "CRLF");
    assert.match(CMD_WRAPPER, /node "%~dp0\.\.\\scripts\\dist\\index\.js" %\*/);
    assert.match(read(".gitattributes"), /\*\.cmd text eol=crlf/);
    if (process.platform !== "win32") assert.ok(statSync(join(out, "plugin/bin/idc365-decisions")).mode & 0o100, "executable on Linux");
  });
  test("runtime lockfile: only the CLI's runtime packages, same pins, matching package.json (Claude Code's frozen install)", () => {
    const lock = json("plugin/package-lock.json");
    const pkg = json("plugin/package.json");
    const cliPkg = JSON.parse(readFileSync(join(CLI, "package.json"), "utf8"));
    assert.deepEqual(pkg.dependencies, cliPkg.dependencies);
    assert.deepEqual(lock.packages[""].dependencies, cliPkg.dependencies);
    assert.equal(lock.lockfileVersion, 3);
    const names = Object.keys(lock.packages).filter((k) => k).sort();
    assert.ok(names.includes("node_modules/ajv") && names.includes("node_modules/commander") && names.includes("node_modules/yaml"));
    assert.ok(!names.some((n) => /typescript|@types/.test(n)), names.join());
    for (const n of names) assert.match(lock.packages[n].resolved, /^https:\/\//);
    assert.deepEqual(runtimeLock({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: "1.0.0" }, "node_modules/b": { version: "1.0.0", dev: true } } }, { name: "p", version: "1", dependencies: { a: "1.0.0" } }), { name: "p", version: "1", lockfileVersion: 3, requires: true, packages: { "": { name: "p", version: "1", dependencies: { a: "1.0.0" } }, "node_modules/a": { version: "1.0.0" } } });
  });
  test("skill: filled for the repository, token steps for Windows and Linux, no placeholders left", () => {
    const skill = read("plugin/skills/idc365-decisions/SKILL.md");
    assert.match(skill, /^---\ndescription: /);
    assert.doesNotMatch(skill, /\{\{[A-Z_]+\}\}/);
    assert.match(skill, /setup --repository acme\/docs/);
    assert.match(skill, /target_name=acme&expires_in=90&contents=write&pull_requests=write/);
    assert.match(skill, /SetEnvironmentVariable\("IDC365_DECISIONS_TOKEN", "<token>", "User"\)/);
    assert.match(skill, /~\/\.bashrc/);
    assert.match(skill, /never paste it into the chat/);
  });
  test("the Bash wrapper runs the bundled CLI (Linux)", { skip: process.platform === "win32" }, () => {
    symlinkSync(join(CLI, "node_modules"), join(out, "plugin", "node_modules"), "dir");
    const v = execFileSync(join(out, "plugin", "bin", "idc365-decisions"), ["--version"], { encoding: "utf8" });
    assert.equal(v.trim(), "0.1.42");
  });
  test("refuses an unbuilt CLI", () => {
    const bare = repoRoot();
    rmSync(join(bare, "cli", "dist"), { recursive: true });
    assert.throws(() => assemble({ root: bare, out: join(temp, "o2"), repository: "acme/docs", version: "1.0.0" }), /build the CLI first/);
  });
});
