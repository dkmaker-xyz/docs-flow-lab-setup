/** Minimal markdown helpers: frontmatter split and link scanning. No markdown parser. */

export interface Split {
  frontmatter: string;
  body: string;
}

/** Splits `---\n<yaml>\n---\n<body>`. Returns undefined when there is no frontmatter block. */
export function splitFrontmatter(text: string): Split | undefined {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return undefined;
  const end = src.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const after = src.slice(end + 4);
  if (after !== "" && !after.startsWith("\n")) return undefined;
  return { frontmatter: src.slice(4, end + 1), body: after.replace(/^\n/, "") };
}

export interface LinkScan {
  /** Labels used as `[text][label]` or `[label][]`, lowercased, with the label as written. */
  references: { label: string; key: string }[];
  /** Reference definitions `[label]: url`. */
  definitions: { label: string; key: string; url: string }[];
  /** Inline link and image destinations `[text](url)`. */
  inline: string[];
}

/** Blanks fenced code blocks and inline code so links inside them are ignored. */
export function stripCode(body: string): string {
  const lines = body.split("\n");
  let fence: string | undefined;
  const out = lines.map((line) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]!.startsWith(fence)) fence = undefined;
      return "";
    }
    if (m) {
      fence = m[1]!;
      return "";
    }
    return line.replace(/(`+)[^`]*?\1/g, "");
  });
  return out.join("\n");
}

const normalize = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

export function scanLinks(body: string): LinkScan {
  const text = stripCode(body);
  const definitions: LinkScan["definitions"] = [];
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const d = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+.*)?$/.exec(line);
    if (d) definitions.push({ label: d[1]!, key: normalize(d[1]!), url: d[2]! });
    else lines.push(line);
  }
  const rest = lines.join("\n");
  const references: LinkScan["references"] = [];
  for (const m of rest.matchAll(/\[((?:[^\[\]]|\[[^\]]*\])*)\]\[([^\]]*)\]/g)) {
    const label = m[2] === "" ? m[1]! : m[2]!;
    references.push({ label, key: normalize(label) });
  }
  const inline: string[] = [];
  for (const m of rest.matchAll(/\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)) inline.push(m[1]!);
  return { references, definitions, inline };
}

export function isExternalUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url);
}

/** Macros like `{{ADR:0042}}` left in the body outside code. */
export function findMacros(body: string): string[] {
  return [...stripCode(body).matchAll(/\{\{[A-Za-z]+:[^{}]*\}\}/g)].map((m) => m[0]);
}
