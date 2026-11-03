/** The branch index written to meta/index (spec 6.2). */
export const INDEX_BRANCH = "meta/index";
export const INDEX_SCHEMA = 1;
/** `main` → main.json, `release/v2.0.0` → release__v2.0.0.json. */
export function indexFileName(branch) {
    return `${branch.replace(/\//g, "__")}.json`;
}
