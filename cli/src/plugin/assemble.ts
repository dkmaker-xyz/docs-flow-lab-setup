import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { MARKETPLACE, PLUGIN } from "../hook/settings.js";
import { tokenSteps } from "../setup/token.js";

/**
 * Builds the marketplace tree that the plugin workflow commits to the
 * `meta/plugin` branch of the documentation repository (phase 10):
 *
 * ```
 * .claude-plugin/marketplace.json   marketplace "idc365-decisions", plugin source "./plugin"
 * .gitattributes                    LF for scripts, CRLF for the .cmd wrapper
 * plugin/.claude-plugin/plugin.json name, version
 * plugin/hooks/hooks.json           SessionStart: node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/index.js hook session-start
 * plugin/skills/idc365-decisions/   the skill, with the token steps for this repository
 * plugin/bin/idc365-decisions       Bash (Linux, macOS, Git Bash on Windows)
 * plugin/bin/idc365-decisions.cmd   PowerShell and CMD on Windows
 * plugin/scripts/                   the CLI as `npm pack` lays it out (package.json, dist/, schemas/)
 * plugin/package.json + package-lock.json  runtime dependencies; Claude Code installs them when it caches the plugin
 * ```
 *
 * Everything comes from the reviewed `main`: the templates in `plugin/` and
 * the CLI built from `cli/`. Paths in manifests use forward slashes.
 */

export interface AssembleInput {
  /** Repository root with `cli/` (built: `cli/dist`) and `plugin/` templates. */
  root: string;
  /** Output folder (emptied first). */
  out: string;
  /** Documentation repository org/repo (the marketplace's own repository). */
  repository: string;
  /** Plugin and CLI version. */
  version: string;
  /** Source commit, recorded in the README. */
  sourceSha?: string;
}

export const HOOK_ENTRY = "scripts/dist/index.js";

/** The plugin's SessionStart hook: exec form, `node` from PATH, the script path as one argument (no shell, so no quoting on Windows). */
export function hooksJson(): object {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "node", args: [`\${CLAUDE_PLUGIN_ROOT}/${HOOK_ENTRY}`, "hook", "session-start"], timeout: 15 }] }],
    },
  };
}

/** Bash wrapper: resolves the plugin folder from its own path. LF line endings. */
export const POSIX_WRAPPER = '#!/bin/sh\nexec node "$(dirname "$0")/../scripts/dist/index.js" "$@"\n';
/** PowerShell/CMD wrapper (`%~dp0` is the folder of the .cmd file, with a trailing backslash). CRLF line endings. */
export const CMD_WRAPPER = '@echo off\r\nnode "%~dp0..\\scripts\\dist\\index.js" %*\r\n';

/** The wrapper a shell finds for the bare name `idc365-decisions`: Bash takes the extensionless file, PowerShell and CMD the `.cmd` (PATHEXT). */
export function wrapperFor(shell: "bash" | "powershell" | "cmd"): string {
  return shell === "bash" ? "bin/idc365-decisions" : "bin/idc365-decisions.cmd";
}

/** A lockfile with only the runtime dependencies, from the CLI's own lockfile (same pins, no network). */
export function runtimeLock(cliLock: { lockfileVersion: number; packages: Record<string, Record<string, unknown>> }, pkg: { name: string; version: string; dependencies: Record<string, string> }): object {
  const packages: Record<string, unknown> = { "": { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies } };
  for (const [k, v] of Object.entries(cliLock.packages)) if (k !== "" && !v.dev) packages[k] = v;
  return { name: pkg.name, version: pkg.version, lockfileVersion: cliLock.lockfileVersion, requires: true, packages };
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).split("\\").join("/")];
  });
}

export function assemble(i: AssembleInput): string[] {
  const owner = i.repository.split("/")[0]!;
  const cli = join(i.root, "cli");
  const tpl = join(i.root, "plugin");
  if (!existsSync(join(cli, "dist", "index.js"))) throw new Error("cli/dist is missing: build the CLI first (npm run build)");
  rmSync(i.out, { recursive: true, force: true });
  const p = join(i.out, "plugin");
  const write = (rel: string, data: string) => {
    const f = join(i.out, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, data);
  };
  const json = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

  write(".claude-plugin/marketplace.json", json({
    name: MARKETPLACE,
    owner: { name: owner },
    description: `The idc365-decisions plugin for ${i.repository}: CLI, SessionStart priming and agent instructions.`,
    plugins: [{ name: PLUGIN, source: "./plugin", description: "Decisions, procedures, tech stack and releases from the documentation repository: CLI, session priming and the setup skill." }],
  }));
  write(".gitattributes", "* text=auto eol=lf\n*.cmd text eol=crlf\n");
  write("README.md", fill(readFileSync(join(tpl, "README.md"), "utf8"), { REPOSITORY: i.repository, VERSION: i.version, SOURCE_SHA: i.sourceSha ?? "unknown" }));
  write("plugin/.claude-plugin/plugin.json", json({ name: PLUGIN, displayName: "IDC365 decisions", version: i.version, description: "CLI, session priming and instructions for the idc365-decisions documentation system.", author: { name: owner } }));
  write("plugin/hooks/hooks.json", json(hooksJson()));
  write("plugin/skills/idc365-decisions/SKILL.md", fill(readFileSync(join(tpl, "skills", "idc365-decisions", "SKILL.md"), "utf8"), { REPOSITORY: i.repository, TOKEN_STEPS: tokenSteps(i.repository).join("\n") }));
  write("plugin/bin/idc365-decisions", POSIX_WRAPPER);
  write("plugin/bin/idc365-decisions.cmd", CMD_WRAPPER);
  try {
    chmodSync(join(p, "bin", "idc365-decisions"), 0o755);
  } catch {
    // Windows: no mode bits; the workflow runs on Linux and git records 100755 there.
  }

  // The CLI, laid out like its npm package.
  const cliPkg = JSON.parse(readFileSync(join(cli, "package.json"), "utf8")) as { name: string; dependencies: Record<string, string>; [k: string]: unknown };
  const { scripts: _s, devDependencies: _d, publishConfig: _p, ...shipped } = cliPkg;
  write("plugin/scripts/package.json", json({ ...shipped, version: i.version }));
  cpSync(join(cli, "dist"), join(p, "scripts", "dist"), { recursive: true });
  cpSync(join(cli, "schemas"), join(p, "scripts", "schemas"), { recursive: true });

  // Runtime dependencies at the plugin root, where Claude Code looks for package.json + lockfile.
  const rootPkg = { name: `${PLUGIN}-plugin`, version: i.version, private: true, dependencies: cliPkg.dependencies };
  write("plugin/package.json", json(rootPkg));
  write("plugin/package-lock.json", json(runtimeLock(JSON.parse(readFileSync(join(cli, "package-lock.json"), "utf8")), rootPkg)));
  return listFiles(i.out).sort();
}

// `node cli/dist/plugin/assemble.js <repoRoot> <out> <org/repo> <version> [sha]` (the workflow).
if (process.argv[1] && /assemble\.js$/.test(process.argv[1]) && process.argv.length >= 6) {
  const [root, out, repository, version, sourceSha] = process.argv.slice(2) as [string, string, string, string, string | undefined];
  const files = assemble({ root, out, repository, version, sourceSha });
  process.stdout.write(`${files.length} files in ${out}\n`);
}
