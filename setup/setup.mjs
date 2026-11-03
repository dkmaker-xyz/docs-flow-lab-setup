#!/usr/bin/env node
// Sets up a documentation repository for idc365-decisions (SETUP.md).
// One Node script for Windows, macOS and Linux; it calls the GitHub CLI
// (`gh`), which must be logged in as an owner of the organisation. Every step
// is idempotent: run it again at any time, it changes only what differs.
//
//   node setup/setup.mjs --repo <org>/<repo> --app-id <id> --client-id <id> [--private-key <file>] [--only <step,...>] [--check]
//
// Steps (in this order): settings, actions, environment, content, ids, rulesets.
// --check changes nothing and reports what is missing.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "..");
const STEPS = ["settings", "actions", "environment", "content", "ids", "rulesets"];
/** The system files the documentation repository needs on main (step "content"). */
export const CONTENT = ["cli", "plugin", "config", "setup", "SETUP.md", ".github/workflows/docs-validate.yml", ".github/workflows/docs-post-merge.yml", ".github/workflows/docs-index-trigger.yml", ".github/workflows/docs-index.yml", ".github/workflows/docs-index-remove.yml", ".github/workflows/docs-site.yml", ".github/workflows/plugin-build.yml"];

function args(argv) {
  const o = { only: STEPS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--repo") o.repo = v();
    else if (a === "--app-id") o.appId = v();
    else if (a === "--client-id") o.clientId = v();
    else if (a === "--private-key") o.privateKey = v();
    else if (a === "--only") o.only = v().split(",");
    else if (a === "--check") o.check = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
/** gh api with a JSON body on stdin; returns parsed JSON (or null), or { status } on an HTTP error when allowed. */
function api(method, path, body, allow = []) {
  try {
    const out = execFileSync("gh", ["api", "-X", method, path, ...(body !== undefined ? ["--input", "-"] : []), "-H", "Accept: application/vnd.github+json"], {
      encoding: "utf8",
      input: body !== undefined ? JSON.stringify(body) : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    const status = Number(/HTTP (\d{3})/.exec(text)?.[1] ?? /"status":\s*"?(\d{3})/.exec(text)?.[1] ?? 0);
    if (allow.includes(status)) return { __status: status };
    throw new Error(`${method} ${path} failed: ${text.trim().split("\n").slice(-2).join(" ")}`);
  }
}

const log = (ok, what) => console.log(`${ok === true ? "OK     " : ok === "changed" ? "CHANGED" : "MISSING"} ${what}`);
let missing = 0;

function settings(o) {
  const want = { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false, delete_branch_on_merge: true, allow_auto_merge: false, merge_commit_title: "MERGE_MESSAGE", merge_commit_message: "PR_TITLE" };
  const repo = api("GET", `repos/${o.repo}`);
  const diff = Object.keys(want).filter((k) => repo[k] !== want[k]);
  if (!diff.length) return log(true, "repository settings: merge commits only, head branches deleted after merge");
  if (o.check) return missing++, log(false, `repository settings differ: ${diff.join(", ")}`);
  api("PATCH", `repos/${o.repo}`, want);
  log("changed", `repository settings: ${diff.join(", ")}`);
}

function actions(o) {
  const items = [
    ["actions/permissions", { enabled: true, allowed_actions: "selected", sha_pinning_required: true }, "Actions on, selected actions only, SHA pinning required"],
    ["actions/permissions/selected-actions", { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [] }, "allowed actions: GitHub-owned only (checkout, setup-node, create-github-app-token)"],
    ["actions/permissions/workflow", { default_workflow_permissions: "read", can_approve_pull_request_reviews: false }, "GITHUB_TOKEN read-only by default, cannot approve pull requests"],
    ["actions/permissions/fork-pr-contributor-approval", { approval_policy: "all_external_contributors" }, "fork pull requests from outside contributors need approval before workflows run"],
  ];
  for (const [path, want, label] of items) {
    let cur = api("GET", `repos/${o.repo}/${path}`, undefined, [404, 409, 422]);
    if (cur?.__status === 409) cur = {}; // selected-actions while all actions are allowed
    if (cur?.__status) {
      log(true, `${label}: not available for this repository (HTTP ${cur.__status}), skipped`);
      continue;
    }
    const diff = Object.keys(want).filter((k) => JSON.stringify(cur?.[k]) !== JSON.stringify(want[k]));
    if (!diff.length) log(true, label);
    else if (o.check) (missing++, log(false, `${label} (differs: ${diff.join(", ")})`));
    else (api("PUT", `repos/${o.repo}/${path}`, want), log("changed", label));
  }
}

function environment(o) {
  const env = api("GET", `repos/${o.repo}/environments/bot`, undefined, [404]);
  const okPolicy = env && !env.__status && env.deployment_branch_policy?.custom_branch_policies === true;
  if (okPolicy) log(true, "environment bot with custom deployment branches");
  else if (o.check) (missing++, log(false, "environment bot"));
  else (api("PUT", `repos/${o.repo}/environments/bot`, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }), log("changed", "environment bot"));
  if (!o.check || okPolicy) {
    const have = new Set((api("GET", `repos/${o.repo}/environments/bot/deployment-branch-policies`)?.branch_policies ?? []).map((p) => `${p.type ?? "branch"}:${p.name}`));
    for (const name of ["main", "release/*"]) {
      if (have.has(`branch:${name}`)) log(true, `environment bot deploys from ${name}`);
      else if (o.check) (missing++, log(false, `environment bot deployment branch ${name}`));
      else (api("POST", `repos/${o.repo}/environments/bot/deployment-branch-policies`, { name, type: "branch" }), log("changed", `environment bot deploys from ${name}`));
    }
  }
  // Repository variable BOT_CLIENT_ID.
  const cur = api("GET", `repos/${o.repo}/actions/variables/BOT_CLIENT_ID`, undefined, [404]);
  if (!o.clientId) {
    if (cur && !cur.__status) log(true, `variable BOT_CLIENT_ID = ${cur.value}`);
    else (missing++, log(false, "variable BOT_CLIENT_ID (pass --client-id)"));
  } else if (cur && !cur.__status && cur.value === o.clientId) log(true, `variable BOT_CLIENT_ID = ${o.clientId}`);
  else if (o.check) (missing++, log(false, "variable BOT_CLIENT_ID"));
  else if (cur && !cur.__status) (api("PATCH", `repos/${o.repo}/actions/variables/BOT_CLIENT_ID`, { name: "BOT_CLIENT_ID", value: o.clientId }), log("changed", "variable BOT_CLIENT_ID"));
  else (api("POST", `repos/${o.repo}/actions/variables`, { name: "BOT_CLIENT_ID", value: o.clientId }), log("changed", "variable BOT_CLIENT_ID"));
  // The private key: only in the environment, never at repository level.
  const repoSecrets = (api("GET", `repos/${o.repo}/actions/secrets`)?.secrets ?? []).map((s) => s.name);
  if (repoSecrets.includes("BOT_PRIVATE_KEY")) (missing++, log(false, "BOT_PRIVATE_KEY is a repository secret: delete it there (gh secret delete BOT_PRIVATE_KEY -R " + o.repo + "); it belongs only in the environment"));
  const envSecrets = env && !env.__status ? (api("GET", `repos/${o.repo}/environments/bot/secrets`)?.secrets ?? []).map((s) => s.name) : [];
  if (o.privateKey && !o.check) {
    execFileSync("gh", ["secret", "set", "BOT_PRIVATE_KEY", "--env", "bot", "-R", o.repo], { input: readFileSync(o.privateKey), stdio: ["pipe", "ignore", "pipe"] });
    log("changed", "secret BOT_PRIVATE_KEY in environment bot (delete the .pem file now)");
  } else if (envSecrets.includes("BOT_PRIVATE_KEY")) log(true, "secret BOT_PRIVATE_KEY in environment bot");
  else (missing++, log(false, `secret BOT_PRIVATE_KEY in environment bot: gh secret set BOT_PRIVATE_KEY --env bot -R ${o.repo} < <app>.private-key.pem`));
}

function files(paths) {
  try {
    // A git checkout: exactly the tracked files.
    return execFileSync("git", ["ls-files", "--", ...paths], { cwd: SOURCE, encoding: "utf8" }).split("\n").filter(Boolean).sort();
  } catch {
    // Not a checkout (for example an unpacked archive): walk the folders.
  }
  const out = [];
  const walk = (p) => {
    const full = join(SOURCE, p);
    if (statSync(full).isDirectory()) {
      for (const n of readdirSync(full)) if (!["node_modules", "dist", "build-test"].includes(n)) walk(join(p, n));
    } else out.push(p.split("\\").join("/"));
  };
  for (const p of paths) walk(p);
  return out.sort();
}

function content(o) {
  const head = api("GET", `repos/${o.repo}/git/ref/heads/main`, undefined, [404, 409]);
  if (head && !head.__status) return log(true, "main exists (the system files are changed by pull request from now on)");
  if (o.check) return missing++, log(false, "main with the system files (cli/, plugin/, config/, setup/, SETUP.md, workflows)");
  // An empty repository has no git database yet; the Contents API creates the first commit.
  const list = files(CONTENT);
  const init = api("PUT", `repos/${o.repo}/contents/README.md`, { message: "Initialise", content: Buffer.from(`# ${o.repo.split("/")[1]}\n\nDocumentation repository for idc365-decisions. Set up with SETUP.md.\n`).toString("base64"), branch: "main" });
  const parent = init.commit.sha;
  const tree = list.map((p) => {
    const blob = api("POST", `repos/${o.repo}/git/blobs`, { content: readFileSync(join(SOURCE, p)).toString("base64"), encoding: "base64" });
    return { path: p, mode: p.startsWith("plugin/bin/") && !p.endsWith(".cmd") ? "100755" : "100644", type: "blob", sha: blob.sha };
  });
  const base = api("GET", `repos/${o.repo}/git/commits/${parent}`).tree.sha;
  const t = api("POST", `repos/${o.repo}/git/trees`, { base_tree: base, tree });
  const sourceSha = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: SOURCE, encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })();
  const c = api("POST", `repos/${o.repo}/git/commits`, { message: `idc365-decisions system files (from ${sourceSha})`, tree: t.sha, parents: [parent] });
  api("PATCH", `repos/${o.repo}/git/refs/heads/main`, { sha: c.sha });
  log("changed", `main: ${list.length} system files committed`);
}

function ids(o) {
  const head = api("GET", `repos/${o.repo}/git/ref/heads/meta/ids`, undefined, [404, 409]);
  if (head && !head.__status) return log(true, "meta/ids exists");
  if (o.check) return missing++, log(false, "meta/ids (the ID counters)");
  const counters = JSON.stringify({ ADR: 0, PROC: 0, TECH: 0, REL: 0, ATT: 0 }, null, 2) + "\n";
  const blob = api("POST", `repos/${o.repo}/git/blobs`, { content: Buffer.from(counters).toString("base64"), encoding: "base64" });
  const tree = api("POST", `repos/${o.repo}/git/trees`, { tree: [{ path: "counters.json", mode: "100644", type: "blob", sha: blob.sha }] });
  const commit = api("POST", `repos/${o.repo}/git/commits`, { message: "Create ID counters", tree: tree.sha, parents: [] });
  api("POST", `repos/${o.repo}/git/refs`, { ref: "refs/heads/meta/ids", sha: commit.sha });
  log("changed", "meta/ids created with all counters at 0");
}

function rulesets(o) {
  if (!o.appId) return missing++, log(false, "rulesets: pass --app-id (the bot's App ID, the bypass actor)");
  const existing = new Map((api("GET", `repos/${o.repo}/rulesets?includes_parents=false&per_page=100`) ?? []).map((r) => [r.name, r.id]));
  for (const file of readdirSync(join(HERE, "rulesets")).filter((f) => f.endsWith(".json")).sort()) {
    const { _comment, ...want } = JSON.parse(readFileSync(join(HERE, "rulesets", file), "utf8").replaceAll('"${BOT_APP_ID}"', String(Number(o.appId))));
    const id = existing.get(want.name);
    if (id) {
      const cur = api("GET", `repos/${o.repo}/rulesets/${id}`);
      const same =
        cur.enforcement === want.enforcement &&
        JSON.stringify(cur.conditions.ref_name.include) === JSON.stringify(want.conditions.ref_name.include) &&
        JSON.stringify(cur.rules.map((r) => r.type).sort()) === JSON.stringify(want.rules.map((r) => r.type).sort()) &&
        JSON.stringify((cur.bypass_actors ?? []).map((b) => `${b.actor_type}:${b.actor_id}:${b.bypass_mode}`)) === JSON.stringify(want.bypass_actors.map((b) => `${b.actor_type}:${b.actor_id}:${b.bypass_mode}`)) &&
        JSON.stringify(cur.rules.find((r) => r.type === "required_status_checks")?.parameters?.required_status_checks ?? null) === JSON.stringify(want.rules.find((r) => r.type === "required_status_checks")?.parameters?.required_status_checks ?? null);
      if (same) log(true, `ruleset ${want.name}`);
      else if (o.check) (missing++, log(false, `ruleset ${want.name} differs`));
      else (api("PUT", `repos/${o.repo}/rulesets/${id}`, want), log("changed", `ruleset ${want.name} updated`));
    } else if (o.check) (missing++, log(false, `ruleset ${want.name}`));
    else (api("POST", `repos/${o.repo}/rulesets`, want), log("changed", `ruleset ${want.name} created`));
  }
}

const RUN = { settings, actions, environment, content, ids, rulesets };

function main() {
  const o = args(process.argv.slice(2));
  if (o.help || !o.repo) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exitCode = o.help ? 0 : 1;
    return;
  }
  gh("--version");
  for (const step of STEPS) if (o.only.includes(step)) RUN[step](o);
  console.log(o.check ? (missing ? `\n${missing} item(s) missing.` : "\nEverything is set up.") : missing ? `\nDone; ${missing} item(s) still need you (see MISSING).` : "\nDone.");
  process.exitCode = missing ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR  ${err.message}`);
    process.exitCode = 2;
  }
}
