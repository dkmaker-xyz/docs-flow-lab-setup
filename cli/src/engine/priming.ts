/**
 * The SessionStart priming (spec 9.3, phase 13). The instruction text lives
 * in the documentation repository as `config/instructions.md` and is
 * reviewed by PR; the hook only fills in its placeholders. Shared by the hook
 * that writes the priming and the validator that keeps it within the budget.
 */

export const INSTRUCTIONS_FILE = "config/instructions.md";
export const PLACEHOLDERS = ["{{release}}", "{{commands}}", "{{featured}}"] as const;

/** What the hook says when no instruction text can be loaded and none is cached. */
export const FALLBACK_INSTRUCTIONS =
  "Run `idc365-decisions` for the guide to this project's official documentation (decisions, procedures, tech stack, releases). The session instructions (config/instructions.md in the documentation repository) could not be loaded: tell the user.\n\n{{release}}\n{{commands}}\n{{featured}}\n";

export const PRIMING_COMMANDS = [
  "- `idc365-decisions adr|proc|tech|code|att|release`: guide, then `list`, `show <ID>`, `create`, `update` (`--ref <branch>` to read a release).",
  "- `idc365-decisions tech check`: before adding or upgrading a dependency.",
  "- `idc365-decisions release current`: which release this code branch belongs to.",
  "- `idc365-decisions view`: the documentation as a website for the user.",
  "- Write references as macros, for example `{{ADR:0042|<why>}}`; every write opens a PR that the user reviews and merges.",
];

export interface PrimingVars {
  /** Documentation repository, org/repo. */
  docs: string;
  /** Lines about the release and documentation branch of this code branch. */
  release: string[];
  /** Warnings (stale cache, missing token, update available). */
  warnings: string[];
}

/** `{{release}}`: the "This code branch" section. */
export function releaseSection(v: PrimingVars): string {
  return ["## This code branch", "", `- Documentation repository: \`${v.docs}\``, ...v.release, ""].join("\n");
}

/** `{{commands}}`: the "Most important commands" section. */
export function commandsSection(): string {
  return ["## Most important commands", "", ...PRIMING_COMMANDS, ""].join("\n");
}

/** One featured document in the priming. */
export function primingFeatured(id: string, title: string, body: string): string {
  return `## Featured: ${id} ${title}\n\n${body.trim()}\n`;
}

/** Placeholders that do not appear exactly once. */
export function placeholderProblems(template: string): string[] {
  return PLACEHOLDERS.flatMap((p) => {
    const n = template.split(p).length - 1;
    return n === 1 ? [] : [`${p} appears ${n === 0 ? "nowhere" : `${n} times`}; it must appear exactly once`];
  });
}

/**
 * The priming: warnings first, then the instruction text with its
 * placeholders filled in. Replacement uses split/join, so `$` in the text is
 * kept as written.
 */
export function composeInstructions(template: string, v: PrimingVars, featured: string): string {
  const fill = (text: string, p: string, value: string) => text.split(p).join(value);
  let text = fill(template, "{{release}}", releaseSection(v));
  text = fill(text, "{{commands}}", commandsSection());
  text = fill(text, "{{featured}}", featured);
  const warn = v.warnings.length ? `${v.warnings.map((w) => `> ${w}`).join("\n\n")}\n\n` : "";
  return `${warn}${text.trimEnd()}\n`;
}

/** Realistic release lines and one warning, which the validator counts against the budget. */
export const SAMPLE_VARS: PrimingVars = {
  docs: "org/documentation-repository",
  release: [
    "- Code: `org/code-repository` branch `feature/some-branch-name`",
    "- Release: v10.20.30 (REL-0000, phase development), inherited from the mapped branch `release/10.20` (git merge-base)",
    "- Documentation branch: `release/v10.20.30`: read with `--ref release/v10.20.30`",
    "- Work with version v10.20.30; run `idc365-decisions release current` if the branch changes.",
  ],
  warnings: ["Primed from the cache of 2026-01-01 00:00 UTC because the documentation repository could not be read: the reason here. The content may be out of date; tell the user what is missing before relying on it."],
};

/** Characters as Unicode code points. */
export function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}
