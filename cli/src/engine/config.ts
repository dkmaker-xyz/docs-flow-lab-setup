import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateConfigSchema } from "./schemas.js";
import type { Config, Finding } from "./types.js";
import { isRecord, parseYaml } from "./yaml.js";

export const CONFIG_DIR = "config";

export interface LoadedConfig {
  config?: Config;
  findings: Finding[];
}

/**
 * Reads every config/*.yaml file and merges their top-level keys into one
 * object, which must match config.schema.json. A key may live in one file only.
 */
export function loadConfig(root: string): LoadedConfig {
  const dir = join(root, CONFIG_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return {
      findings: [
        {
          file: CONFIG_DIR,
          rule: "config.missing",
          message: "no config/ folder in the documentation tree",
          nextAction: "Run validate from the documentation repository root, or pass its path.",
        },
      ],
    };
  }
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".yaml"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  return loadConfigFromFiles(files);
}

/** Same as loadConfig, from config/*.yaml contents already in memory (for example read from GitHub). */
export function loadConfigFromFiles(all: { name: string; text: string }[]): LoadedConfig {
  // Only the YAML files are configuration; config/instructions.md is the session text (checked separately).
  const files = all.filter((f) => f.name.endsWith(".yaml"));
  const findings: Finding[] = [];
  if (files.length === 0) {
    return { findings: [{ file: CONFIG_DIR, rule: "config.missing", message: "no config/*.yaml files in the documentation tree", nextAction: "Add the configuration files under config/ via PR." }] };
  }
  const merged: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const { name, text } of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${CONFIG_DIR}/${name}`;
    let data: unknown;
    try {
      data = parseYaml(text);
    } catch (err) {
      findings.push({ file, rule: "config.parse", message: `YAML does not parse: ${(err as Error).message}`, nextAction: "Fix the YAML syntax." });
      continue;
    }
    if (!isRecord(data)) {
      findings.push({ file, rule: "config.parse", message: "file must contain a YAML mapping", nextAction: "Make the file a mapping of configuration keys." });
      continue;
    }
    for (const [key, value] of Object.entries(data)) {
      const first = owner.get(key);
      if (first) {
        findings.push({ file, rule: "config.schema", message: `key \`${key}\` is already set in ${first}`, nextAction: `Keep \`${key}\` in one file only.` });
        continue;
      }
      owner.set(key, file);
      merged[key] = value;
    }
  }
  for (const e of validateConfigSchema(merged)) {
    const key = e.path.split(/[.[]/)[0] ?? "";
    const file = owner.get(key) ?? CONFIG_DIR;
    findings.push({ file, rule: "config.schema", message: e.message, nextAction: e.fix });
  }
  return findings.length ? { findings } : { config: merged as unknown as Config, findings };
}
