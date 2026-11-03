/** The branch index written to meta/index (spec 6.2). */

export const INDEX_BRANCH = "meta/index";
export const INDEX_SCHEMA = 1;

export interface IndexRelation {
  type: string;
  /** Target for outgoing relations, source for incoming ones. */
  target?: string;
  source?: string;
  why: string;
}

export interface IndexDocument {
  /** ID, or CODE:org/repo/path for shadow documents. */
  id: string;
  type: string;
  path: string;
  /** From the file name; null for shadow documents. */
  slug: string | null;
  title: string | null;
  description: string | null;
  intent: string | null;
  when: string | null;
  state: string | null;
  category: string | null;
  featured: boolean;
  placeholder: boolean;
  /** Changed on this work branch compared with its base. */
  pending: boolean;
  /** Outgoing: forward relations written in this document. Incoming: forward relations of other documents to it. */
  relations: { outgoing: IndexRelation[]; incoming: IndexRelation[] };
  /** Truth branches (main, release/vX.Y.Z) and v* tags the document exists on, by path. */
  releases: string[];
  commit: { sha: string; date: string } | null;
  /** Login of the person who merged the PR of the latest commit, when there is one. */
  mergedBy: string | null;
}

export interface BranchIndex {
  schema: number;
  branch: string;
  sourceSha: string;
  generatedAt: string;
  /** Base branch for pending; null for truth branches and branches that are not work branches. */
  base: string | null;
  documents: IndexDocument[];
  /** Files that could not be indexed, with the reason. */
  skipped: { path: string; reason: string }[];
}

/** `main` → main.json, `release/v2.0.0` → release__v2.0.0.json. */
export function indexFileName(branch: string): string {
  return `${branch.replace(/\//g, "__")}.json`;
}
