import { resolve } from "node:path";
import { GitHubClient, GitHubError } from "../github/index.js";
import { chooseBase, readMarker, writeMarker } from "../postmerge/marker.js";
import { postMerge } from "../postmerge/postmerge.js";
import { clientFor } from "./index-cmd.js";
function md(title, lines, next) {
    return [`# ${title}`, "", ...lines, ...(lines.length ? [""] : []), "## Next action", "", next, ""].join("\n");
}
/** `post-merge`: the bot's follow-up edits after a merge into a truth branch (run by the post-merge workflow). */
export function registerPostMergeCommand(program) {
    const cmd = program
        .command("post-merge")
        .requiredOption("--branch <name>", "truth branch that was pushed")
        .requiredOption("--after <sha>", "pushed commit")
        .option("--before <sha>", "previous head (default: check every document)")
        .option("--root <dir>", "checkout of the pushed commit", ".")
        .option("--repository <owner/repo>", "default: GITHUB_REPOSITORY")
        .option("--marker", "handle everything since the last handled commit recorded on meta/index (falls back to --before), and record --after when done")
        .option("--dry-run", "plan and validate only")
        .option("--json")
        .action(async (o) => {
        const client = o.dryRun ? undefined : clientFor(o.repository);
        if (client && !(client instanceof GitHubClient)) {
            process.stdout.write(o.json ? JSON.stringify({ ok: false, ...client }) + "\n" : md(`Cannot run post-merge: ${client.error}`, [], client.nextAction));
            process.exitCode = 1;
            return;
        }
        try {
            let before = o.before;
            let base = "push event";
            if (o.marker) {
                // Read access is enough here (the dry run uses the workflow token).
                const reader = client ?? clientFor(o.repository);
                if (reader instanceof GitHubClient) {
                    const { marker } = await readMarker(reader, o.branch);
                    const chosen = chooseBase(resolve(o.root), marker, o.before, o.after);
                    before = chosen.before;
                    base = chosen.from === "marker" ? `last handled commit ${marker.sha.slice(0, 7)}` : chosen.from === "event" ? "push event (no usable marker)" : "none";
                }
            }
            const r = await postMerge({ root: resolve(o.root), branch: o.branch, before, after: o.after, client, dryRun: o.dryRun });
            let recorded;
            if (o.marker && client && r.outcome !== "invalid")
                recorded = await writeMarker(client, resolve(o.root), o.branch, o.after);
            const lines = [
                `- Handled range: ${before ? before.slice(0, 7) : "everything"}..${o.after.slice(0, 7)} (base: ${base})${recorded ? `; marker ${recorded}` : ""}`,
                `- Changed documents: ${r.changed === "all" ? "all (no previous head)" : r.changed.length ? r.changed.map((f) => `\`${f}\``).join(", ") : "none"}`,
                ...r.edits.map((e) => `- \`${e.file}\`: ${e.reasons.join(", ")}`),
                ...r.findings.map((f) => `- \`${f.rule}\` in \`${f.file}\`: ${f.message}`),
                ...(r.commit ? [`- Commit: ${r.commit}`] : []),
                ...r.actions.map((a) => `- ${a.kind} ${a.kind === "create-tag" ? a.tag : a.branch}: ${a.done ? "done" : a.skipped ?? "planned"} (${a.reason})`),
            ];
            const title = { nothing: "Post-merge: nothing to do", committed: `Post-merge: ${r.edits.length} document${r.edits.length === 1 ? "" : "s"} updated`, "dry-run": "Post-merge: planned (dry run)", invalid: "Post-merge: the result would not validate; nothing written" }[r.outcome];
            process.stdout.write(o.json ? JSON.stringify({ ok: r.outcome !== "invalid", before: before ?? null, base, marker: recorded ?? null, ...r }, null, 2) + "\n" : md(title, lines, r.outcome === "invalid" ? "Fix the findings on the branch via PR, then rerun the post-merge workflow." : "None."));
            process.exitCode = r.outcome === "invalid" ? 1 : 0;
        }
        catch (err) {
            if (!(err instanceof GitHubError))
                throw err;
            process.stdout.write(o.json ? JSON.stringify({ ok: false, error: err.message, nextAction: err.nextAction }) + "\n" : md("GitHub error", [`- ${err.message}`, ...err.details.map((d) => `  ${d}`)], err.nextAction));
            process.exitCode = 1;
        }
    });
    cmd.helpInformation = () => "Run by the post-merge workflow: `idc365-decisions post-merge --branch main --before <sha> --after <sha>`.\n";
}
