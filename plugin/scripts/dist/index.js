#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { registerAttCommands } from "./commands/att-cmd.js";
import { registerDocumentCommands } from "./commands/docs.js";
import { registerHookCommands } from "./commands/hook-cmd.js";
import { registerIndexCommands } from "./commands/index-cmd.js";
import { registerPostMergeCommand } from "./commands/postmerge-cmd.js";
import { registerReleaseCommands } from "./commands/release-cmd.js";
import { registerTechCheck } from "./commands/tech-check.js";
import { registerSiteCommands } from "./commands/site-cmd.js";
import { runSetup } from "./commands/setup.js";
import { VALIDATE_HELP, runValidate } from "./commands/validate.js";
import { packageRoot } from "./engine/package-root.js";
import { placeholderMarkdown } from "./placeholder.js";
const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
const program = new Command()
    .name("idc365-decisions")
    .version(pkg.version)
    .helpCommand(false)
    .enablePositionalOptions()
    .configureOutput({
    // Parse errors are reported as markdown too, with the next action.
    outputError: (message, write) => write([
        "# Error",
        "",
        message.replace(/^error: /, "").trim(),
        "",
        "## Next action",
        "",
        "Run `idc365-decisions` with no arguments to see what is available.",
        "",
    ].join("\n")),
})
    .action(() => {
    process.stdout.write(placeholderMarkdown(pkg.version));
});
// Agents get the same markdown guide for --help as for a bare run.
program.helpInformation = () => placeholderMarkdown(pkg.version);
const validate = program
    .command("validate")
    .argument("[path]", "documentation repository root")
    .option("--json", "machine-readable findings")
    .action((path, opts) => {
    process.exitCode = runValidate(path, opts);
});
validate.helpInformation = () => VALIDATE_HELP;
const setup = program
    .command("setup")
    .option("--repository <org/repo>", "documentation repository for the link file")
    .option("--json")
    .action(async (o) => {
    process.exitCode = await runSetup(process.cwd(), o);
});
setup.helpInformation = () => [
    "# idc365-decisions setup",
    "",
    "Run in the root of a code repository. One path for everything:",
    "",
    "- `.idc365-decisions.json`: kept when present, written from `--repository <org>/<repo>`",
    "  (or asked for in a terminal).",
    "- `.claude/settings.json`: the idc365-decisions plugin marketplace and the plugin,",
    "  enabled, so every teammate is offered it; anything else in the file is kept.",
    "- `IDC365_DECISIONS_TOKEN`: set and able to read and write the documentation",
    "  repository; otherwise the steps to create it (Windows and Linux/macOS).",
    "",
    "Exit code: 0 ready, 1 something is missing. `--json` for machine-readable output.",
    "",
    "## Next action",
    "",
    "Run `idc365-decisions setup` in the code repository.",
    "",
].join("\n");
registerDocumentCommands(program);
registerAttCommands(program);
registerIndexCommands(program);
registerPostMergeCommand(program);
registerReleaseCommands(program);
registerTechCheck(program);
registerSiteCommands(program);
registerHookCommands(program, pkg.version);
await program.parseAsync(process.argv);
