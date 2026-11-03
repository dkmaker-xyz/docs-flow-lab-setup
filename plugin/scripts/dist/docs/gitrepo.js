import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
/** The git root (folder with `.git`) at or above `cwd`. */
export function findGitRoot(cwd) {
    let dir = resolve(cwd);
    for (;;) {
        if (existsSync(join(dir, ".git")))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
/** The git config file for a work tree, following `.git` files (worktrees, submodules) and `commondir`. */
function gitConfigPath(root) {
    let gitDir = join(root, ".git");
    if (statSync(gitDir).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
        if (!m)
            return undefined;
        gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(root, m[1].trim());
    }
    const common = join(gitDir, "commondir");
    if (existsSync(common))
        gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
    const config = join(gitDir, "config");
    return existsSync(config) ? config : undefined;
}
/** `org/repo` from a GitHub remote URL (https, ssh or scp-like). */
export function parseGitHubRemote(url) {
    const m = /github\.com[:/]+([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
    return m ? `${m[1]}/${m[2]}` : undefined;
}
/** org/repo of the `origin` remote of the code repository at `root`. */
export function originRepository(root) {
    const config = gitConfigPath(root);
    if (!config)
        return undefined;
    const text = readFileSync(config, "utf8");
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(text);
    const url = section ? /^\s*url\s*=\s*(.+)$/m.exec(section[1]) : null;
    return url ? parseGitHubRemote(url[1]) : undefined;
}
/**
 * Maps a path relative to the code repository's git root to its shadow
 * document: `src/main.ts` → code/o/r/src/main.ts.md; `src/_` or `src/` →
 * code/o/r/src/_.md; `_` → code/o/r/_.md.
 */
export function codeTarget(repository, path) {
    const p = path.trim().replace(/\\/g, "/");
    if (p === "" || isAbsolute(p) || p.split("/").some((s) => s === ".." || s === ".")) {
        return { error: `\`${path}\` must be a path relative to the git root, without \`..\`` };
    }
    let segs = p.split("/").filter(Boolean);
    let folder = p.endsWith("/");
    if (segs[segs.length - 1] === "_") {
        folder = true;
        segs = segs.slice(0, -1);
    }
    if (segs.some((s) => /\s/.test(s)))
        return { error: `\`${path}\` contains whitespace` };
    const rest = segs.join("/");
    const key = `CODE:${repository}${rest ? `/${rest}` : ""}`;
    const file = folder || !rest ? `code/${repository}${rest ? `/${rest}` : ""}/_.md` : `code/${repository}/${rest}.md`;
    return { key, file, folder: folder || !rest };
}
