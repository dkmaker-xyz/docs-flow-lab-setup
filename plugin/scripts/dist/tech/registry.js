export function registryDates(fetchImpl = fetch, timeoutMs = 15000) {
    const npmCache = new Map();
    const get = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return async (ecosystem, name, version) => {
        if (ecosystem === "npm") {
            if (!npmCache.has(name)) {
                npmCache.set(name, get(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, { headers: { Accept: "application/json" } })
                    .then(async (r) => (r.ok ? (await r.json()).time : undefined))
                    .catch(() => undefined));
            }
            const t = (await npmCache.get(name))?.[version];
            return t ? new Date(t) : undefined;
        }
        if (ecosystem === "maven") {
            const [group, artifact] = name.split(":");
            if (!group || !artifact)
                return undefined;
            try {
                const r = await get(`https://repo1.maven.org/maven2/${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}.pom`, { method: "HEAD" });
                const lm = r.ok ? r.headers.get("last-modified") : null;
                return lm ? new Date(lm) : undefined;
            }
            catch {
                return undefined;
            }
        }
        return undefined;
    };
}
