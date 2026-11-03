import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
export const LINK_FILE = ".idc365-decisions.json";
export const TOKEN_ENV = "IDC365_DECISIONS_TOKEN";
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/**
 * Finds `.idc365-decisions.json` by walking up from `cwd` to the git root
 * (the first folder with `.git`), or to the filesystem root outside git.
 */
export function findLinkFile(cwd) {
    let dir = resolve(cwd);
    for (;;) {
        const candidate = join(dir, LINK_FILE);
        if (existsSync(candidate))
            return { linkFile: candidate, gitRoot: existsSync(join(dir, ".git")) ? dir : undefined };
        if (existsSync(join(dir, ".git")))
            return { gitRoot: dir };
        const parent = dirname(dir);
        if (parent === dir)
            return {};
        dir = parent;
    }
}
/** Reads the link file and the token. Never throws; returns every problem found. */
export function loadSetup(cwd, env = process.env) {
    const problems = [];
    const { linkFile, gitRoot } = findLinkFile(cwd);
    let repository;
    if (!linkFile) {
        problems.push({
            kind: "link-missing",
            message: `No \`${LINK_FILE}\` found between \`${resolve(cwd)}\` and ${gitRoot ? `the git root \`${gitRoot}\`` : "the filesystem root"}.`,
            nextAction: `Run \`idc365-decisions setup --repository <org>/<documentation-repo>\` in the code repository root (it writes \`${LINK_FILE}\` and the Claude Code project settings), then commit both.`,
        });
    }
    else {
        try {
            const data = JSON.parse(readFileSync(linkFile, "utf8"));
            if (typeof data.repository === "string" && REPO_RE.test(data.repository))
                repository = data.repository;
            else
                throw new Error("`repository` must be a string like org/repo");
        }
        catch (err) {
            problems.push({
                kind: "link-invalid",
                message: `\`${linkFile}\` is not valid: ${err.message}.`,
                nextAction: `Make the file contain exactly \`{"repository": "<org>/<documentation-repo>"}\`.`,
            });
        }
    }
    const token = env[TOKEN_ENV]?.trim();
    if (!token) {
        problems.push({
            kind: "token-missing",
            message: `The environment variable \`${TOKEN_ENV}\` is not set.`,
            nextAction: `Create a fine-grained personal access token for the documentation repository and store it as the user environment variable \`${TOKEN_ENV}\` (README, section "Documentation token"); \`idc365-decisions setup\` prints the steps with a pre-filled link. Then restart the terminal and Claude Code.`,
        });
    }
    if (problems.length || !repository || !token)
        return { ok: false, problems, linkFile };
    return { ok: true, setup: { repository, token, linkFile: linkFile } };
}
/** Markdown for missing setup, with the next action (spec 8.2: explain exactly what to do). */
export function renderSetupProblems(problems) {
    const lines = ["# Setup incomplete", ""];
    for (const p of problems)
        lines.push(`- ${p.message}`, `  Fix: ${p.nextAction}`);
    lines.push("", "## Next action", "", problems.length === 1 ? problems[0].nextAction : "Fix each item above, then run the command again.", "");
    return lines.join("\n");
}
