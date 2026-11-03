import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { GitHubClient, GitHubError } from "../github/index.js";
import { localGit } from "../index/build.js";
import { cacheDir } from "../index/read.js";
import { publishSite, removeSite } from "../site/publish.js";
import { buildSite, SITE_REF_RE } from "../site/render.js";
import { createViewer } from "../site/server.js";
import { SiteSource } from "../site/source.js";
import { loadSetup, renderSetupProblems, TOKEN_ENV } from "../setup/setup.js";
const CLI = "idc365-decisions";
function md(title, lines, next) {
    return [`# ${title}`, "", ...lines, ...(lines.length ? [""] : []), "## Next action", "", next, ""].join("\n");
}
/** The command that opens a URL in the default browser. The URL has no `&`, so cmd's `start` takes it as one argument. */
export function openCommand(platform, url) {
    if (platform === "win32")
        return { command: "cmd", args: ["/c", "start", '""', url] };
    if (platform === "darwin")
        return { command: "open", args: [url] };
    return { command: "xdg-open", args: [url] };
}
function openBrowser(url) {
    const { command, args } = openCommand(process.platform, url);
    try {
        const child = spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: process.platform === "win32" });
        child.on("error", () => process.stderr.write(`Could not start ${command}; open the URL by hand.\n`));
        child.unref();
    }
    catch {
        process.stderr.write(`Could not start ${command}; open the URL by hand.\n`);
    }
}
function listFiles(dir, base = dir) {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).split("\\").join("/")];
    });
}
async function withToken(fn) {
    const token = process.env[TOKEN_ENV]?.trim();
    const repository = process.env.GITHUB_REPOSITORY?.trim() || (loadSetup(process.cwd()).ok ? loadSetup(process.cwd()).setup.repository : undefined);
    if (!token || !repository) {
        process.stdout.write(md("Setup incomplete", [`- ${!token ? `\`${TOKEN_ENV}\` is not set` : "no documentation repository (GITHUB_REPOSITORY or the link file)"}`], "Run this in the site workflow."));
        process.exitCode = 1;
        return;
    }
    try {
        process.exitCode = await fn(new GitHubClient({ repository, token }));
    }
    catch (err) {
        if (!(err instanceof GitHubError))
            throw err;
        process.stdout.write(md("GitHub error", [`- ${err.message}`], err.nextAction));
        process.exitCode = 1;
    }
}
export function registerSiteCommands(program) {
    const site = program.command("site").description("render and publish the HTML site (the site workflow)");
    site.helpInformation = () => md("Site (workflow commands)", [
        "Run by the site workflow, not by hand:",
        "",
        `- \`${CLI} site build --ref <ref> --kind branch|tag --repository <org/repo> --out <dir>\`: in a checkout of the ref, render every document to HTML.`,
        `- \`${CLI} site publish <dir>\`: write the folder to meta/site (bot token; only while the ref still points at the rendered commit).`,
        `- \`${CLI} site delete --ref <branch>\`: remove the folder of a deleted branch.`,
    ], `To read the documentation, run \`${CLI} view\`.`);
    site
        .command("build")
        .requiredOption("--ref <ref>")
        .option("--kind <kind>", "branch or tag", "branch")
        .requiredOption("--repository <org/repo>")
        .requiredOption("--out <dir>")
        .action(async (o) => {
        if (!SITE_REF_RE.test(o.ref) || (o.kind !== "branch" && o.kind !== "tag")) {
            process.stdout.write(md("Not a site ref", [`- \`${o.ref}\` (${o.kind}): only main, release/vX.Y.Z branches and vX.Y.Z tags are rendered.`], "Nothing to do."));
            process.exitCode = 1;
            return;
        }
        const { manifest, files } = await buildSite({ root: process.cwd(), ref: o.ref, kind: o.kind, repository: o.repository, git: localGit(process.cwd()) });
        for (const [path, content] of files) {
            const f = join(o.out, path);
            mkdirSync(dirname(f), { recursive: true });
            writeFileSync(f, content);
        }
        process.stdout.write(md(`Site rendered: ${o.ref}`, [`- ${manifest.documents.length} documents, ${files.size} files in \`${o.out}\``, `- Source commit ${manifest.sourceSha}`], `Run \`${CLI} site publish ${o.out}\` with the bot token.`));
    });
    site
        .command("publish")
        .argument("<dir>")
        .action(async (dir) => {
        await withToken(async (client) => {
            const manifest = JSON.parse(readFileSync(join(dir, "site.json"), "utf8"));
            const files = new Map(listFiles(dir).map((p) => [p, readFileSync(join(dir, p), "utf8")]));
            const r = await publishSite(client, manifest, files);
            process.stdout.write(md(`Site ${manifest.ref}: ${r.outcome}`, [`- Folder \`${r.folder}\` on meta/site`, `- Source commit ${manifest.sourceSha}`], "None."));
            return 0;
        });
    });
    site
        .command("delete")
        .requiredOption("--ref <branch>")
        .action(async (o) => {
        await withToken(async (client) => {
            const outcome = await removeSite(client, o.ref);
            process.stdout.write(md(`Site of ${o.ref}: ${outcome}`, [], "None."));
            return 0;
        });
    });
    program
        .command("view")
        .description("read the documentation as a website in your browser")
        .option("--no-open", "print the URL without opening the browser")
        .option("--port <port>", "port (default: a free one)", "0")
        .action(async (o) => {
        const setup = loadSetup(process.cwd());
        if (!setup.ok) {
            process.stdout.write(renderSetupProblems(setup.problems));
            process.exitCode = 1;
            return;
        }
        const client = new GitHubClient({ repository: setup.setup.repository, token: setup.setup.token });
        const source = new SiteSource(client, join(cacheDir(), "site"));
        const viewer = createViewer({ source, repository: setup.setup.repository });
        const { url } = await viewer.listen(Number(o.port) || 0);
        process.stdout.write(md("Documentation viewer", [`- ${url}`, `- ${setup.setup.repository}, read-only, served from this machine only (127.0.0.1). The link works once; it signs the browser in.`, "- Ctrl+C stops the viewer."], `Give the user this URL: ${url}${o.open ? " (the browser was opened)" : ""}. It keeps running until Ctrl+C.`));
        if (o.open)
            openBrowser(url);
        const stop = () => {
            void viewer.close().then(() => process.exit(0));
            setTimeout(() => process.exit(0), 1000).unref();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
}
