/**
 * Claude Code project settings (`<project>/.claude/settings.json`) for the
 * plugin: the marketplace in `extraKnownMarketplaces` and the plugin in
 * `enabledPlugins`, so Claude Code offers and loads the plugin once the
 * folder is trusted. Pure functions over the parsed settings; `setup` does
 * the I/O. The SessionStart hook itself ships in the plugin (`hooks/hooks.json`);
 * the per-project hook entry of phase 9 is removed when found.
 */
/** Marketplace name (in marketplace.json) and plugin entry name. */
export const MARKETPLACE = "idc365-decisions";
export const PLUGIN = "idc365-decisions";
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
/** The branch of the documentation repository the workflow builds the marketplace on. */
export const PLUGIN_REF = "meta/plugin";
/** The phase 9 project hook (exec form), now replaced by the plugin's own hook. */
export const OLD_HOOK_COMMAND = "idc365-decisions";
export const OLD_HOOK_ARGS = ["hook", "session-start"];
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** True for the phase 9 handler: exec form with its command and args, or the same as one shell string. */
export function isOurHandler(h) {
    if (!isObject(h) || h.type !== "command")
        return false;
    if (h.command === OLD_HOOK_COMMAND && Array.isArray(h.args) && h.args.length === OLD_HOOK_ARGS.length && h.args.every((a, i) => a === OLD_HOOK_ARGS[i]))
        return true;
    return h.args === undefined && typeof h.command === "string" && h.command.trim().split(/\s+/).join(" ") === [OLD_HOOK_COMMAND, ...OLD_HOOK_ARGS].join(" ");
}
function groups(settings) {
    if (settings.hooks === undefined)
        return [];
    if (!isObject(settings.hooks))
        return { error: "`hooks` is not an object" };
    const ss = settings.hooks.SessionStart;
    if (ss === undefined)
        return [];
    if (!Array.isArray(ss))
        return { error: "`hooks.SessionStart` is not an array" };
    return ss;
}
/** Removes only the phase 9 hook; drops groups, `SessionStart` and `hooks` that become empty because of it. */
export function removeHook(settings) {
    const list = groups(settings);
    if ("error" in list)
        return list;
    if (!list.some((g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(isOurHandler)))
        return { settings, changed: false };
    const out = [];
    for (const g of list) {
        if (!isObject(g) || !Array.isArray(g.hooks) || !g.hooks.some(isOurHandler))
            out.push(g);
        else {
            const others = g.hooks.filter((h) => !isOurHandler(h));
            if (others.length)
                out.push({ ...g, hooks: others });
        }
    }
    const { SessionStart: _s, ...otherEvents } = settings.hooks;
    const hooks = out.length ? { ...otherEvents, SessionStart: out } : otherEvents;
    const { hooks: _h, ...rest } = settings;
    return { settings: Object.keys(hooks).length ? { ...rest, hooks } : rest, changed: true };
}
/** The marketplace source for a documentation repository (org/repo). */
export function marketplaceSource(repository) {
    return { source: "github", repo: repository, ref: PLUGIN_REF };
}
/**
 * Adds (or corrects) the marketplace entry and enables the plugin; keeps
 * every other key, marketplace and plugin. An explicit
 * `"idc365-decisions@idc365-decisions": false` (the user switched it off) is
 * kept. Also removes the phase 9 project hook, which the plugin replaces.
 */
export function mergeProjectSettings(settings, repository) {
    if (settings.extraKnownMarketplaces !== undefined && !isObject(settings.extraKnownMarketplaces))
        return { error: "`extraKnownMarketplaces` is not an object" };
    if (settings.enabledPlugins !== undefined && !isObject(settings.enabledPlugins))
        return { error: "`enabledPlugins` is not an object" };
    const without = removeHook(settings);
    if ("error" in without)
        return without;
    const base = without.settings;
    const markets = (base.extraKnownMarketplaces ?? {});
    const current = isObject(markets[MARKETPLACE]) ? markets[MARKETPLACE] : {};
    const entry = { ...current, source: marketplaceSource(repository), autoUpdate: current.autoUpdate ?? true };
    const plugins = (base.enabledPlugins ?? {});
    const next = {
        ...base,
        extraKnownMarketplaces: { ...markets, [MARKETPLACE]: entry },
        enabledPlugins: { ...plugins, [PLUGIN_ID]: plugins[PLUGIN_ID] === false ? false : true },
    };
    return { settings: next, changed: JSON.stringify(next) !== JSON.stringify(settings), removedOldHook: without.changed };
}
