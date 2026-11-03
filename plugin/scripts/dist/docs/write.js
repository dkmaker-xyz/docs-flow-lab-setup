import { isRecord, parseYaml, splitFrontmatter, validateDocuments } from "../engine/index.js";
import { allocateIds, baseBranchFor, commitFiles, createBranchWithCommit, formatId, GitHubError, openPullRequest, parseVersion, } from "../github/index.js";
import { compose, placeholderDocument, Resolver } from "./compose.js";
import { DocRepo } from "./docrepo.js";
import { slugify } from "./slug.js";
const refuse = (message, nextAction, extra = {}) => ({ ok: false, message, nextAction, ...extra });
const WORK_BRANCH_RE = /^(v[0-9]+\.[0-9]+\.[0-9]+)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
async function resolveTarget(client, repo, opts) {
    let version = opts.version;
    if (opts.branch) {
        const m = WORK_BRANCH_RE.exec(opts.branch);
        if (!m)
            return refuse(`\`${opts.branch}\` is not a work branch (vX.Y.Z/<slug>)`, "Pass an existing work branch, or omit --branch to create one.");
        if (version && version !== m[1])
            return refuse(`--version ${version} does not match the branch ${opts.branch}`, `Omit --version or use ${m[1]}.`);
        version = m[1];
        if (!(await repo.exists(opts.branch)))
            return refuse(`work branch \`${opts.branch}\` does not exist`, "Omit --branch to create a new work branch.");
    }
    if (!version)
        return refuse("no --version given", "Pass the version the change belongs to, for example `--version v1.0.1`.");
    if (!parseVersion(version))
        return refuse(`\`${version}\` is not a version like v1.0.1`, "Use a full version vMAJOR.MINOR.PATCH.");
    if (opts.base)
        return { version, base: opts.base, existing: opts.branch };
    const base = await baseBranchFor(client, version);
    if (!base.ok)
        return refuse(base.message, base.nextAction);
    return { version, base: base.base, existing: opts.branch };
}
/** Frontmatter fields in output order; `existing` keeps fields the CLI does not manage. */
function buildFields(kind, id, f, existing = {}) {
    const pick = (v, key) => (v !== undefined ? v : existing[key]);
    const out = {};
    const { relations: _r, ...rest } = existing;
    if (kind.type !== "shadow")
        out.id = id ?? existing.id;
    out.title = pick(f.title, "title");
    out.description = pick(f.description, "description");
    out.intent = pick(f.intent, "intent");
    out.when = pick(f.when, "when");
    out.state = pick(f.state, "state") ?? "accepted";
    if (kind.categories)
        out.category = pick(f.category, "category");
    const featured = pick(f.featured, "featured");
    if (featured === true)
        out.featured = true;
    if (kind.type === "techstack") {
        out.ecosystem = pick(f.ecosystem, "ecosystem");
        out.version = pick(f.bomVersion, "version");
        // On update, --package entries replace the package of the same name and add new ones; the others stay.
        const given = f.packages?.map((p) => (p.version ? { name: p.name, version: p.version } : { name: p.name }));
        const prior = Array.isArray(existing.packages) ? existing.packages : undefined;
        out.packages = given && prior ? [...prior.map((p) => given.find((g) => g.name === p.name) ?? p), ...given.filter((g) => !prior.some((p) => p.name === g.name))] : pick(given, "packages");
        out.rationale = pick(f.rationale, "rationale");
        out.docs = pick(f.docs, "docs");
        out.license = pick(f.license, "license");
        out.last_review = pick(f.lastReview, "last_review") ?? new Date().toISOString().slice(0, 10);
        out.review_interval_months = pick(f.reviewIntervalMonths, "review_interval_months");
        const priorEx = Array.isArray(existing.cooldown_exemptions) ? existing.cooldown_exemptions : [];
        const added = (f.cooldownExemptions ?? []).filter((e) => !priorEx.some((p) => p.package === e.package && p.version === e.version));
        if (priorEx.length || added.length)
            out.cooldown_exemptions = [...priorEx, ...added];
    }
    // Unknown or unmanaged fields from an existing file stay as they were (validation reports them).
    for (const [k, v] of Object.entries(rest))
        if (!(k in out) && k !== "placeholder")
            out[k] = v;
    // Extra type fields replace existing ones in place; new ones go last.
    for (const [k, v] of Object.entries(f.extra ?? {}))
        out[k] = v;
    return out;
}
async function draft(repo, config, refs, kind, file, key, fields, relations, body) {
    const resolver = new Resolver(repo, refs, config, new Map([[key, file]]));
    const c = await compose({ file, fields, relations, body }, resolver);
    if (c.problems.length) {
        return refuse(`${c.problems.length} reference problem${c.problems.length === 1 ? "" : "s"}; nothing was written`, "Fix each problem below and run the command again.", { problems: c.problems });
    }
    const written = [{ file, text: c.text }, ...[...resolver.placeholders.values()].map((p) => ({ file: p, text: placeholderDocument() }))];
    const findings = validateDocuments(config, written, c.known);
    if (findings.length) {
        return refuse(`the ${kind.noun} does not validate; nothing was written`, "Fix each finding below and run the command again.", { findings });
    }
    return { file, text: c.text, placeholders: resolver.placeholders };
}
export async function loadConfig(repo, ref) {
    const { config, findings } = await repo.config(ref);
    if (!config)
        return refuse(`the configuration on \`${ref}\` is not valid`, "Fix config/ in the documentation repository via PR.", { findings });
    return config;
}
async function findOpenPr(client, branch) {
    const res = await client.request("GET", client.repoPath("/pulls"), {
        query: { head: `${client.owner}:${branch}`, state: "open" },
    });
    const pr = res.data[0];
    return pr ? { number: pr.number, url: pr.html_url, body: pr.body ?? "" } : undefined;
}
const PR_FOOTER = "Review the change and merge it in GitHub. The CLI never merges.";
function prBody(lines) {
    return ["Documentation change written by the idc365-decisions CLI.", "", ...lines, "", PR_FOOTER].join("\n");
}
/** Commits the draft on a new or existing work branch and opens or extends its PR. */
async function publish(client, target, branchSlug, d, summary, action, key) {
    const branch = target.existing ?? `${target.version}/${branchSlug}`;
    const changes = [{ path: d.file, content: d.text }, ...(d.extraFiles ?? [])];
    for (const p of d.placeholders.values())
        changes.push({ path: p, content: placeholderDocument() });
    const placeholderNote = d.placeholders.size ? ` (+ ${d.placeholders.size} placeholder shadow${d.placeholders.size === 1 ? "" : "s"})` : "";
    let commit;
    if (target.existing) {
        commit = await commitFiles(client, branch, changes, `${summary}${placeholderNote}`);
    }
    else {
        // A new work branch is created at its first commit: one push, not two.
        try {
            commit = await createBranchWithCommit(client, branch, target.base, changes, `${summary}${placeholderNote}`);
        }
        catch (err) {
            if (err instanceof GitHubError && err.status === 422) {
                return refuse(`work branch \`${branch}\` already exists`, `Add to it with \`--branch ${branch}\`, or change the title.`);
            }
            throw err;
        }
    }
    const line = `- ${summary} (\`${d.file}\`)${placeholderNote}`;
    const open = target.existing ? await findOpenPr(client, branch) : undefined;
    let pr;
    if (open) {
        const lines = open.body.split("\n");
        const lastItem = lines.map((l) => l.startsWith("- ")).lastIndexOf(true);
        if (lastItem >= 0)
            lines.splice(lastItem + 1, 0, line);
        else
            lines.push("", line);
        await client.request("PATCH", client.repoPath(`/pulls/${open.number}`), { body: { body: lines.join("\n") } });
        pr = { number: open.number, url: open.url, opened: false };
    }
    else {
        const created = await openPullRequest(client, branch, target.base, summary, prBody([line]));
        pr = { number: created.number, url: created.url, opened: true };
    }
    return { ok: true, action, key, file: d.file, branch, base: target.base, commit: commit.sha, placeholders: [...d.placeholders.values()], pr };
}
function refsFor(target) {
    return target.existing ? [target.existing, target.base] : [target.base];
}
/** `<noun> create` for ADR, PROC and TECH (spec 3.1, 4.2, 6.1, 7.1). */
export async function createDocument(client, kind, fields, body, opts, extras = {}) {
    if (!kind.prefix || !kind.folder)
        throw new Error("createDocument is for typed documents; use createShadow for code");
    const repo = new DocRepo(client);
    const target = await resolveTarget(client, repo, opts);
    if ("ok" in target)
        return target;
    const refs = refsFor(target);
    const config = await loadConfig(repo, refs[0]);
    if ("ok" in config)
        return config;
    if (!fields.title)
        return refuse("no --title given", "Pass --title.");
    const slug = slugify(fields.title);
    // Validate with a provisional number first, so a refused document costs no ID.
    const provisional = `${kind.prefix}-0000`;
    const fileFor = (id) => `docs/${kind.folder}/${id.slice(kind.prefix.length + 1)}-${slug}.md`;
    const tryDraft = (id) => draft(repo, config, refs, kind, fileFor(id), id, buildFields(kind, id, fields), extras.relations ?? [], body);
    const first = await tryDraft(provisional);
    if ("ok" in first)
        return first;
    const { ids } = await allocateIds(client, kind.prefix);
    const id = ids[0];
    const final = await tryDraft(id);
    if ("ok" in final)
        return final;
    if (extras.extraFiles) {
        const more = await extras.extraFiles(id, fileFor(id), refs, config);
        if (!Array.isArray(more))
            return more;
        final.extraFiles = more;
    }
    return publish(client, target, slugify(`${id} ${fields.title}`), final, `${extras.verb ?? "Add"} ${id}: ${fields.title}`, "created", id);
}
/** Normalises `ADR-0042`, `0042` or `42` to `ADR-0042`. */
export function normaliseId(kind, input) {
    const m = new RegExp(`^(?:${kind.prefix}-)?([0-9]{1,})$`, "i").exec(input.trim());
    return m && kind.prefix ? formatId(kind.prefix, Number(m[1])) : undefined;
}
function parseExisting(text) {
    const split = splitFrontmatter(text);
    if (!split)
        return undefined;
    try {
        const fm = parseYaml(split.frontmatter);
        return isRecord(fm) ? { fm, body: split.body } : undefined;
    }
    catch {
        return undefined;
    }
}
/** `<noun> update <ID>`: a correction in the same file (spec 3.4). The file name is kept. */
export async function updateDocument(client, kind, idInput, fields, body, opts) {
    const id = normaliseId(kind, idInput);
    if (!id)
        return refuse(`\`${idInput}\` is not a ${kind.prefix} ID`, `Pass an ID like ${kind.prefix}-0042.`);
    const repo = new DocRepo(client);
    const target = await resolveTarget(client, repo, opts);
    if ("ok" in target)
        return target;
    const refs = refsFor(target);
    const found = await repo.findNumbered(kind.folder, id.slice(kind.prefix.length + 1), refs);
    if (!found)
        return refuse(`${id} does not exist on ${refs.join(" or ")}`, `Check the ID with \`idc365-decisions ${kind.noun} list\`, or create it with \`${kind.noun} create\`.`);
    const existing = parseExisting((await repo.text(found.file, found.ref)) ?? "");
    if (!existing)
        return refuse(`${found.file} has no readable frontmatter`, "Ask the user to repair the file via PR.");
    const config = await loadConfig(repo, refs[0]);
    if ("ok" in config)
        return config;
    const relations = Array.isArray(existing.fm.relations) ? existing.fm.relations : [];
    const d = await draft(repo, config, refs, kind, found.file, id, buildFields(kind, id, fields, existing.fm), relations, body ?? existing.body);
    if ("ok" in d)
        return d;
    const title = String((fields.title ?? existing.fm.title) || id);
    return publish(client, target, slugify(`update ${id} ${title}`), d, `Update ${id}: ${title}`, "updated", id);
}
/**
 * `code create|update <path>` for shadow documents (spec 5.6). `create`
 * fills a placeholder; it refuses when a real document exists.
 */
export async function writeShadow(client, kind, mode, code, fields, body, opts) {
    const repo = new DocRepo(client);
    const target = await resolveTarget(client, repo, opts);
    if ("ok" in target)
        return target;
    const refs = refsFor(target);
    const config = await loadConfig(repo, refs[0]);
    if ("ok" in config)
        return config;
    const repoId = code.key.slice(5).split("/").slice(0, 2).join("/");
    if (!config.repositories.includes(repoId))
        return refuse(`code repository \`${repoId}\` is not configured`, "Ask the user to add it to `repositories` in config/repositories.yaml via PR.");
    const found = await repo.findFirst([code.file], refs);
    const existing = found ? parseExisting(found.text) : undefined;
    const isPlaceholder = existing?.fm.placeholder === true;
    if (mode === "create" && existing && !isPlaceholder)
        return refuse(`${code.key} is already documented (\`${code.file}\`)`, `Use \`idc365-decisions code update\` to correct it.`);
    if (mode === "update" && !existing)
        return refuse(`${code.key} has no shadow document`, "Use `idc365-decisions code create` first.");
    if (mode === "create" && body === undefined)
        return refuse("no --body-file given", "Pass the body with --body-file <path> or --body-file - for stdin.");
    const base = isPlaceholder ? {} : existing?.fm ?? {};
    const relations = existing && Array.isArray(existing.fm.relations) ? existing.fm.relations : [];
    const d = await draft(repo, config, refs, kind, code.file, code.key, buildFields(kind, undefined, fields, base), relations, body ?? existing?.body ?? "");
    if ("ok" in d)
        return d;
    const path = code.key.slice(5);
    const action = mode === "create" ? "created" : "updated";
    return publish(client, target, slugify(`code ${path.split("/").slice(2).join(" ") || "root"}`), d, `${mode === "create" ? "Document" : "Update"} ${code.key}`, action, code.key);
}
