/** Rule identifiers. Stable: CI and agents may match on them. */
export type RuleId =
  | "config.missing"
  | "config.parse"
  | "config.schema"
  | "frontmatter.parse"
  | "frontmatter.schema"
  | "category.unknown"
  | "path.layout"
  | "path.slug"
  | "path.id-mismatch"
  | "id.duplicate"
  | "shadow.path"
  | "shadow.repo"
  | "relation.target"
  | "relation.why"
  | "relation.inverse"
  | "release.repo"
  | "macro.unexpanded"
  | "link.undefined"
  | "link.inline"
  | "link.relation"
  | "link.path"
  | "attachment.pair"
  | "attachment.type"
  | "attachment.size"
  | "attachment.metadata"
  | "priming.budget"
  | "instructions.missing"
  | "instructions.placeholder";

export interface Finding {
  /** Path relative to the tree root, with forward slashes. */
  file: string;
  rule: RuleId;
  message: string;
  /** What the agent should do to fix it. */
  nextAction: string;
}

export interface ValidationResult {
  /** Absolute path of the validated tree. */
  root: string;
  /** Number of documents (.md files under docs/ and code/) checked. */
  documents: number;
  findings: Finding[];
  /** Not failures: attachments nothing links to, documents still linking to a superseded attachment. */
  notes: { file: string; message: string }[];
}

export type DocType = "adr" | "procedure" | "techstack" | "release" | "attachment" | "shadow";

export interface CategoryEntry {
  description: string;
  when: string;
}

export interface Config {
  categories: Record<"adr" | "procedure" | "techstack", Record<string, CategoryEntry>>;
  attachment_types: Record<string, string>;
  attachment_max_bytes: number;
  repositories: string[];
  jira_base_url: string | null;
  priming_budget: number;
  cooldown_days: number;
}

export interface Relation {
  type: string;
  target: string;
  why: string;
  link: string;
}
