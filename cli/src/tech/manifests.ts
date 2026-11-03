import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export type Ecosystem = "npm" | "maven" | "docker";

export interface Dependency {
  ecosystem: Ecosystem;
  /** npm package, Maven groupId:artifactId, or Docker image (without registry docker.io and library/). */
  name: string;
  /** Version as declared (npm spec, Maven version, Docker tag); undefined when the manifest gives none. */
  spec?: string;
  /** Concrete version for the release-date check (npm: lockfile or the spec's lowest version). */
  resolved?: string;
  /** maven: parent, bom (imported in dependencyManagement) or dependency. */
  role?: "parent" | "bom" | "dependency" | "dev" | "base-image";
  /** Problem reading this entry (unresolved property, unpinned image). */
  problem?: string;
}

export interface Manifest {
  /** Path relative to the repository root. */
  file: string;
  ecosystem: Ecosystem;
  dependencies: Dependency[];
  error?: string;
}

const SKIP = new Set(["node_modules", ".git", "target", "dist", "build", ".next", "out", "vendor"]);

/** Every package.json, pom.xml and Dockerfile* under `root`, skipping build output and dependencies. */
export function findManifests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name));
      } else if (e.name === "package.json" || e.name === "pom.xml" || /^Dockerfile/.test(e.name)) {
        out.push(posix(relative(root, join(dir, e.name))));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Lowest version an npm spec names (`^19.2.1` → 19.2.1), for the release date when there is no lockfile. */
function lowestNpmVersion(spec: string): string | undefined {
  const m = /^[\^~=v\s]*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec.trim());
  return m?.[1];
}

/** A relative path with forward slashes on every platform (Windows `relative` gives backslashes). */
const posix = (p: string) => p.split("\\").join("/");

/** Versions from the nearest package-lock.json (v2/v3 format) at or above the manifest. */
function lockVersions(root: string, file: string): Map<string, string> {
  let dir = dirname(join(root, file));
  for (;;) {
    const lock = join(dir, "package-lock.json");
    if (existsSync(lock)) {
      try {
        const data = JSON.parse(readFileSync(lock, "utf8")) as { packages?: Record<string, { version?: string }> };
        const rel = posix(relative(dir, dirname(join(root, file))));
        const out = new Map<string, string>();
        for (const [k, v] of Object.entries(data.packages ?? {})) {
          if (!v.version) continue;
          const name = k.replace(/^.*node_modules\//, "");
          const prefix = k.slice(0, k.length - `node_modules/${name}`.length);
          // Prefer the package's own nested node_modules, then the root one.
          if (prefix === (rel ? `${rel}/` : "") || (prefix === "" && !out.has(name))) out.set(name, v.version);
        }
        return out;
      } catch {
        return new Map();
      }
    }
    if (dir === root || dirname(dir) === dir) return new Map();
    dir = dirname(dir);
  }
}

export function parsePackageJson(root: string, file: string): Manifest {
  let data: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    data = JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch (err) {
    return { file, ecosystem: "npm", dependencies: [], error: `not valid JSON: ${(err as Error).message}` };
  }
  const lock = lockVersions(root, file);
  const deps: Dependency[] = [];
  for (const [section, role] of [["dependencies", "dependency"], ["devDependencies", "dev"]] as const) {
    for (const [name, spec] of Object.entries(data[section] ?? {})) {
      // Packages of the same monorepo are not third-party dependencies.
      if (/^(workspace|file|link|portal):/.test(spec)) continue;
      deps.push({ ecosystem: "npm", name, spec, resolved: lock.get(name) ?? lowestNpmVersion(spec), role });
    }
  }
  return { file, ecosystem: "npm", dependencies: deps };
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];

/**
 * Direct dependencies of a pom.xml (no XML library; Maven poms are regular):
 * the parent, BOMs imported in dependencyManagement, and <dependencies>.
 * ${properties} are resolved from <properties> and project.version.
 */
export function parsePom(root: string, file: string): Manifest {
  const raw = readFileSync(join(root, file), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const props = new Map<string, string>();
  const propsBlock = /<properties>([\s\S]*?)<\/properties>/.exec(raw)?.[1] ?? "";
  for (const m of propsBlock.matchAll(/<([A-Za-z0-9_.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props.set(m[1]!, m[2]!);
  const withoutParent = raw.replace(/<parent>[\s\S]*?<\/parent>/, "");
  const projectVersion = tag(withoutParent.replace(/<dependencies>[\s\S]*<\/dependencies>/, "").replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, "").replace(/<build>[\s\S]*?<\/build>/, ""), "version");
  if (projectVersion) props.set("project.version", projectVersion);
  const resolve = (v?: string): { value?: string; problem?: string } => {
    if (v === undefined) return {};
    const unresolved: string[] = [];
    const value = v.replace(/\$\{([^}]+)\}/g, (_, k: string) => props.get(k) ?? (unresolved.push(k), `\${${k}}`));
    return unresolved.length ? { value, problem: `unresolved property \${${unresolved.join("}, ${")}}` } : { value };
  };
  const deps: Dependency[] = [];
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(raw)?.[1];
  if (parent) {
    const v = resolve(tag(parent, "version"));
    deps.push({ ecosystem: "maven", name: `${tag(parent, "groupId")}:${tag(parent, "artifactId")}`, spec: v.value, resolved: v.value, role: "parent", problem: v.problem });
  }
  const mgmt = /<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/.exec(raw)?.[1] ?? "";
  for (const m of mgmt.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    if (tag(m[1]!, "scope") !== "import") continue;
    const v = resolve(tag(m[1]!, "version"));
    deps.push({ ecosystem: "maven", name: `${resolve(tag(m[1]!, "groupId")).value}:${resolve(tag(m[1]!, "artifactId")).value}`, spec: v.value, resolved: v.value, role: "bom", problem: v.problem });
  }
  const body = raw.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "").replace(/<build>[\s\S]*?<\/build>/g, "").replace(/<parent>[\s\S]*?<\/parent>/, "");
  const block = /<dependencies>([\s\S]*?)<\/dependencies>/.exec(body)?.[1] ?? "";
  for (const m of block.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const v = resolve(tag(m[1]!, "version"));
    deps.push({ ecosystem: "maven", name: `${resolve(tag(m[1]!, "groupId")).value}:${resolve(tag(m[1]!, "artifactId")).value}`, spec: v.value, resolved: v.value, role: "dependency", problem: v.problem });
  }
  return { file, ecosystem: "maven", dependencies: deps };
}

/** Image name without docker.io/ and library/; keeps other registries (ghcr.io/org/img). */
export function normaliseImage(image: string): string {
  return image.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "").replace(/^library\//, "");
}

/** FROM lines of a Dockerfile; build-stage aliases and `scratch` are not images. ARG defaults are substituted. */
export function parseDockerfile(root: string, file: string): Manifest {
  const text = readFileSync(join(root, file), "utf8").replace(/\\\r?\n/g, " ");
  const args = new Map<string, string>();
  const stages = new Set<string>();
  const deps: Dependency[] = [];
  for (const line of text.split(/\r?\n/)) {
    const arg = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)/i.exec(line);
    if (arg) args.set(arg[1]!, arg[2]!.replace(/^["']|["']$/g, ""));
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!from) continue;
    const ref = from[1]!.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, k: string) => args.get(k) ?? `$${k}`);
    const isStage = stages.has(ref.toLowerCase());
    if (from[2]) stages.add(from[2].toLowerCase());
    if (isStage || ref === "scratch") continue;
    const [nameTag, digest] = ref.split("@");
    const colon = nameTag!.lastIndexOf(":");
    const hasTag = colon > nameTag!.lastIndexOf("/");
    const name = normaliseImage(hasTag ? nameTag!.slice(0, colon) : nameTag!);
    const tagValue = hasTag ? nameTag!.slice(colon + 1) : undefined;
    const problem = ref.includes("$") ? `unresolved build argument in \`${from[1]}\`` : !tagValue ? (digest ? "pinned by digest only, without a version tag" : "no tag (means latest)") : !/^v?[0-9]/.test(tagValue) ? `tag \`${tagValue}\` is not a version` : undefined;
    deps.push({ ecosystem: "docker", name, spec: tagValue, resolved: tagValue, role: "base-image", problem });
  }
  return { file, ecosystem: "docker", dependencies: deps };
}

export function readManifests(root: string): Manifest[] {
  return findManifests(root).map((file) => {
    const base = file.split("/").pop()!;
    try {
      if (base === "package.json") return parsePackageJson(root, file);
      if (base === "pom.xml") return parsePom(root, file);
      return parseDockerfile(root, file);
    } catch (err) {
      return { file, ecosystem: base === "package.json" ? "npm" : base === "pom.xml" ? "maven" : "docker", dependencies: [], error: (err as Error).message } as Manifest;
    }
  });
}
