import type { Command } from "commander";
import { DocRepo } from "../docs/docrepo.js";
import { findGitRoot } from "../docs/gitrepo.js";
import { GitHubClient, GitHubError } from "../github/index.js";
import { currentRelease } from "../release/release.js";
import { loadSetup, renderSetupProblems } from "../setup/setup.js";
import { checkManifests, loadTechs, type CheckResult } from "../tech/check.js";
import { readManifests } from "../tech/manifests.js";
import { registryDates } from "../tech/registry.js";

function md(title: string, lines: string[], next: string): string {
  return [`# ${title}`, "", ...lines, ...(lines.length ? [""] : []), "## Next action", "", next, ""].join("\n");
}

export function renderCheck(r: CheckResult, how: string): string {
  const head = `Checked ${r.dependencies} direct dependencies in ${r.manifests.length} manifest${r.manifests.length === 1 ? "" : "s"} against the tech stack on \`${r.ref}\` (${how}).`;
  const notes = r.notes.length ? ["", "Notes:", ...r.notes.map((n) => `- \`${n.manifest}\` ${n.package}: ${n.message}`)] : [];
  if (r.findings.length === 0) {
    return md("Tech check passed", [head, ...(r.manifests.length ? ["", ...r.manifests.map((m) => `- \`${m}\``)] : []), ...notes], "None. Every direct dependency is approved.");
  }
  const byManifest = new Map<string, typeof r.findings>();
  for (const f of r.findings) byManifest.set(f.manifest, [...(byManifest.get(f.manifest) ?? []), f]);
  const lines = [head, ""];
  for (const [file, list] of byManifest) {
    lines.push(`## ${file}`, "");
    for (const f of list) lines.push(`- \`${f.rule}\`: ${f.message}`, `  Fix: ${f.fix}`);
    lines.push("");
  }
  return md(`Tech check failed: ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`, [...lines, ...notes], "Fix each finding above. A package or range that is not approved needs a TECH change via PR, which the user reviews and merges; do not work around the check.");
}

/** `tech check`: run inside a code repository (spec 5.3). */
export function registerTechCheck(program: Command): void {
  const tech = program.commands.find((c) => c.name() === "tech");
  if (!tech) throw new Error("tech command missing");
  tech
    .command("check")
    .option("--ref <ref>", "documentation branch or tag (default: the branch `release current` resolves, else main)")
    .option("--no-cooldown", "skip the release-date check")
    .option("--json")
    .action(async (o: { ref?: string; cooldown: boolean; json?: boolean }) => {
      const json = !!o.json;
      const setup = loadSetup(process.cwd());
      if (!setup.ok) {
        process.stdout.write(json ? JSON.stringify({ ok: false, error: "setup incomplete", problems: setup.problems }) + "\n" : renderSetupProblems(setup.problems));
        process.exitCode = 1;
        return;
      }
      const root = findGitRoot(process.cwd()) ?? process.cwd();
      const client = new GitHubClient({ repository: setup.setup.repository, token: setup.setup.token });
      try {
        let ref = o.ref;
        let how = "given with --ref";
        if (!ref) {
          const cur = await currentRelease(client, root);
          ref = cur.ok ? cur.docsBranch : "main";
          how = cur.ok ? `${cur.rel.id} ${cur.rel.version}, ${cur.how}` : "no release resolved for this branch; using main";
        }
        const repo = new DocRepo(client);
        const { config } = await repo.config(ref);
        const cooldownDays = config?.cooldown_days ?? 3;
        const result = await checkManifests(readManifests(root), await loadTechs(client, ref, repo), { ref, cooldownDays, releaseDate: o.cooldown ? registryDates() : undefined });
        process.stdout.write(json ? JSON.stringify({ ok: result.findings.length === 0, resolved: how, cooldownDays, ...result }, null, 2) + "\n" : renderCheck(result, how));
        process.exitCode = result.findings.length ? 1 : 0;
      } catch (err) {
        if (!(err instanceof GitHubError)) throw err;
        process.stdout.write(json ? JSON.stringify({ ok: false, error: err.message, nextAction: err.nextAction }) + "\n" : md("GitHub error", [`- ${err.message}`], err.nextAction));
        process.exitCode = 1;
      }
    });
}
