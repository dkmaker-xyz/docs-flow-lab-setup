/**
 * Version ranges as half-open intervals [min, max) over major.minor.patch.
 * Prerelease and build suffixes are ignored for range checks (a
 * `7.1.0-dev.1` counts as 7.1.0); the exact string is kept for release dates.
 */

export type Triple = [number, number, number];

export interface Interval {
  min: Triple;
  /** Exclusive upper bound; equal to min plus one patch for an exact version. */
  max: Triple;
}

const cmp = (a: Triple, b: Triple) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const next = (t: Triple): Triple => [t[0], t[1], t[2] + 1];

/** Leading numeric version of a string: `24.11.0-alpine` → [24, 11, 0], `19.2` → [19, 2] (missing parts undefined). */
export function numericPrefix(text: string): number[] | undefined {
  const m = /^v?([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?/.exec(text.trim());
  if (!m) return undefined;
  return [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);
}

/**
 * A TECH range (spec 5.3): `19`, `19.*`, `19.2`, `19.2.*` or an exact
 * `19.2.1`. Undefined when the text is not one of those.
 */
export function techRange(text: string): Interval | undefined {
  const t = text.trim();
  if (!/^[0-9]+(\.([0-9]+|\*))?(\.([0-9]+|\*))?$/.test(t)) return undefined;
  const parts = t.split(".");
  const nums = parts.filter((p) => p !== "*").map(Number);
  if (nums.length === 3) {
    const v = nums as Triple;
    return { min: v, max: next(v) };
  }
  if (nums.length === 2) return { min: [nums[0]!, nums[1]!, 0], max: [nums[0]!, nums[1]! + 1, 0] };
  return { min: [nums[0]!, 0, 0], max: [nums[0]! + 1, 0, 0] };
}

/**
 * The versions an npm dependency spec allows, for the common forms: exact
 * `1.2.3`, `^1.2.3`, `~1.2.3`, `1.2.x`/`1.x`/`1.2.*`, `=1.2.3`, `v1.2.3`.
 * Undefined for anything else (ranges with `||`, `>=`, `*`, tags, URLs).
 */
export function npmSpec(spec: string): Interval | undefined {
  let s = spec.trim();
  const op = /^(\^|~|=)?\s*/.exec(s)![1];
  s = s.replace(/^(\^|~|=)\s*/, "").replace(/^v/, "");
  const m = /^([0-9]+)(?:\.([0-9]+|x|\*))?(?:\.([0-9]+|x|\*))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return undefined;
  const wild = (p?: string) => p === undefined || p === "x" || p === "*";
  const major = Number(m[1]);
  if (wild(m[2])) return { min: [major, 0, 0], max: [major + 1, 0, 0] };
  const minor = Number(m[2]);
  if (wild(m[3])) return op === "^" && major > 0 ? { min: [major, minor, 0], max: [major + 1, 0, 0] } : { min: [major, minor, 0], max: [major, minor + 1, 0] };
  const patch = Number(m[3]);
  const v: Triple = [major, minor, patch];
  if (op === "^") {
    if (major > 0) return { min: v, max: [major + 1, 0, 0] };
    if (minor > 0) return { min: v, max: [0, minor + 1, 0] };
    return { min: v, max: next(v) };
  }
  if (op === "~") return { min: v, max: [major, minor + 1, 0] };
  return { min: v, max: next(v) };
}

/** An exact version (Maven, Docker tag): its numeric prefix as a point; missing parts count as 0. */
export function exactVersion(text: string): Interval | undefined {
  const n = numericPrefix(text);
  if (!n) return undefined;
  const v: Triple = [n[0]!, n[1] ?? 0, n[2] ?? 0];
  // A Docker tag like `24` or `24.11` stands for that line; it must fit the range as a whole.
  if (n.length === 1) return { min: [n[0]!, 0, 0], max: [n[0]! + 1, 0, 0] };
  if (n.length === 2) return { min: [n[0]!, n[1]!, 0], max: [n[0]!, n[1]! + 1, 0] };
  return { min: v, max: next(v) };
}

/** True when every version in `inner` is in `outer`. */
export function within(inner: Interval, outer: Interval): boolean {
  return cmp(inner.min, outer.min) >= 0 && cmp(inner.max, outer.max) <= 0;
}

export function formatTriple(t: Triple): string {
  return t.join(".");
}
