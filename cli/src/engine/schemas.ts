import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { packageRoot } from "./package-root.js";
import type { DocType } from "./types.js";

export interface SchemaError {
  /** Field path like `relations[0].why`, empty for the document itself. */
  path: string;
  message: string;
  /** Concrete fix for the agent. */
  fix: string;
  /** True when the error is a missing `why` on a relation. */
  missingWhy: boolean;
}

interface Validators {
  config: ValidateFunction;
  doc: Record<DocType, ValidateFunction>;
}

let validators: Validators | undefined;

function load(): Validators {
  if (validators) return validators;
  const dir = join(packageRoot(), "schemas");
  const read = (p: string) => JSON.parse(readFileSync(join(dir, p), "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, verbose: true });
  for (const f of readdirSync(join(dir, "frontmatter"))) ajv.addSchema(read(join("frontmatter", f)));
  const get = (id: string) => {
    const v = ajv.getSchema(id);
    if (!v) throw new Error("schema not found: " + id);
    return v;
  };
  const types: DocType[] = ["adr", "procedure", "techstack", "release", "attachment", "shadow"];
  validators = {
    config: ajv.compile(read("config.schema.json")),
    doc: Object.fromEntries(types.map((t) => [t, get(`urn:idc365-decisions:frontmatter:${t}`)])) as Record<DocType, ValidateFunction>,
  };
  return validators;
}

function fieldPath(instancePath: string): string {
  return instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), "");
}

function describe(e: ErrorObject): SchemaError | undefined {
  const at = fieldPath(e.instancePath);
  const field = at ? `\`${at}\`` : "the frontmatter";
  const hint = (e.parentSchema as { description?: string } | undefined)?.description;
  const p = e.params as Record<string, unknown>;
  if (e.propertyName !== undefined && e.keyword !== "propertyNames") return undefined; // reported by propertyNames
  switch (e.keyword) {
    case "propertyNames": {
      const name = String(p.propertyName);
      return {
        path: at,
        message: `a placeholder shadow document has only \`placeholder\` and \`relations\`; \`${name}\` is not allowed`,
        fix: `Remove \`${name}\`, or remove \`placeholder: true\` and write the full document.`,
        missingWhy: false,
      };
    }
    case "const":
      return { path: at, message: `${field} must be \`${JSON.stringify(p.allowedValue)}\``, fix: `Set ${field} to \`${JSON.stringify(p.allowedValue)}\`, or remove it.`, missingWhy: false };
    case "if":
      return undefined; // the failing `then` branch reports the concrete error
    case "required": {
      const missing = String(p.missingProperty);
      const path = at ? `${at}.${missing}` : missing;
      return {
        path,
        message: `missing required field \`${path}\``,
        fix: `Add \`${path}\`.`,
        missingWhy: missing === "why" && /^relations\[\d+\]$/.test(at),
      };
    }
    case "unevaluatedProperties":
    case "additionalProperties": {
      const extra = String(p.unevaluatedProperty ?? p.additionalProperty);
      const full = at ? `${at}.${extra}` : extra;
      return { path: at, message: `unknown field \`${full}\``, fix: `Remove \`${full}\`; the schema does not allow it.`, missingWhy: false };
    }
    case "enum":
      return {
        path: at,
        message: `${field} must be one of: ${(p.allowedValues as unknown[]).map(String).join(", ")}`,
        fix: `Set ${field} to one of the allowed values.`,
        missingWhy: false,
      };
    default:
      return { path: at, message: `${field} ${e.message ?? "is invalid"}`, fix: `Correct ${field}${hint ? `: ${hint}` : "."}`, missingWhy: false };
  }
}

function collect(v: ValidateFunction, data: unknown): SchemaError[] {
  if (v(data)) return [];
  const out: SchemaError[] = [];
  const seen = new Set<string>();
  for (const e of v.errors ?? []) {
    const d = describe(e);
    if (!d || seen.has(d.message)) continue;
    seen.add(d.message);
    out.push(d);
  }
  return out;
}

export function validateConfigSchema(data: unknown): SchemaError[] {
  return collect(load().config, data);
}

export function validateFrontmatter(type: DocType, data: unknown): SchemaError[] {
  return collect(load().doc[type], data);
}
