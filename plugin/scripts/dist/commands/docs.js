import { readFileSync } from "node:fs";
import { codeTarget, findGitRoot, originRepository } from "../docs/gitrepo.js";
import { KINDS, MACRO_HELP } from "../docs/kinds.js";
import { DocRepo } from "../docs/docrepo.js";
import { listFromIndexOrDirect, showDocument, showShadow } from "../docs/read.js";
import { createDocument, updateDocument, writeShadow } from "../docs/write.js";
import { GitHubClient, GitHubError } from "../github/index.js";
import { loadSetup, renderSetupProblems } from "../setup/setup.js";
const CLI = "idc365-decisions";
function print(out, json, markdown) {
    process.stdout.write(out.json ? JSON.stringify(json, null, 2) + "\n" : markdown);
}
function md(title, lines, next) {
    return [`# ${title}`, "", ...lines, ...(lines.length ? [""] : []), "## Next action", "", next, ""].join("\n");
}
export function renderRefusal(r) {
    const lines = [];
    for (const p of r.problems ?? [])
        lines.push(`- ${p.message}`, `  Fix: ${p.nextAction}`);
    for (const f of r.findings ?? [])
        lines.push(`- \`${f.rule}\` in \`${f.file}\`: ${f.message}`, `  Fix: ${f.nextAction}`);
    return md(`Refused: ${r.message}`, lines, r.nextAction);
}
/** Runs a command body with setup, GitHub errors and exit codes handled. */
async function withClient(out, fn) {
    const setup = loadSetup(process.cwd());
    if (!setup.ok) {
        print(out, { ok: false, error: "setup incomplete", problems: setup.problems }, renderSetupProblems(setup.problems));
        process.exitCode = 1;
        return;
    }
    const client = new GitHubClient({ repository: setup.setup.repository, token: setup.setup.token });
    try {
        process.exitCode = await fn(client);
    }
    catch (err) {
        if (!(err instanceof GitHubError))
            throw err;
        print(out, { ok: false, error: err.message, status: err.status, details: err.details, nextAction: err.nextAction }, md("GitHub error", [`- ${err.message}`, ...err.details.map((d) => `  ${d}`)], err.nextAction));
        process.exitCode = 1;
    }
}
function readBody(path) {
    if (path === undefined)
        return undefined;
    return readFileSync(path === "-" ? 0 : path, "utf8");
}
function fieldsFrom(o) {
    const packages = o.package?.map((spec) => {
        const at = spec.lastIndexOf("@");
        return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec };
    });
    return {
        title: o.title,
        description: o.description,
        intent: o.intent,
        when: o.when,
        state: o.state,
        category: o.category,
        featured: o.featured,
        ecosystem: o.ecosystem,
        bomVersion: o.bomVersion,
        packages,
        rationale: o.rationale,
        docs: o.docs,
        license: o.license,
        lastReview: o.lastReview,
        reviewIntervalMonths: o.reviewIntervalMonths === undefined ? undefined : Number(o.reviewIntervalMonths),
        cooldownExemptions: o.cooldownExemption?.map((spec) => {
            const m = /^(.+)@([^@=]+)=(CVE-[0-9]{4}-[0-9]{4,}):([0-9]{4}-[0-9]{2}-[0-9]{2})$/.exec(spec);
            return m ? { package: m[1], version: m[2], cve: m[3], until: m[4] } : { package: spec, version: "", cve: "", until: "" };
        }),
    };
}
export function renderWrite(kind, r) {
    if (!r.ok)
        return renderRefusal(r);
    const lines = [
        `- File: \`${r.file}\``,
        `- Branch: \`${r.branch}\` (base \`${r.base}\`), commit ${r.commit.slice(0, 7)}`,
        `- Pull request: #${r.pr.number} ${r.pr.url} (${r.pr.opened ? "opened" : "updated"})`,
        ...(r.placeholders.length ? [`- Placeholder shadow documents: ${r.placeholders.map((p) => `\`${p}\``).join(", ")}`] : []),
    ];
    return md(`${r.action === "created" ? "Created" : "Updated"} ${r.key}`, lines, `Ask the user to review and merge the PR: ${r.pr.url}\nTo add more documents to the same PR, pass \`--branch ${r.branch}\` to \`${CLI} ${kind.noun} create\` or \`update\`.`);
}
function renderShown(r) {
    if (!r.ok)
        return renderRefusal(r);
    return [`# ${r.key} at \`${r.ref}\``, "", `File: \`${r.file}\``, "", "````markdown", r.text.replace(/\n$/, ""), "````", "", "## Next action", "", "Use the document for your task. To correct it, use `update`.", ""].join("\n");
}
async function nounHelp(kind, ref, out) {
    let categories;
    let note;
    if (kind.categories) {
        const setup = loadSetup(process.cwd());
        if (!setup.ok)
            note = "Categories need the setup: run `idc365-decisions setup`.";
        else {
            try {
                const { config } = await new DocRepo(new GitHubClient({ repository: setup.setup.repository, token: setup.setup.token })).config(ref);
                if (config)
                    categories = Object.entries(config.categories[kind.categories]).map(([name, c]) => ({ name, when: c.when }));
                else
                    note = `The configuration on \`${ref}\` is not valid.`;
            }
            catch (err) {
                note = `Categories could not be read: ${err.message}`;
            }
        }
    }
    const verbs = verbExamples(kind);
    const json = { noun: kind.noun, name: kind.name, purpose: kind.purpose, instruction: kind.instruction, categories, note, macros: MACRO_HELP, verbs };
    const lines = [
        kind.purpose,
        "",
        "## How to write it",
        "",
        ...kind.instruction.map((l) => `- ${l}`),
        ...(kind.categories ? ["", `## Categories (\`--category\`, from \`${ref}\`)`, "", ...(categories ? categories.map((c) => `- \`${c.name}\`: ${c.when}`) : [`- ${note}`])] : []),
        "",
        "## References (macros in the body)",
        "",
        ...MACRO_HELP.map((l) => `- ${l}`),
        "",
        "## Verbs",
        "",
        ...verbs.map((v) => `- \`${v.example}\``),
    ];
    print(out, json, md(kind.name, lines, `Pick the verb for your task. Every write opens or extends a PR for the user to review and merge.`));
}
function verbExamples(kind) {
    const n = `${CLI} ${kind.noun}`;
    const common = `--version v1.0.1 --title "…" --description "…" --intent "…" --when "…"`;
    if (kind.noun === "code") {
        return [
            { verb: "create", example: `${n} create src/main.ts ${common} --body-file body.md` },
            { verb: "update", example: `${n} update src/_ --version v1.0.1 --intent "…"` },
            { verb: "show", example: `${n} show src/main.ts [--ref main]` },
        ];
    }
    const extra = kind.noun === "tech" ? ` --category library --ecosystem npm --package react@19.* --rationale "…" --license MIT --review-interval-months 12` : ` --category ${kind.noun === "adr" ? "architecture" : "development"}`;
    return [
        { verb: "create", example: `${n} create ${common}${extra} --body-file body.md [--branch v1.0.1/<existing>]` },
        { verb: "update", example: `${n} update ${kind.prefix}-0042 --version v1.0.1 [--state deprecated] [--body-file body.md]` },
        { verb: "show", example: `${n} show ${kind.prefix}-0042 [--ref main]` },
        { verb: "list", example: `${n} list [--state accepted] [--category …] [--ref main]` },
        ...(kind.noun === "tech" ? [{ verb: "check", example: `${n} check [--json]` }] : []),
    ];
}
function sourceLine(s, ref) {
    if (s.kind === "index")
        return `Source: index of \`${ref}\` at ${s.sourceSha?.slice(0, 7)} (generated ${s.generatedAt}; ${s.status === 304 ? "cache current" : "downloaded"}).`;
    if (s.reason === "stale")
        return `Source: read directly, because the index (${s.sourceSha?.slice(0, 7)}) is behind the branch head (${s.head?.slice(0, 7)}) and is being rebuilt.`;
    return `Source: read directly, because \`${ref}\` has no index yet.`;
}
function collect(value, previous = []) {
    return [...previous, value];
}
function addFieldOptions(cmd, kind) {
    cmd
        .option("--version <vX.Y.Z>", "version the change belongs to")
        .option("--branch <branch>", "existing work branch to add to")
        .option("--title <text>")
        .option("--description <text>")
        .option("--intent <text>", "max 200 characters")
        .option("--when <text>")
        .option("--state <state>", "draft, proposed, accepted (default), deprecated")
        .option("--featured", "inject the body at session start")
        .option("--no-featured")
        .option("--body-file <path>", "body markdown; - for stdin")
        .option("--json");
    if (kind.categories)
        cmd.option("--category <name>");
    if (kind.noun === "tech") {
        cmd
            .option("--ecosystem <name>", "npm, maven, docker, github-actions, runtime, service")
            .option("--package <name[@range]>", "repeat per package", collect)
            .option("--bom-version <range>", "version range for the whole component (BOM)")
            .option("--rationale <text>")
            .option("--docs <url>")
            .option("--license <spdx>")
            .option("--last-review <YYYY-MM-DD>", "default today")
            .option("--review-interval-months <n>")
            .option("--cooldown-exemption <name@version=CVE-YYYY-NNNN:YYYY-MM-DD>", "exempt a version from the cooldown until a date, naming the CVE (repeat)", collect);
    }
    return cmd;
}
function codeKeyFromCwd(path) {
    const root = findGitRoot(process.cwd());
    if (!root)
        return { ok: false, message: "not inside a git repository", nextAction: "Run the command inside the code repository." };
    const repo = originRepository(root);
    if (!repo)
        return { ok: false, message: "the `origin` remote is not a GitHub repository", nextAction: "Run the command in a clone of a GitHub code repository with an `origin` remote." };
    const t = codeTarget(repo, path);
    if ("error" in t)
        return { ok: false, message: t.error, nextAction: "Pass a path relative to the git root, for example `src/main.ts` or `src/_` for the folder." };
    return t;
}
/** Registers `adr`, `proc`, `tech` and `code` with their verbs. */
export function registerDocumentCommands(program) {
    for (const noun of ["adr", "proc", "tech", "code"]) {
        const kind = KINDS[noun];
        const cmd = program
            .command(noun)
            .option("--ref <ref>", "branch or tag to read categories from", "main")
            .option("--json")
            .enablePositionalOptions()
            .action(async (o) => nounHelp(kind, o.ref, { json: !!o.json }));
        cmd.helpInformation = () => `Run \`${CLI} ${noun}\` for the ${kind.name} guide.\n`;
        if (noun === "code") {
            const run = (mode) => async (path, o) => {
                const out = { json: !!o.json };
                const t = codeKeyFromCwd(path);
                if ("ok" in t) {
                    print(out, t, renderRefusal(t));
                    process.exitCode = 1;
                    return;
                }
                await withClient(out, async (client) => {
                    const r = await writeShadow(client, kind, mode, t, fieldsFrom(o), readBody(o.bodyFile), { version: o.version, branch: o.branch });
                    print(out, r, renderWrite(kind, r));
                    return r.ok ? 0 : 1;
                });
            };
            addFieldOptions(cmd.command("create").argument("<path>"), kind).action(run("create"));
            addFieldOptions(cmd.command("update").argument("<path>"), kind).action(run("update"));
            cmd
                .command("show")
                .argument("<path>")
                .option("--ref <ref>", "branch or tag", "main")
                .option("--json")
                .action(async (path, o) => {
                const out = { json: !!o.json };
                const t = codeKeyFromCwd(path);
                if ("ok" in t) {
                    print(out, t, renderRefusal(t));
                    process.exitCode = 1;
                    return;
                }
                await withClient(out, async (client) => {
                    const r = await showShadow(client, t, o.ref);
                    print(out, r, renderShown(r));
                    return r.ok ? 0 : 1;
                });
            });
            continue;
        }
        addFieldOptions(cmd.command("create"), kind).action(async (o) => {
            const out = { json: !!o.json };
            const body = readBody(o.bodyFile);
            if (body === undefined) {
                const r = { ok: false, message: "no --body-file given", nextAction: "Pass the body with --body-file <path> or --body-file - for stdin." };
                print(out, r, renderRefusal(r));
                process.exitCode = 1;
                return;
            }
            await withClient(out, async (client) => {
                const r = await createDocument(client, kind, fieldsFrom(o), body, { version: o.version, branch: o.branch });
                print(out, r, renderWrite(kind, r));
                return r.ok ? 0 : 1;
            });
        });
        addFieldOptions(cmd.command("update").argument("<id>"), kind).action(async (id, o) => {
            const out = { json: !!o.json };
            await withClient(out, async (client) => {
                const r = await updateDocument(client, kind, id, fieldsFrom(o), readBody(o.bodyFile), { version: o.version, branch: o.branch });
                print(out, r, renderWrite(kind, r));
                return r.ok ? 0 : 1;
            });
        });
        cmd
            .command("show")
            .argument("<id>")
            .option("--ref <ref>", "branch or tag", "main")
            .option("--json")
            .action(async (id, o) => {
            const out = { json: !!o.json };
            await withClient(out, async (client) => {
                const r = await showDocument(client, kind, id, o.ref);
                print(out, r, renderShown(r));
                return r.ok ? 0 : 1;
            });
        });
        cmd
            .command("list")
            .option("--ref <ref>", "branch or tag", "main")
            .option("--state <state>")
            .option("--category <name>")
            .option("--json")
            .action(async (o) => {
            const out = { json: !!o.json };
            await withClient(out, async (client) => {
                const { documents: docs, source } = await listFromIndexOrDirect(client, kind, o.ref, { state: o.state, category: o.category });
                const lines = docs.length ? docs.map((d) => `- ${d.id}${d.pending ? " (pending)" : ""} · ${d.title} · ${d.state} · ${d.intent}`) : ["No documents match."];
                print(out, { ok: true, ref: o.ref, source, documents: docs }, md(`${kind.name}: ${docs.length} at \`${o.ref}\``, [...lines, "", sourceLine(source, o.ref)], `Open one with \`${CLI} ${noun} show <ID> --ref ${o.ref}\`.`));
                return 0;
            });
        });
    }
}
