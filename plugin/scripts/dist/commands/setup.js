import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { findGitRoot } from "../docs/gitrepo.js";
import { GitHubClient, GitHubError } from "../github/index.js";
import { MARKETPLACE, mergeProjectSettings, PLUGIN_ID } from "../hook/settings.js";
import { LINK_FILE, loadSetup, TOKEN_ENV } from "../setup/setup.js";
import { tokenSteps } from "../setup/token.js";
const CLI = "idc365-decisions";
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** Whether the token can read and write the documentation repository. */
export async function checkAccess(repository, token, fetchImpl) {
    const client = new GitHubClient({ repository, token, fetch: fetchImpl });
    try {
        const repo = await client.request("GET", client.repoPath(""));
        if (repo.data.permissions && repo.data.permissions.push === false) {
            return { ok: false, message: `Your GitHub account can read \`${repository}\` but has no write access to it.`, nextAction: "Ask an owner of the documentation repository for write access." };
        }
        return { ok: true };
    }
    catch (err) {
        if (!(err instanceof GitHubError))
            throw err;
        if (err.status === 401)
            return { ok: false, message: `The token in \`${TOKEN_ENV}\` was rejected (401): it is wrong, expired or revoked.`, nextAction: "Create a new token with the steps below." };
        if (err.status === 404)
            return { ok: false, message: `The token cannot see \`${repository}\` (404): it was not created for this repository, or the organisation has not approved it yet.`, nextAction: "Create the token with the steps below (resource owner and repository selection), or wait for the approval." };
        return { ok: false, message: `Cannot access \`${repository}\`: ${err.message}.`, nextAction: err.nextAction };
    }
}
function md(title, lines, next) {
    return [`# ${title}`, "", ...lines, ...(lines.length ? [""] : []), "## Next action", "", next, ""].join("\n");
}
async function ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        return (await rl.question(question)).trim();
    }
    finally {
        rl.close();
    }
}
function readJsonObject(file) {
    if (!existsSync(file))
        return { data: {} };
    try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        if (typeof data !== "object" || data === null || Array.isArray(data))
            return { error: "it is not a JSON object" };
        return { data: data };
    }
    catch (err) {
        return { error: `it is not valid JSON (${err.message})` };
    }
}
/**
 * `idc365-decisions setup [--repository org/repo]`, the one setup path (phase 10):
 * 1. link file: kept when present; written from `--repository` (or the prompt in a terminal);
 * 2. project settings: the plugin's marketplace and `enabledPlugins` in `.claude/settings.json`
 *    (and the phase 9 project hook removed), so teammates are offered the plugin;
 * 3. the token and its access, with the token steps when something is wrong.
 * Exit code 0 when everything is ready, 1 when something is missing.
 */
export async function runSetup(cwd, o = {}) {
    const env = o.env ?? process.env;
    const json = !!o.json;
    const out = (data, markdown) => process.stdout.write(json ? JSON.stringify(data, null, 2) + "\n" : markdown);
    const checks = [];
    const written = [];
    const root = findGitRoot(cwd);
    const nearest = loadSetup(cwd, env);
    let repository = nearest.ok ? nearest.setup.repository : undefined;
    const linkFile = nearest.ok ? nearest.setup.linkFile : nearest.linkFile;
    // 1. Link file.
    if (o.repository && !REPO_RE.test(o.repository)) {
        checks.push({ item: "Link file", ok: false, detail: `\`${o.repository}\` is not of the form org/repo; nothing was written`, fix: `Run \`${CLI} setup --repository <org>/<documentation-repo>\`.` });
    }
    else if (linkFile && existsSync(linkFile)) {
        if (!repository) {
            const p = !nearest.ok ? nearest.problems.find((x) => x.kind === "link-invalid") : undefined;
            if (p)
                checks.push({ item: "Link file", ok: false, detail: p.message, fix: p.nextAction });
            else
                repository = readJsonObject(linkFile).data?.repository;
        }
        if (repository && o.repository && o.repository !== repository) {
            checks.push({ item: "Link file", ok: false, detail: `\`${LINK_FILE}\` names \`${repository}\`, not \`${o.repository}\`; it was left unchanged`, fix: `Ask the user which documentation repository applies and edit \`${LINK_FILE}\` by hand.` });
        }
        else if (repository)
            checks.push({ item: "Link file", ok: true, detail: `\`${LINK_FILE}\` names \`${repository}\`` });
    }
    else if (!root) {
        checks.push({ item: "Link file", ok: false, detail: `this folder is not inside a git repository, so there is no \`${LINK_FILE}\``, fix: `Run \`${CLI} setup\` in the root of the code repository.` });
    }
    else {
        let wanted = o.repository;
        if (!wanted && (o.interactive ?? process.stdin.isTTY))
            wanted = await (o.prompt ?? ask)("Documentation repository (org/repo): ");
        if (wanted && REPO_RE.test(wanted)) {
            writeFileSync(join(root, LINK_FILE), JSON.stringify({ repository: wanted }, null, 2) + "\n");
            written.push(LINK_FILE);
            repository = wanted;
            checks.push({ item: "Link file", ok: true, detail: `created \`${LINK_FILE}\` naming \`${wanted}\`` });
        }
        else {
            checks.push({ item: "Link file", ok: false, detail: wanted ? `\`${wanted}\` is not of the form org/repo` : `\`${LINK_FILE}\` is missing`, fix: `Ask the user for the documentation repository and run \`${CLI} setup --repository <org>/<documentation-repo>\`.` });
        }
    }
    // 2. Project settings (only in a code repository with a link).
    const settingsRoot = root ?? undefined;
    if (repository && settingsRoot) {
        const file = join(settingsRoot, ".claude", "settings.json");
        const read = readJsonObject(file);
        const merged = "error" in read ? read : mergeProjectSettings(read.data, repository);
        if ("error" in merged) {
            checks.push({ item: "Project settings", ok: false, detail: `\`.claude/settings.json\` was not changed: ${merged.error}`, fix: "Fix the file (or ask the user), then run the command again." });
        }
        else {
            if (merged.changed) {
                mkdirSync(join(settingsRoot, ".claude"), { recursive: true });
                writeFileSync(file, JSON.stringify(merged.settings, null, 2) + "\n");
                written.push(".claude/settings.json");
            }
            const off = merged.settings.enabledPlugins[PLUGIN_ID] === false;
            checks.push({
                item: "Project settings",
                ok: true,
                detail: `${merged.changed ? "updated" : "already set in"} \`.claude/settings.json\`: marketplace \`${MARKETPLACE}\` (\`${repository}\`, branch \`meta/plugin\`, auto-update) and plugin \`${PLUGIN_ID}\` ${off ? "(left disabled: the file sets it to false)" : "enabled"}${merged.removedOldHook ? "; removed the old `idc365-decisions hook session-start` project hook (the plugin runs it now)" : ""}`,
            });
        }
    }
    // 3. Token and access.
    const token = env[TOKEN_ENV]?.trim();
    let tokenOk = false;
    if (!token)
        checks.push({ item: "Token", ok: false, detail: `\`${TOKEN_ENV}\` is not set in this environment`, fix: "Create the token with the steps below." });
    else if (repository) {
        const access = await checkAccess(repository, token, o.fetch);
        tokenOk = access.ok;
        checks.push(access.ok ? { item: "Token", ok: true, detail: `\`${TOKEN_ENV}\` is set and can read and write \`${repository}\`` } : { item: "Token", ok: false, detail: access.message, fix: access.nextAction });
    }
    else
        checks.push({ item: "Token", ok: true, detail: `\`${TOKEN_ENV}\` is set (access not checked: no documentation repository yet)` });
    const missing = checks.filter((c) => !c.ok);
    const needToken = missing.some((c) => c.item === "Token");
    const lines = [
        ...checks.map((c) => `- ${c.ok ? "OK" : "Missing"}: ${c.item}: ${c.detail}${c.fix ? `\n  Fix: ${c.fix}` : ""}`),
        ...(needToken ? ["", `## Documentation token (the user does this; never ask for the token in the chat)`, "", ...tokenSteps(repository)] : []),
    ];
    const commit = written.length ? `Commit ${written.map((f) => `\`${f}\``).join(" and ")} so every teammate is offered the plugin. ` : "";
    const next = missing.length
        ? needToken && missing.length === 1
            ? `${commit}Give the user the token steps above, wait until they have restarted Claude Code, then run \`${CLI} setup\` again.`
            : `${commit}Fix each item marked Missing (${missing.map((m) => m.item).join(", ")}), then run \`${CLI} setup\` again.`
        : written.length ? `${commit}Then continue with your task.` : "None. Continue with your task.";
    out({ ok: missing.length === 0, repository, written, tokenOk, checks, ...(needToken ? { tokenSteps: tokenSteps(repository) } : {}) }, md(missing.length ? "Setup incomplete" : "Setup complete", lines, next));
    return missing.length ? 1 : 0;
}
/** Kept for callers of phase 2–9: `setup` without options. */
export function runSetupCheck(cwd, fetchImpl) {
    return runSetup(cwd, { fetch: fetchImpl });
}
