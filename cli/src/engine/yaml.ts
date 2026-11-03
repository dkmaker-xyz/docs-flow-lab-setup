import { parse } from "yaml";

/** Parse YAML 1.2 (core schema: dates stay strings). Throws Error with a readable message. */
export function parseYaml(text: string): unknown {
  try {
    return parse(text, { schema: "core", uniqueKeys: true, prettyErrors: true });
  } catch (err) {
    // RangeError (deep nesting) is not a YAMLParseError; report both the same way.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.split("\n")[0] ?? msg);
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
