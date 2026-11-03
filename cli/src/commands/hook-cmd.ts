import { existsSync } from "node:fs";
import type { Command } from "commander";
import { hookOutput, prime } from "../hook/prime.js";
import { cacheDir } from "../index/read.js";

const CLI = "idc365-decisions";

function md(title: string, lines: string[], next: string): string {
  return [`# ${title}`, "", ...lines, ...(lines.length ? [""] : []), "## Next action", "", next, ""].join("\n");
}

const HELP = [
  "Claude Code integration (spec 9, phase 10). The idc365-decisions plugin runs the",
  "SessionStart hook: every session (startup, resume, clear, compact) is primed with",
  "the system, the release and documentation branch of the current code branch, the",
  "most important commands and the featured documents.",
  "",
  `- \`${CLI} setup [--repository <org>/<repo>]\`: in a code repository: link file, the plugin in \`.claude/settings.json\`, token check.`,
  `- \`${CLI} instructions\`: print the same instructions (from \`config/instructions.md\`) for the current code branch.`,
  `- \`${CLI} hook session-start\`: the hook itself (reads the SessionStart JSON on stdin, prints the priming JSON). Run it by hand to see the priming.`,
];

let version = "0.0.0";

async function readStdin(ms: number): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      clearTimeout(t);
      process.stdin.pause();
      resolve(data);
    };
    const t = setTimeout(done, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

/** `hook session-start`: always prints valid hook JSON and exits 0, so a session never breaks. */
export async function runSessionStart(): Promise<void> {
  let cwd = process.cwd();
  try {
    const event = JSON.parse((await readStdin(1000)) || "{}") as { cwd?: unknown };
    if (typeof event.cwd === "string" && existsSync(event.cwd)) cwd = event.cwd;
  } catch {
    // No or invalid event: prime for the current folder.
  }
  let context: string;
  try {
    context = (await prime({ cwd, cacheDir: cacheDir(), version, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || undefined })).context;
  } catch (err) {
    context = `# IDC365 decision system\n\nThe idc365-decisions priming failed: ${(err as Error).message}. Tell the user; run \`${CLI} hook session-start\` in a terminal to see the problem.\n`;
  }
  process.stdout.write(hookOutput(context));
  process.exitCode = 0;
}

export function registerHookCommands(program: Command, pkgVersion: string): void {
  version = pkgVersion;
  const hook = program.command("hook").action(() => {
    process.stdout.write(md("Claude Code hook", HELP, `In a code repository, run \`${CLI} setup\`.`));
  });
  hook.helpInformation = () => md("Claude Code hook", HELP, `In a code repository, run \`${CLI} setup\`.`);
  hook.command("session-start").action(runSessionStart);

  // The same instructions the hook gives a session, for the skill and for people (one source: config/instructions.md).
  program
    .command("instructions")
    .description("print the session instructions for this code branch")
    .action(async () => {
      const p = await prime({ cwd: process.cwd(), cacheDir: cacheDir(), version, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || undefined });
      process.stdout.write(
        `${p.context.trimEnd()}\n\n## Next action\n\nFollow these instructions for the rest of the session. They come from \`config/instructions.md\` in the documentation repository${p.docsBranch ? ` (branch \`${p.docsBranch}\`)` : ""}; changes to them go through a pull request.\n`,
      );
    });
}
