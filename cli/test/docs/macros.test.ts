import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { codeTarget, findGitRoot, originRepository, parseGitHubRemote } from "../../src/docs/gitrepo.js";
import { expandMacros, parseMacro, stripTargetDefinitions } from "../../src/docs/macros.js";
import { slugify } from "../../src/docs/slug.js";

const parse = (raw: string) => {
  const m = /^\{\{([A-Za-z]+):(.*)\}\}$/.exec(raw)!;
  return parseMacro(raw, m[1]!, m[2]!);
};
const ok = (raw: string) => {
  const r = parse(raw);
  assert.ok(!("message" in r), `expected ${raw} to parse, got ${"message" in r ? r.message : ""}`);
  return r;
};
const err = (raw: string, re: RegExp) => {
  const r = parse(raw);
  assert.ok("message" in r, `expected ${raw} to be refused`);
  assert.match(r.message, re);
  assert.ok(r.nextAction.length > 0);
};

describe("macro parsing", () => {
  test("target|why defaults to relates-to", () => assert.deepEqual(ok("{{ADR:42|context for the API}}"), { raw: "{{ADR:42|context for the API}}", key: "ADR-0042", type: "relates-to", why: "context for the API", folder: false }));
  test("target|type|why", () => assert.equal(ok("{{ADR:0042|supersedes|replaced by this}}").type, "supersedes"));
  test("why may contain |", () => assert.equal(ok("{{PROC:7|uses|a | b}}").why, "a | b"));
  test("CODE with path and trailing slash for a folder", () => {
    assert.equal(ok("{{CODE:acme/app/src/main.ts|entry point}}").key, "CODE:acme/app/src/main.ts");
    const f = ok("{{CODE:acme/app/src/|source folder}}");
    assert.equal(f.key, "CODE:acme/app/src");
    assert.equal(f.folder, true);
  });
  test("JIRA key", () => assert.equal(ok("{{JIRA:IDC-12|ticket}}").key, "JIRA:IDC-12"));
  test("refuses a macro without why", () => err("{{ADR:42}}", /no `why`/));
  test("refuses a type without why", () => err("{{ADR:42|supersedes}}", /type but no `why`/));
  test("refuses an empty why", () => err("{{ADR:42|supersedes|}}", /no `why`/));
  test("refuses inverse types", () => err("{{ADR:42|superseded-by|x}}", /inverse relation/));
  test("refuses an unknown type", () => err("{{ADR:42|replaces|x}}", /unknown relation type/));
  test("refuses an unknown prefix", () => err("{{ADRR:42|x}}", /unknown prefix/));
  test("refuses a non-numeric ID", () => err("{{ADR:abc|x}}", /must be a number/));
  test("refuses attachment for a non-ATT", () => err("{{ADR:1|attachment|x}}", /needs an ATT target/));
  test("refuses a malformed JIRA key", () => err("{{JIRA:idc12|x}}", /JIRA target/));
  test("refuses a CODE target without path", () => err("{{CODE:acme|x}}", /org\/repo\/path/));
});

describe("macro expansion", () => {
  test("replaces macros outside code only", () => {
    const body = "See {{ADR:1|why}} and `{{ADR:2|why}}`.\n```\n{{ADR:3|why}}\n```\n{{PROC:4|uses|w}}\n";
    const r = expandMacros(body);
    assert.equal(r.body, "See [ADR-0001][ADR-0001] and `{{ADR:2|why}}`.\n```\n{{ADR:3|why}}\n```\n[PROC-0004][PROC-0004]\n");
    assert.deepEqual(r.macros.map((m) => m.key), ["ADR-0001", "PROC-0004"]);
    assert.deepEqual(r.errors, []);
  });
  test("collects errors and leaves the macro in place", () => {
    const r = expandMacros("x {{ADR:1}} y");
    assert.equal(r.body, "x {{ADR:1}} y");
    assert.equal(r.errors.length, 1);
  });
  test("strips only target definitions", () => {
    assert.equal(stripTargetDefinitions("Text\n\n[ADR-0001]: ../adr/0001-a.md\n[JIRA:X-1]: https://j/X-1\n[docs]: https://example.com\n"), "Text\n\n[docs]: https://example.com\n");
  });
});

describe("slugs", () => {
  test("lowercase, hyphens, ASCII", () => {
    assert.equal(slugify("Store service data in PostgreSQL!"), "store-service-data-in-postgresql");
    assert.equal(slugify("Brug af Ærø-færgen i Århus"), "brug-af-aeroe-faergen-i-arhus");
    assert.equal(slugify("  --  "), "document");
  });
  test("cut at a hyphen within 60 characters", () => {
    const s = slugify("a very long title that goes on and on and on and on and on forever and ever");
    assert.ok(s.length <= 60 && !s.endsWith("-"));
  });
});

describe("code repository paths", () => {
  const temp = mkdtempSync(join(tmpdir(), "idc365-git-"));
  after(() => rmSync(temp, { recursive: true, force: true }));

  test("parses GitHub remotes", () => {
    assert.equal(parseGitHubRemote("https://github.com/acme/app.git"), "acme/app");
    assert.equal(parseGitHubRemote("git@github.com:acme/app.git"), "acme/app");
    assert.equal(parseGitHubRemote("ssh://git@github.com/acme/my.app"), "acme/my.app");
    assert.equal(parseGitHubRemote("https://gitlab.com/acme/app.git"), undefined);
  });
  test("reads origin from .git/config, also through a worktree .git file", () => {
    const main = join(temp, "main");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(main, ".git", "config"), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/x.git\n[remote "origin"]\n\turl = git@github.com:acme/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const wt = join(temp, "wt");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    assert.equal(originRepository(main), "acme/app");
    assert.equal(findGitRoot(join(wt, "src")), wt);
    assert.equal(originRepository(wt), "acme/app");
  });
  test("maps paths to shadow documents", () => {
    assert.deepEqual(codeTarget("acme/app", "src/main.ts"), { key: "CODE:acme/app/src/main.ts", file: "code/acme/app/src/main.ts.md", folder: false });
    assert.deepEqual(codeTarget("acme/app", "src/_"), { key: "CODE:acme/app/src", file: "code/acme/app/src/_.md", folder: true });
    assert.deepEqual(codeTarget("acme/app", "src/"), { key: "CODE:acme/app/src", file: "code/acme/app/src/_.md", folder: true });
    assert.deepEqual(codeTarget("acme/app", "_"), { key: "CODE:acme/app", file: "code/acme/app/_.md", folder: true });
    for (const bad of ["../x", "/etc/passwd", "a/./b", ""]) assert.ok("error" in codeTarget("acme/app", bad), bad);
  });
});
