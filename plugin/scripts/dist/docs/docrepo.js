import { loadConfigFromFiles } from "../engine/index.js";
import { branchHead, listFolder, readFile } from "../github/index.js";
/**
 * Read access to the documentation repository through the GitHub client,
 * over an ordered list of refs (work branch first, then base). This is the
 * small path that the index (phase 4) replaces for list/show.
 */
export class DocRepo {
    client;
    folders = new Map();
    files = new Map();
    constructor(client) {
        this.client = client;
    }
    folder(path, ref) {
        const key = `${ref}\0${path}`;
        if (!this.folders.has(key))
            this.folders.set(key, listFolder(this.client, path, ref));
        return this.folders.get(key);
    }
    text(path, ref) {
        const key = `${ref}\0${path}`;
        if (!this.files.has(key))
            this.files.set(key, readFile(this.client, path, ref).then((f) => f?.text()));
        return this.files.get(key);
    }
    async exists(branch) {
        return (await branchHead(this.client, branch)) !== undefined;
    }
    /** Path of `docs/<folder>/<number>-*.md` on the first ref that has it. */
    async findNumbered(folder, number, refs) {
        for (const ref of refs) {
            const entries = await this.folder(`docs/${folder}`, ref);
            const hit = entries?.find((e) => e.type === "file" && e.name.startsWith(`${number}-`) && e.name.endsWith(".md"));
            if (hit)
                return { file: hit.path, ref };
        }
        return undefined;
    }
    /** First of `paths` that exists on the first ref that has any of them. */
    async findFirst(paths, refs) {
        for (const ref of refs) {
            for (const file of paths) {
                const text = await this.text(file, ref);
                if (text !== undefined)
                    return { file, ref, text };
            }
        }
        return undefined;
    }
    /** The configuration in config/*.yaml at a ref. */
    async config(ref) {
        const entries = (await this.folder("config", ref)) ?? [];
        const yaml = entries.filter((e) => e.type === "file" && e.name.endsWith(".yaml"));
        const files = await Promise.all(yaml.map(async (e) => ({ name: e.name, text: (await this.text(e.path, ref)) ?? "" })));
        return loadConfigFromFiles(files);
    }
}
