import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { packageRoot } from "./package-root.js";
let validators;
function load() {
    if (validators)
        return validators;
    const dir = join(packageRoot(), "schemas");
    const read = (p) => JSON.parse(readFileSync(join(dir, p), "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, verbose: true });
    for (const f of readdirSync(join(dir, "frontmatter")))
        ajv.addSchema(read(join("frontmatter", f)));
    const get = (id) => {
        const v = ajv.getSchema(id);
        if (!v)
            throw new Error("schema not found: " + id);
        return v;
    };
    const types = ["adr", "procedure", "techstack", "release", "attachment", "shadow"];
    validators = {
        config: ajv.compile(read("config.schema.json")),
        doc: Object.fromEntries(types.map((t) => [t, get(`urn:idc365-decisions:frontmatter:${t}`)])),
    };
    return validators;
}
function fieldPath(instancePath) {
    return instancePath
        .split("/")
        .slice(1)
        .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), "");
}
function describe(e) {
    const at = fieldPath(e.instancePath);
    const field = at ? `\`${at}\`` : "the frontmatter";
    const hint = e.parentSchema?.description;
    const p = e.params;
    if (e.propertyName !== undefined && e.keyword !== "propertyNames")
        return undefined; // reported by propertyNames
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
                message: `${field} must be one of: ${p.allowedValues.map(String).join(", ")}`,
                fix: `Set ${field} to one of the allowed values.`,
                missingWhy: false,
            };
        default:
            return { path: at, message: `${field} ${e.message ?? "is invalid"}`, fix: `Correct ${field}${hint ? `: ${hint}` : "."}`, missingWhy: false };
    }
}
function collect(v, data) {
    if (v(data))
        return [];
    const out = [];
    const seen = new Set();
    for (const e of v.errors ?? []) {
        const d = describe(e);
        if (!d || seen.has(d.message))
            continue;
        seen.add(d.message);
        out.push(d);
    }
    return out;
}
export function validateConfigSchema(data) {
    return collect(load().config, data);
}
export function validateFrontmatter(type, data) {
    return collect(load().doc[type], data);
}
