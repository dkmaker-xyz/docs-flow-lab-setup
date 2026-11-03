# idc365-decisions CLI

The `idc365-decisions` CLI is the interface to the idc365-decisions
documentation repository. It is built for AI agents: every call prints
markdown that tells the agent what to do next. Running it with no arguments
explains how to use it.

It ships as a **Claude Code plugin**, together with the SessionStart hook that
primes every session and a skill with the setup instructions. The plugin's
marketplace is the `meta/plugin` branch of the documentation repository; the
workflow `.github/workflows/plugin-build.yml` builds it from `main`. There is
no npm package to install, no `read:packages` token and no `.npmrc`.

Windows and Linux (and macOS) are supported equally.

## Requirements

- **Node.js 22.12 or later** on `PATH` (`node --version`). Windows: the LTS
  installer from nodejs.org; Linux: the distribution package or nvm.
- **Git**, with read access to `idconnectdk/idc365-decisions` stored for
  non-interactive use (Claude Code clones the marketplace with prompts off):
  - **Windows:** Git for Windows. It ships Git Credential Manager; run
    `git ls-remote https://github.com/idconnectdk/idc365-decisions.git` once in
    a terminal and sign in when the browser opens. Git for Windows also gives
    Claude Code its Bash tool; without it Claude uses PowerShell, which the
    plugin supports too.
  - **Linux / macOS (or Windows):** `gh auth login`, then `gh auth setup-git`;
    or an SSH key loaded in `ssh-agent`.
- **Claude Code** 2.1.139 or later.

## Install the plugin

In Claude Code:

```
/plugin marketplace add idconnectdk/idc365-decisions#meta/plugin
/plugin install idc365-decisions@idc365-decisions
```

Or in a terminal: `claude plugin marketplace add idconnectdk/idc365-decisions#meta/plugin`
and `claude plugin install idc365-decisions@idc365-decisions`.

A code repository that is already linked (see below) names the marketplace
and enables the plugin in its `.claude/settings.json`: when you trust the
folder, Claude Code registers the marketplace and loads the plugin in the
background. Claude Code does not record a plugin that only repository
settings enabled, so run the install command above once anyway; after that
it loads in every session.

The plugin puts `idc365-decisions` on the `PATH` of Claude's Bash and
PowerShell tools (`bin/idc365-decisions` and `bin/idc365-decisions.cmd`).
Claude Code installs the CLI's three dependencies (ajv, commander, yaml, with
exact pins) from npmjs.org when it caches the plugin.

## Update

The project settings turn on auto-update for the marketplace: Claude Code
fetches a new plugin version in the background and asks for
`/reload-plugins`. By hand: `/plugin marketplace update idc365-decisions`,
then `/reload-plugins`; in a terminal: `claude plugin update
idc365-decisions@idc365-decisions`, then restart Claude Code. When auto-update is off, the session priming says
when a newer version exists (checked once a day) and tells the agent to ask
you first.

## Documentation token

The CLI reads and writes the documentation repository through the GitHub API
with your own token, so pull requests carry your name. It reads the token
from the environment variable `IDC365_DECISIONS_TOKEN`. In a session, the
skill and `idc365-decisions setup` give these steps with a pre-filled link:

1. Open the pre-filled form
   <https://github.com/settings/personal-access-tokens/new?name=idc365-decisions&target_name=idconnectdk&expires_in=90&contents=write&pull_requests=write>.
2. **Resource owner:** select `idconnectdk` again, even if it is shown (a
   known GitHub issue creates the token for the personal account otherwise),
   and check that **Contents** and **Pull requests** are still *Read and
   write*.
3. **Repository access:** *Only select repositories* →
   `idconnectdk/idc365-decisions`.
4. **Expiration:** 90 days or what the organisation allows. Generate the
   token; if the organisation requires approval, wait for it.
5. Store it yourself (never paste it into a chat):
   - **Windows** (PowerShell):
     `[Environment]::SetEnvironmentVariable("IDC365_DECISIONS_TOKEN", "<token>", "User")`,
     or System Properties → Environment Variables → User variables.
   - **Linux / macOS:** `export IDC365_DECISIONS_TOKEN=<token>` in `~/.bashrc`
     (or `~/.zshrc`, `~/.profile`).
6. Close and reopen the terminal and Claude Code, then run
   `idc365-decisions setup`.

## Link a code repository

In the root of the code repository (Claude runs it when the skill says so):

```sh
idc365-decisions setup --repository idconnectdk/idc365-decisions
```

- Writes `.idc365-decisions.json` (`{"repository": "…"}`); asks for the
  repository in a terminal when `--repository` is missing.
- Merges the marketplace (`extraKnownMarketplaces`, branch `meta/plugin`,
  auto-update) and `enabledPlugins` into `.claude/settings.json`, keeping
  everything else; removes the old phase 9 project hook if present.
- Checks the token and its access, with the token steps when something is
  wrong. Exit code `0` ready, `1` something is missing.

Commit both files. Afterwards `idc365-decisions setup` (no options) checks
everything again and changes nothing. It never writes `CLAUDE.md`. See the
priming with `idc365-decisions hook session-start`.

## Write documentation

Agents write all documentation through the CLI. Every write goes to a work
branch and a pull request; **the user reviews and merges the PR in GitHub**.
The CLI never merges.

- **Guide per type:** `idc365-decisions adr` (also `proc`, `tech`, `code`)
  prints what the type is for, how to write it, its categories, the macro
  syntax and the verbs.
- **Create:** a new document with an ID the CLI allocates, on a new work
  branch `vX.Y.Z/<id>-<slug>` with its own PR:

  ```sh
  idc365-decisions adr create --version v1.0.1 --title "…" --description "…" \
    --intent "…" --when "…" --category data --body-file body.md
  ```

  `--version` decides the base branch: a patch of the released version goes
  to `main`, a planned release to its `release/vX.Y.Z` branch.
- **Several documents in one PR:** pass `--branch <work branch>` (printed by
  the first command) to `create` or `update`.
- **Update:** a correction in the same file, for example
  `idc365-decisions adr update ADR-0042 --version v1.0.1 --state deprecated`.
  A decision that changes is a new document that `supersedes` or `amends`
  the old one.
- **Read:** `idc365-decisions adr show ADR-0042` and
  `idc365-decisions adr list [--state accepted] [--category data]`, both
  with `--ref <branch or tag>` (default `main`).
- **Code documentation:** `idc365-decisions code create|update|show <path>`
  in a code repository; the path is relative to its git root, `src/_` is the
  folder `src`.
- **References** are macros in the body, expanded into links and relations
  when the CLI writes the file: `{{ADR:0042|<why>}}` or
  `{{ADR:0042|supersedes|<why>}}`. Prefixes: `ADR`, `PROC`, `TECH`, `REL`,
  `ATT`, `CODE` (`org/repo/path`), `JIRA` (`KEY-123`). `why` is required.

Every command prints markdown ending in `## Next action`; `--json` gives
machine-readable output.

## Read the documentation in the browser

```sh
idc365-decisions view            # opens the browser
idc365-decisions view --no-open  # prints the URL only
```

A small read-only website on your own machine: navigation by type, search
over ID, title and text, a version picker (`main`, planned releases and every
`v*` tag), and per document the status, the superseded banner, a table of
contents and its relations in both directions. The site workflow renders the
pages to the `meta/site` branch; `view` fetches them with your token, caches
them (it works offline from the cache) and serves them on `127.0.0.1` only.
The URL carries a one-time key that signs the browser in; the token never
reaches the browser. Ctrl+C stops it.

## Validate a documentation tree

```sh
idc365-decisions validate [path] [--json]
```

Checks the documentation repository at `path` (default: the current
directory) on disk: the configuration in `config/`, frontmatter against the
schema of each type, file names and IDs, shadow documents, relations and
their inverses, links, unexpanded macros, attachments and the priming budget.

- Output is markdown with one section per file and a `## Next action`;
  `--json` prints `{ok, root, documents, findings}` where each finding has
  `file`, `rule`, `message` and `nextAction`.
- Exit code: `0` no findings, `1` findings, `2` the path is not a directory.

## Uninstall

`/plugin uninstall idc365-decisions@idc365-decisions`, or set the plugin to
`false` in `enabledPlugins`.

## Development

The CLI lives in `cli/` of the idc365-decisions repository.

```sh
cd cli
npm ci             # install the locked dependencies
npm run build      # compile TypeScript from src/ to dist/
npm test           # compile and run the unit tests (node:test, no network)
node dist/index.js # run the CLI
```

Integration tests run against a real, disposable documentation repository
and are never part of `npm test` or CI. They open pull requests (and close
them again), create and delete work branches, and allocate IDs:

```sh
IDC365_TEST_REPO=<owner>/<repo> IDC365_DECISIONS_TOKEN=<token> npm run test:integration
```

Dependencies are pinned to exact versions (`cli/.npmrc` sets
`save-exact=true`) and locked in `package-lock.json`. Add a dependency only
when it is really needed.

## Repository setup (documentation repository)

An administrator sets up a new documentation repository once, with
[`SETUP.md`](../SETUP.md) and its script `setup/setup.mjs`: settings, the bot
(GitHub App), the environment `bot`, the rulesets, the `meta/*` branches, the
workflows and the configuration.

## Releases

The workflow `.github/workflows/plugin-build.yml` runs on every push to
`main` that changes `cli/`, `plugin/` or the workflow. It builds the CLI from
the pushed commit, assembles the plugin (`cli/dist/plugin/assemble.js`: CLI,
`plugin/` templates, wrappers, runtime lockfile), smoke-tests it and commits
it to `meta/plugin` with the bot. Only the bot may write `meta/plugin`
(ruleset `meta-plugin`).

Versions are `<major>.<minor>.<run number>`: major and minor come from
`cli/package.json`, the patch is the workflow run number. To start a new
minor or major line, change `version` in `cli/package.json`.
