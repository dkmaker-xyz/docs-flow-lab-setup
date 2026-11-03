import { posix } from "node:path";
import { INVERSE_OF, scanLinks, type Relation } from "../engine/index.js";

export const FORWARD_TYPES = ["supersedes", "amends", "depends-on", "implements", "uses", "relates-to", "attachment"] as const;
const ID_PREFIXES = ["ADR", "PROC", "TECH", "REL", "ATT"];
const PREFIX_FOLDER: Record<string, string> = { ADR: "adr", PROC: "procedure", TECH: "techstack", REL: "release", ATT: "attachment" };

export const ID_KEY_RE = /^(ADR|PROC|TECH|REL|ATT)-([0-9]{4,})$/;
export const CODE_KEY_RE = /^CODE:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)((?:\/[^\s/]+)*)$/;
export const JIRA_KEY_RE = /^JIRA:([A-Z][A-Z0-9_]*-[0-9]+)$/;

export interface Macro {
  raw: string;
  /** Target key: ADR-0042, CODE:org/repo/path, JIRA:KEY-1. */
  key: string;
  type: string;
  why: string;
  /** CODE target written with a trailing slash: a folder. */
  folder: boolean;
}

export interface MacroError {
  raw: string;
  message: string;
  nextAction: string;
}

const MACRO_RE = /\{\{([A-Za-z]+):([^{}]*)\}\}/g;

/** Parses the inside of `{{PREFIX:…}}`. */
export function parseMacro(raw: string, prefix: string, inner: string): Macro | MacroError {
  const parts = inner.split("|");
  const target = parts[0]!.trim();
  const P = prefix.toUpperCase();
  const fail = (message: string, nextAction: string): MacroError => ({ raw, message, nextAction });
  const syntax = "Write `{{PREFIX:target|why}}` or `{{PREFIX:target|type|why}}`.";

  let key: string;
  let folder = false;
  if (ID_PREFIXES.includes(P)) {
    if (!/^[0-9]{1,}$/.test(target)) return fail(`\`${raw}\`: ${P} target must be a number like 0042`, syntax);
    key = `${P}-${target.padStart(4, "0")}`;
  } else if (P === "CODE") {
    folder = target.endsWith("/");
    key = `CODE:${target.replace(/\/+$/, "")}`;
    if (!CODE_KEY_RE.test(key)) return fail(`\`${raw}\`: CODE target must be org/repo/path`, "Write the path as `{{CODE:org/repo/path/in/repo|why}}`.");
  } else if (P === "JIRA") {
    key = `JIRA:${target}`;
    if (!JIRA_KEY_RE.test(key)) return fail(`\`${raw}\`: JIRA target must be a key like IDC-123`, syntax);
  } else {
    return fail(`\`${raw}\`: unknown prefix \`${prefix}\``, "Use one of ADR, PROC, TECH, REL, ATT, CODE, JIRA.");
  }

  let type = "relates-to";
  let why: string;
  if (parts.length === 1) return fail(`\`${raw}\` has no \`why\``, "Add why the reference exists: `{{" + `${P}:${target}` + "|<why>}}`.");
  const second = parts[1]!.trim();
  if (parts.length === 2) {
    if ((FORWARD_TYPES as readonly string[]).includes(second) || second in INVERSE_OF) {
      return fail(`\`${raw}\` has a type but no \`why\``, `Write \`{{${P}:${target}|${second}|<why>}}\`.`);
    }
    why = second;
  } else {
    type = second || "relates-to";
    why = parts.slice(2).join("|").trim();
  }
  if (type in INVERSE_OF) return fail(`\`${raw}\`: \`${type}\` is an inverse relation; only the bot writes those`, `Write the forward relation in the other document, or use ${FORWARD_TYPES.join(", ")}.`);
  if (!(FORWARD_TYPES as readonly string[]).includes(type)) return fail(`\`${raw}\`: unknown relation type \`${type}\``, `Use one of ${FORWARD_TYPES.join(", ")}.`);
  if (!why) return fail(`\`${raw}\` has no \`why\``, "Add why the reference exists after the last `|`.");
  if (type === "attachment" && !key.startsWith("ATT-")) return fail(`\`${raw}\`: type \`attachment\` needs an ATT target`, "Use another relation type, or reference the attachment.");
  return { raw, key, type, why, folder };
}

/** Applies `fn` to every stretch of text outside fenced code blocks and inline code. */
export function mapOutsideCode(body: string, fn: (text: string) => string): string {
  let fence: string | undefined;
  return body
    .split("\n")
    .map((line) => {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (m && m[1]!.startsWith(fence)) fence = undefined;
        return line;
      }
      if (m) {
        fence = m[1]!;
        return line;
      }
      return line.split(/(`+[^`]*?`+)/).map((part, i) => (i % 2 === 1 ? part : fn(part))).join("");
    })
    .join("\n");
}

/** Replaces every macro outside code with `[KEY][KEY]` and returns them. */
export function expandMacros(body: string): { body: string; macros: Macro[]; errors: MacroError[] } {
  const macros: Macro[] = [];
  const errors: MacroError[] = [];
  const out = mapOutsideCode(body, (text) =>
    text.replace(MACRO_RE, (raw, prefix: string, inner: string) => {
      const m = parseMacro(raw, prefix, inner);
      if ("message" in m) {
        errors.push(m);
        return raw;
      }
      macros.push(m);
      return `[${m.key}][${m.key}]`;
    }),
  );
  return { body: out, macros, errors };
}

export function isTargetKey(label: string): boolean {
  return ID_KEY_RE.test(label) || CODE_KEY_RE.test(label) || JIRA_KEY_RE.test(label);
}

/** Internal and Jira reference labels used in the body, in order of first use. */
export function referencedKeys(body: string): string[] {
  const seen = new Set<string>();
  for (const r of scanLinks(body).references) if (isTargetKey(r.label.trim())) seen.add(r.label.trim());
  return [...seen];
}

/** Removes definition lines for internal and Jira labels (the CLI regenerates them). */
export function stripTargetDefinitions(body: string): string {
  const lines = body.split("\n").filter((line) => {
    const d = /^ {0,3}\[([^\]]+)\]:\s*\S+/.exec(line);
    return !(d && isTargetKey(d[1]!.trim()));
  });
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

export function folderForPrefix(prefix: string): string | undefined {
  return PREFIX_FOLDER[prefix];
}

export function relativeLink(fromFile: string, toFile: string): string {
  const rel = posix.relative(posix.dirname(fromFile), toFile);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Merges relations: existing first, then new ones whose (type, target) is not present yet. */
export function mergeRelations(existing: Relation[], added: Relation[]): Relation[] {
  const out = [...existing];
  for (const r of added) if (!out.some((e) => e.type === r.type && e.target === r.target)) out.push(r);
  return out;
}
