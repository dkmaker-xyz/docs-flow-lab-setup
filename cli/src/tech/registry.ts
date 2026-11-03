/**
 * Release dates from the public registries, with the built-in fetch (no
 * dependencies). Undefined when the registry does not say.
 * - npm: the packument's `time[version]` (registry.npmjs.org).
 * - Maven Central: `Last-Modified` of the artifact's .pom (repo1.maven.org).
 * - Docker tags are not checked: official images re-push their tags on every
 *   rebuild, so a tag's push date is not the date of that version.
 */
export type ReleaseDate = (ecosystem: "npm" | "maven" | "docker", name: string, version: string) => Promise<Date | undefined>;

export function registryDates(fetchImpl: typeof fetch = fetch, timeoutMs = 15000): ReleaseDate {
  const npmCache = new Map<string, Promise<Record<string, string> | undefined>>();
  const get = (url: string, init: RequestInit = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return async (ecosystem, name, version) => {
    if (ecosystem === "npm") {
      if (!npmCache.has(name)) {
        npmCache.set(
          name,
          get(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, { headers: { Accept: "application/json" } })
            .then(async (r) => (r.ok ? ((await r.json()) as { time?: Record<string, string> }).time : undefined))
            .catch(() => undefined),
        );
      }
      const t = (await npmCache.get(name))?.[version];
      return t ? new Date(t) : undefined;
    }
    if (ecosystem === "maven") {
      const [group, artifact] = name.split(":");
      if (!group || !artifact) return undefined;
      try {
        const r = await get(`https://repo1.maven.org/maven2/${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}.pom`, { method: "HEAD" });
        const lm = r.ok ? r.headers.get("last-modified") : null;
        return lm ? new Date(lm) : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
}
