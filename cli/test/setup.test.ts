import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { findLinkFile, LINK_FILE, loadSetup, renderSetupProblems, TOKEN_ENV } from "../src/setup/setup.js";

const temp = mkdtempSync(join(tmpdir(), "idc365-setup-"));
after(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
function repo(link?: string, opts: { linkAboveGit?: boolean } = {}) {
  const top = join(temp, String(n++));
  const root = opts.linkAboveGit ? join(top, "inner") : top;
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "a", "b"), { recursive: true });
  if (link !== undefined) writeFileSync(join(opts.linkAboveGit ? top : root, LINK_FILE), link);
  return { root, deep: join(root, "a", "b") };
}
const env = { [TOKEN_ENV]: "tok" };

describe("setup", () => {
  test("finds the link file by walking up to the git root", () => {
    const { root, deep } = repo('{"repository": "acme/docs"}');
    assert.equal(findLinkFile(deep).linkFile, join(root, LINK_FILE));
    assert.deepEqual(loadSetup(deep, env), { ok: true, setup: { repository: "acme/docs", token: "tok", linkFile: join(root, LINK_FILE) } });
  });
  test("does not look above the git root", () => {
    const { root, deep } = repo('{"repository": "acme/docs"}', { linkAboveGit: true });
    assert.deepEqual(findLinkFile(deep), { gitRoot: root });
    const r = loadSetup(deep, env);
    assert.ok(!r.ok && r.problems[0]!.kind === "link-missing");
  });
  test("an invalid link file is reported", () => {
    for (const bad of ["{", '{"repository": "nope"}', '{"repo": "acme/docs"}']) {
      const r = loadSetup(repo(bad).deep, env);
      assert.ok(!r.ok && r.problems.map((p) => p.kind).join() === "link-invalid", bad);
    }
  });
  test("a missing or blank token is reported and points to the README", () => {
    for (const e of [{}, { [TOKEN_ENV]: "  " }]) {
      const r = loadSetup(repo('{"repository": "acme/docs"}').deep, e);
      assert.ok(!r.ok);
      assert.equal(r.problems[0]!.kind, "token-missing");
      assert.match(r.problems[0]!.nextAction, /README, section "Documentation token"/);
    }
  });
  test("both problems at once render as markdown with a next action", () => {
    const r = loadSetup(repo().deep, {});
    assert.ok(!r.ok);
    assert.deepEqual(r.problems.map((p) => p.kind), ["link-missing", "token-missing"]);
    const md = renderSetupProblems(r.problems);
    assert.match(md, /^# Setup incomplete/);
    assert.match(md, /## Next action\n\nFix each item above/);
  });
});
