import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
let cached;
/** Directory of the CLI package (the nearest folder with package.json above this module). */
export function packageRoot() {
    if (cached)
        return cached;
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(dir, "package.json"))) {
        const parent = dirname(dir);
        if (parent === dir)
            throw new Error("package.json not found above " + import.meta.url);
        dir = parent;
    }
    cached = dir;
    return dir;
}
