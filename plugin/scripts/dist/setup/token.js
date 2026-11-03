import { TOKEN_ENV } from "./setup.js";
/** Days until the documentation token expires (the organisation may enforce a shorter lifetime). */
export const TOKEN_EXPIRY_DAYS = 90;
/**
 * GitHub's pre-filled form for a fine-grained token: owner, name, expiry and
 * the two permissions. The repository selection cannot be pre-filled.
 */
export function tokenUrl(repository) {
    const owner = repository.split("/")[0];
    const q = new URLSearchParams({
        name: "idc365-decisions",
        description: `idc365-decisions CLI: read and write ${repository}`,
        target_name: owner,
        expires_in: String(TOKEN_EXPIRY_DAYS),
        contents: "write",
        pull_requests: "write",
    });
    return `https://github.com/settings/personal-access-tokens/new?${q.toString()}`;
}
/** Step-by-step instructions for the user (Windows and Linux/macOS), as markdown lines. */
export function tokenSteps(repository) {
    const repo = repository ?? "<org>/<documentation-repo>";
    const owner = repo.split("/")[0];
    return [
        `1. Open ${repository ? tokenUrl(repository) : "https://github.com/settings/personal-access-tokens/new"} (signed in to GitHub).`,
        `2. **Resource owner:** select \`${owner}\` again in the dropdown, even if it already shows it (a known GitHub issue: otherwise the token is created for the personal account). Then check that **Contents** and **Pull requests** are still *Read and write*; add them again if the switch cleared them.`,
        `3. **Repository access:** *Only select repositories* → \`${repo}\` only.`,
        `4. **Expiration:** ${TOKEN_EXPIRY_DAYS} days (or what the organisation allows). Generate the token; if the organisation requires approval, wait for an owner to approve it.`,
        `5. Store it as \`${TOKEN_ENV}\` yourself; never paste it into the chat:`,
        `   - **Windows** (PowerShell): \`[Environment]::SetEnvironmentVariable("${TOKEN_ENV}", "<token>", "User")\`, or System Properties → Environment Variables → User variables.`,
        `   - **Linux / macOS:** add \`export ${TOKEN_ENV}=<token>\` to \`~/.bashrc\` (or \`~/.zshrc\`, \`~/.profile\`).`,
        "6. Close the terminal and Claude Code, open them again (they read the variable at start), and run `idc365-decisions setup`.",
    ];
}
