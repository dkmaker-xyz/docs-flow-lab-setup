import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { validateTree, type Finding, type ValidationResult } from "../engine/index.js";

export const VALIDATE_HELP = [
  "# idc365-decisions validate [path]",
  "",
  "Validates a documentation tree on disk: configuration, frontmatter schemas,",
  "paths and IDs, shadow documents, relations, links, attachments and the priming budget.",
  "",
  "- `path`: documentation repository root (default: current directory).",
  "- `--json`: machine-readable findings.",
  "- Exit code: 0 clean, 1 findings, 2 path not usable.",
  "",
  "## Next action",
  "",
  "Run `idc365-decisions validate` in the documentation repository root.",
  "",
].join("\n");

export function renderMarkdown(result: ValidationResult, shownPath: string): string {
  const { findings } = result;
  const notes = result.notes.length ? ["", "Notes (not failures):", ...result.notes.map((n) => `- \`${n.file}\`: ${n.message}`)] : [];
  const rerun = `idc365-decisions validate${shownPath === "." ? "" : ` ${shownPath}`}`;
  if (findings.length === 0) {
    return [
      "# Validation passed",
      "",
      `Checked ${result.documents} documents in \`${shownPath}\`: no findings.`,
      ...notes,
      "",
      "## Next action",
      "",
      "None. The documentation tree is valid.",
      "",
    ].join("\n");
  }
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const lines = [
    `# Validation failed: ${findings.length} finding${findings.length === 1 ? "" : "s"} in ${byFile.size} file${byFile.size === 1 ? "" : "s"}`,
    "",
    `Checked ${result.documents} documents in \`${shownPath}\`.`,
    "",
  ];
  for (const [file, list] of byFile) {
    lines.push(`## ${file}`, "");
    for (const f of list) lines.push(`- \`${f.rule}\`: ${f.message}`, `  Fix: ${f.nextAction}`);
    lines.push("");
  }
  if (notes.length) lines.push(...notes.slice(1), "");
  lines.push("## Next action", "", `Fix every finding above, then run \`${rerun}\` again.`, "");
  return lines.join("\n");
}

export function renderJson(result: ValidationResult): string {
  return JSON.stringify({ ok: result.findings.length === 0, root: result.root, documents: result.documents, findings: result.findings, notes: result.notes }, null, 2) + "\n";
}

/** Runs the command; returns the exit code. */
export function runValidate(path: string | undefined, opts: { json?: boolean }): number {
  const shown = path ?? ".";
  const abs = resolve(shown);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    const message = `\`${shown}\` is not a directory`;
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    else process.stdout.write(["# Error", "", message, "", "## Next action", "", "Pass the documentation repository root, or run the command from it.", ""].join("\n"));
    return 2;
  }
  const result = validateTree(abs);
  process.stdout.write(opts.json ? renderJson(result) : renderMarkdown(result, shown));
  return result.findings.length === 0 ? 0 : 1;
}
