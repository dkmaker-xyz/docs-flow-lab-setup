import type { DocType } from "../engine/index.js";
import type { IdPrefix } from "../github/index.js";

export type Noun = "adr" | "proc" | "tech" | "code" | "release" | "att";

export interface Kind {
  noun: Noun;
  type: DocType;
  /** Folder under docs/ (not for shadow documents). */
  folder?: string;
  prefix?: IdPrefix;
  /** Config key for its categories. */
  categories?: "adr" | "procedure" | "techstack";
  name: string;
  purpose: string;
  /** Embedded writing instruction (spec 3.5). */
  instruction: string[];
}

const SHARED = [
  "Write positively: state what to do and what may be used. Never write down rejected alternatives.",
  "`intent` (max 200 characters): why another agent should read this. `when`: when it is relevant.",
  "Write references as macros; the CLI turns them into links and relations.",
];

export const KINDS: Record<Noun, Kind> = {
  adr: {
    noun: "adr",
    type: "adr",
    folder: "adr",
    prefix: "ADR",
    categories: "adr",
    name: "Architecture decision record (ADR)",
    purpose: "A significant technical decision that is hard to change later: architecture, data, security, integrations, API contracts. Component choices are TECH; ways of working are PROC.",
    instruction: [
      "Body sections, in this order: `## Context`, `## Decision`, `## Consequences`.",
      ...SHARED,
      "A decision that changes entirely is a new ADR with `supersedes`; one that changes in part is a new ADR with `amends`. Corrections are `update`.",
    ],
  },
  proc: {
    noun: "proc",
    type: "procedure",
    folder: "procedure",
    prefix: "PROC",
    categories: "procedure",
    name: "Procedure (PROC)",
    purpose: "An everyday process that is not code-specific.",
    instruction: [
      "Body sections: `## Trigger`, `## Roles`, `## Steps`, `## Done`.",
      "Steps are numbered; each starts with its executor, `(human)` or `(agent)`, and may name a CLI command. At a `(human)` step the agent stops and hands over.",
      ...SHARED,
    ],
  },
  tech: {
    noun: "tech",
    type: "techstack",
    folder: "techstack",
    prefix: "TECH",
    categories: "techstack",
    name: "Tech stack component (TECH)",
    purpose: "One approved technology on the positive list, with the exact packages it covers and their allowed versions. Nothing is used before it is listed.",
    instruction: [
      "Fields: `--ecosystem`, one `--package name@range` per package (range like `19.*` or `19.2.*`; omit `@range` when `--bom-version` covers it), `--rationale` (positive), `--license`, `--review-interval-months`.",
      "Body: component-specific notes only; updates follow the shared update procedure.",
      ...SHARED,
      "A new major outside the range is an `update`; replacing the component is a new TECH with `supersedes`.",
    ],
  },
  release: {
    noun: "release",
    type: "release",
    folder: "release",
    prefix: "REL",
    name: "Release (REL)",
    purpose: "One product version: its documentation branch, the code branch per repository, Jira fix version and dates. The released version is the highest vX.Y.Z tag.",
    instruction: [
      "Created with `release create vX.Y.Z` (phase `planned`); after the merge the bot creates `release/vX.Y.Z` and sets `development`; once deployed, `release tag vX.Y.Z` records `released` in a PR the user merges, and the bot creates the tag.",
      "Code branches are mapped with `release map`; the CLI never touches code repositories.",
      ...SHARED,
    ],
  },
  att: {
    noun: "att",
    type: "attachment",
    folder: "attachment",
    prefix: "ATT",
    name: "Attachment (ATT)",
    purpose: "A binary file (image, PDF, Office document) stored with Git LFS, with a metadata document beside it. Diagrams are mermaid in markdown, not attachments.",
    instruction: [
      "`att create <file>` checks type and size, uploads the binary and writes the metadata; reference it from documents with `{{ATT:NNNN|attachment|<why>}}`.",
      "Attachments are never deleted or replaced: a new version is a new attachment with `--supersedes ATT-NNNN`.",
      ...SHARED,
    ],
  },
  code: {
    noun: "code",
    type: "shadow",
    name: "Shadow document (CODE)",
    purpose: "Documentation of a code file (`code/<org>/<repo>/<path>.md`) or folder (`<dir>/_.md`) in a configured code repository. The path is relative to the git root of the current code repository; `_` names a folder.",
    instruction: [
      "Body: what the file or folder is responsible for and what an agent must know before changing it. Keep it short.",
      ...SHARED,
      "A placeholder (created by a CODE reference) is listed as undocumented; `code create` fills it.",
    ],
  },
};

export const MACRO_HELP = [
  "`{{ADR:0042|<why>}}` (relates-to) or `{{ADR:0042|<type>|<why>}}`; `why` is required.",
  "Prefixes: ADR, PROC, TECH, REL, ATT (number), CODE (`org/repo/path`, trailing `/` for a folder), JIRA (`KEY-123`).",
  "Types: supersedes, amends, depends-on, implements, uses, relates-to, attachment (ATT only).",
];
