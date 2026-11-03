import { loadConfigFromFiles, type Config, type Finding } from "../engine/index.js";
import { branchHead, listFolder, readFile, type FolderEntry, type GitHubClient } from "../github/index.js";

/**
 * Read access to the documentation repository through the GitHub client,
 * over an ordered list of refs (work branch first, then base). This is the
 * small path that the index (phase 4) replaces for list/show.
 */
export class DocRepo {
  private readonly folders = new Map<string, Promise<FolderEntry[] | undefined>>();
  private readonly files = new Map<string, Promise<string | undefined>>();

  constructor(readonly client: GitHubClient) {}

  folder(path: string, ref: string): Promise<FolderEntry[] | undefined> {
    const key = `${ref}\0${path}`;
    if (!this.folders.has(key)) this.folders.set(key, listFolder(this.client, path, ref));
    return this.folders.get(key)!;
  }

  text(path: string, ref: string): Promise<string | undefined> {
    const key = `${ref}\0${path}`;
    if (!this.files.has(key)) this.files.set(key, readFile(this.client, path, ref).then((f) => f?.text()));
    return this.files.get(key)!;
  }

  async exists(branch: string): Promise<boolean> {
    return (await branchHead(this.client, branch)) !== undefined;
  }

  /** Path of `docs/<folder>/<number>-*.md` on the first ref that has it. */
  async findNumbered(folder: string, number: string, refs: string[]): Promise<{ file: string; ref: string } | undefined> {
    for (const ref of refs) {
      const entries = await this.folder(`docs/${folder}`, ref);
      const hit = entries?.find((e) => e.type === "file" && e.name.startsWith(`${number}-`) && e.name.endsWith(".md"));
      if (hit) return { file: hit.path, ref };
    }
    return undefined;
  }

  /** First of `paths` that exists on the first ref that has any of them. */
  async findFirst(paths: string[], refs: string[]): Promise<{ file: string; ref: string; text: string } | undefined> {
    for (const ref of refs) {
      for (const file of paths) {
        const text = await this.text(file, ref);
        if (text !== undefined) return { file, ref, text };
      }
    }
    return undefined;
  }

  /** The configuration in config/*.yaml at a ref. */
  async config(ref: string): Promise<{ config?: Config; findings: Finding[] }> {
    const entries = (await this.folder("config", ref)) ?? [];
    const yaml = entries.filter((e) => e.type === "file" && e.name.endsWith(".yaml"));
    const files = await Promise.all(yaml.map(async (e) => ({ name: e.name, text: (await this.text(e.path, ref)) ?? "" })));
    return loadConfigFromFiles(files);
  }
}
