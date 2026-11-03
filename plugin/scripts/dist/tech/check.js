import { DocRepo } from "../docs/docrepo.js";
import { isRecord, parseYaml, splitFrontmatter } from "../engine/index.js";
import { exactVersion, npmSpec, techRange, within } from "./ranges.js";
/** TECH documents on a ref (only `accepted` ones count for the positive list). */
export async function loadTechs(client, ref, repo = new DocRepo(client)) {
    const entries = ((await repo.folder("docs/techstack", ref)) ?? []).filter((e) => e.type === "file" && /^[0-9]{4,}-.+\.md$/.test(e.name));
    const out = [];
    for (const e of entries) {
        const split = splitFrontmatter((await repo.text(e.path, ref)) ?? "");
        if (!split)
            continue;
        let fm;
        try {
            fm = parseYaml(split.frontmatter);
        }
        catch {
            continue;
        }
        if (!isRecord(fm) || typeof fm.id !== "string")
            continue;
        out.push({
            id: fm.id,
            file: e.path,
            title: String(fm.title ?? ""),
            state: String(fm.state ?? ""),
            ecosystem: String(fm.ecosystem ?? ""),
            version: typeof fm.version === "string" ? fm.version : undefined,
            packages: (Array.isArray(fm.packages) ? fm.packages : []).filter(isRecord).map((p) => ({ name: String(p.name), version: typeof p.version === "string" ? p.version : undefined })),
            exemptions: (Array.isArray(fm.cooldown_exemptions) ? fm.cooldown_exemptions : []).filter(isRecord).map((x) => ({ package: String(x.package), version: String(x.version), cve: String(x.cve), until: String(x.until) })),
        });
    }
    return out;
}
const DAY = 86_400_000;
/**
 * Compares every direct dependency with the TECH positive list (spec 5.3):
 * listed in an accepted TECH of the same ecosystem, the declared version
 * inside the allowed range, a versionless Maven dependency managed by an
 * approved parent or BOM, and, for npm and Maven, at least `cooldownDays`
 * old unless an unexpired exemption names that version and a CVE.
 */
export async function checkManifests(manifests, techs, opts) {
    const today = opts.today ?? new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const accepted = techs.filter((t) => t.state === "accepted");
    const findings = [];
    const notes = [];
    let count = 0;
    const listedIn = (eco, name) => accepted.filter((t) => t.ecosystem === eco && t.packages.some((p) => p.name === name));
    const rangeOf = (t, name) => t.packages.find((p) => p.name === name)?.version ?? t.version;
    const declared = (d) => (d.ecosystem === "npm" ? npmSpec(d.spec ?? "") : exactVersion(d.spec ?? ""));
    for (const m of manifests) {
        if (m.error) {
            findings.push({ manifest: m.file, package: "-", rule: "tech.manifest", message: `cannot read the manifest: ${m.error}`, fix: "Fix the file so it parses." });
            continue;
        }
        const approvedBoms = new Map(); // pom parent/BOM artifact → its TECH, when approved
        for (const d of m.dependencies) {
            count++;
            const add = (rule, message, fix) => findings.push({ manifest: m.file, package: d.name, version: d.spec, rule, message, fix });
            if (d.problem) {
                add("tech.unpinned", `\`${d.name}\`: ${d.problem}`, d.ecosystem === "docker" ? "Pin the base image to a version tag, for example `node:24.11-alpine`." : "Give the dependency a concrete version.");
                continue;
            }
            const techsFor = listedIn(d.ecosystem, d.name);
            if (techsFor.length === 0) {
                add("tech.unlisted", `\`${d.name}\` is not on the tech stack positive list (${d.ecosystem})`, `Ask the user whether it may be used; if yes, list it via PR: \`idc365-decisions tech create --version vX.Y.Z --ecosystem ${d.ecosystem} --package ${d.name}@<range> …\`, or add it to an existing TECH with \`tech update\`.`);
                continue;
            }
            // Versionless Maven dependency: managed by a parent or BOM that is approved by the same TECH.
            if (d.ecosystem === "maven" && d.spec === undefined) {
                const bomTech = techsFor.find((t) => t.version && [...approvedBoms.values()].includes(t));
                if (!bomTech) {
                    add("tech.bom", `\`${d.name}\` has no version and is not managed by an approved parent or BOM`, `Use the parent or BOM of ${techsFor.map((t) => t.id).join(", ")} in its approved range, or give the dependency an approved version.`);
                }
                continue;
            }
            const have = declared(d);
            if (!have) {
                add("tech.spec", `\`${d.name}\`: version \`${d.spec}\` cannot be checked`, d.ecosystem === "npm" ? "Use an exact version, ^ or ~ (for example `^19.2.0`)." : "Use a plain version like 1.2.3.");
                continue;
            }
            const fits = techsFor.find((t) => {
                const r = rangeOf(t, d.name);
                const range = r ? techRange(r) : undefined;
                return range ? within(have, range) : r === undefined; // no range at all: any version (services)
            });
            if (!fits) {
                const ranges = techsFor.map((t) => `${t.id} allows ${rangeOf(t, d.name) ?? "any"}`).join("; ");
                add("tech.range", `\`${d.name}@${d.spec}\` is outside the approved range (${ranges})`, `Use a version in the approved range, or change the range via PR (\`idc365-decisions tech update ${techsFor[0].id} --version vX.Y.Z --package ${d.name}@<range>\`).`);
                continue;
            }
            if (d.role === "parent" || d.role === "bom")
                approvedBoms.set(d.name, fits);
            // Cooldown (npm, Maven).
            if (!opts.releaseDate || d.ecosystem === "docker" || !d.resolved)
                continue;
            const published = await opts.releaseDate(d.ecosystem, d.name, d.resolved);
            if (!published) {
                notes.push({ manifest: m.file, package: d.name, message: `release date of ${d.resolved} not found; cooldown not checked` });
                continue;
            }
            const age = (today.getTime() - published.getTime()) / DAY;
            if (age >= opts.cooldownDays)
                continue;
            const exemptions = techsFor.flatMap((t) => t.exemptions.map((e) => ({ ...e, tech: t.id }))).filter((e) => e.package === d.name && e.version === d.resolved);
            const valid = exemptions.find((e) => e.until >= todayIso);
            if (valid) {
                notes.push({ manifest: m.file, package: d.name, message: `${d.resolved} is ${age.toFixed(1)} days old; exempted by ${valid.tech} for ${valid.cve} until ${valid.until}` });
                continue;
            }
            for (const e of exemptions)
                notes.push({ manifest: m.file, package: d.name, message: `exemption in ${e.tech} for ${e.cve} expired on ${e.until}` });
            const ready = new Date(published.getTime() + opts.cooldownDays * DAY).toISOString().slice(0, 16).replace("T", " ");
            add("tech.cooldown", `\`${d.name}@${d.resolved}\` was published ${published.toISOString().slice(0, 10)}, ${age.toFixed(1)} days ago; the cooldown is ${opts.cooldownDays} days`, `Wait until ${ready} UTC, or, if a CVE requires it now, exempt it via PR: \`idc365-decisions tech update ${techsFor[0].id} --version vX.Y.Z --cooldown-exemption ${d.name}@${d.resolved}=CVE-YYYY-NNNN:${new Date(today.getTime() + opts.cooldownDays * DAY).toISOString().slice(0, 10)}\`.`);
        }
    }
    return { ref: opts.ref, manifests: manifests.map((m) => m.file), dependencies: count, findings, notes };
}
