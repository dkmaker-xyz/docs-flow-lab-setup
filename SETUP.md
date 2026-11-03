# Setting up a documentation repository

This guide turns an empty GitHub repository into a working idc365-decisions
documentation repository. It covers the infrastructure only: settings, the
bot, the rulesets, the workflows and the configuration. Documents are written
afterwards through the CLI.

Follow the steps in order. Each step says what to do and how to check it.
Everything except creating the GitHub App runs through one script,
`setup/setup.mjs`. It is a Node script, so it runs the same on Windows, macOS
and Linux, and it calls the GitHub CLI (`gh`) for every change. The script is
idempotent: run it again at any time, it changes only what differs. Use
`--check` to see the state without changing anything.

```sh
node setup/setup.mjs --repo <org>/<repo> --app-id <App ID> --client-id <Client ID> [--private-key <file.pem>] [--only <steps>] [--check]
```

Steps of the script, in order: `settings`, `actions`, `environment`,
`content`, `ids`, `rulesets`. The order matters: the bot (steps 3–4) must
exist before the system files reach `main` (step 5), because that push
starts the bot's workflows; and `main` and `meta/ids` must exist before the
rulesets (step 6), which block everyone but the bot from creating them.

Placeholders used below: `<org>` the organisation (for example
`idconnectdk`), `<repo>` the documentation repository (for example
`idc365-decisions`), `<bot>` the GitHub App's name (for example
`idc365-decisions-bot`).

## 1. Requirements

What you need before you start:

- **GitHub plan:** GitHub Team (or higher) for a private repository. Team
  gives everything this setup uses on a private repository: repository
  rulesets for branches and tags with a GitHub App as the only bypass actor,
  required status checks, environments with deployment branch rules and
  environment secrets.
  - What GitHub cannot enforce, on any plan: a fine-grained token with
    Contents write can technically call the merge endpoint, so "only a human
    merges" is enforced by the CLI and the agent instructions (the CLI has no
    merge command).
  - GitHub Pages for a private repository needs GitHub Enterprise Cloud;
    that is why developers read the documentation with the local viewer
    (`idc365-decisions view`) instead of a hosted site.
- **Rights:** owner of the organisation (to create the GitHub App, install it
  and create the repository) and admin of the repository.
- **Git LFS:** on by default for GitHub repositories; attachments are stored
  with it. LFS storage and bandwidth count against the organisation's
  quota. Developers need no `git lfs` client: the CLI uses GitHub's LFS API.
- **On your machine:** Node.js 22.12 or later (`node --version`), Git, and
  the GitHub CLI logged in as an organisation owner (`gh auth status`; log
  in with `gh auth login`).
- **A checkout of the idc365-decisions system** (this repository) at the
  version you want to install: `setup/setup.mjs` copies its `cli/`,
  `plugin/`, `config/`, `setup/`, `SETUP.md` and workflows.

Check: `node --version` prints 22.12 or later, and `gh auth status` shows
your account with the scopes `repo` and `workflow`.

## 2. Repository and its settings

1. Create the repository, empty (no README, no licence, no .gitignore):

   ```sh
   gh repo create <org>/<repo> --private
   ```

2. Apply the settings and the Actions policy:

   ```sh
   node setup/setup.mjs --repo <org>/<repo> --only settings,actions
   ```

   - **Merge commits only** (squash and rebase off): long-lived branches
     must never be squashed, and the ruleset in step 5 allows only merge
     commits too. Merge commit title "Merge pull request #N from …" (the
     post-merge bot reads it).
   - **Automatically delete head branches** after merge. The ruleset in
     step 5 keeps `release/*` branches from being deleted by it.
   - **Actions:** enabled; only GitHub-owned actions (the workflows use
     `actions/checkout`, `actions/setup-node` and
     `actions/create-github-app-token`), and **SHA pinning required** (every
     action in the workflows is pinned to a commit SHA).
   - **`GITHUB_TOKEN`** read-only by default and not allowed to approve pull
     requests. Every workflow declares the permissions it needs; writes go
     through the bot's own token.
   - **Fork pull requests:** workflows of outside contributors need approval.
     On a public repository anyone can open a pull request; the validation
     check runs on `pull_request_target`, which always uses the workflow
     from `main` with a read-only token and no secrets, so a pull request can
     never reach the bot key. The approval only saves runner minutes. On a
     private repository forks are normally off and this setting does not
     apply (the script then reports it as not available).

Check: `node setup/setup.mjs --repo <org>/<repo> --only settings,actions --check`
reports `OK` for every line.

## 3. The bot (GitHub App)

The bot is a GitHub App. It writes what no person may write: inverse
relations after a merge, release branches and tags, the index, the site and
the plugin. Creating an App and its key is only possible in the browser.

1. Open `https://github.com/organizations/<org>/settings/apps/new`.
2. Fill in:
   - **GitHub App name:** `<bot>`, for example `idc365-decisions-bot`.
   - **Homepage URL:** `https://github.com/<org>/<repo>`.
   - **Webhook:** clear **Active** (the bot needs no webhooks).
   - **Repository permissions:** **Contents: Read and write**, **Pull
     requests: Read-only**. Metadata: Read-only is added automatically.
     Nothing else, no organisation or account permissions, no events.
   - **Where can this GitHub App be installed?** Only on this account.
3. **Create GitHub App.** On the App's page, note the **App ID** (a number)
   and the **Client ID** (starts with `Iv`).
4. **Private keys → Generate a private key.** The browser downloads a
   `.pem` file. Keep it until step 4, then delete it; it never goes into
   a repository or a chat.
5. **Install App → <org> → Only select repositories → `<repo>`.** Install it
   on the documentation repository only. For an App that is already
   installed in the organisation (for example when you set up a second
   documentation repository), adding the repository also works from the
   command line:

   ```sh
   gh api -X PUT /user/installations/$(gh api orgs/<org>/installations --jq '.installations[] | select(.app_slug=="<bot>") | .id')/repositories/$(gh api repos/<org>/<repo> --jq .id)
   ```

How the test bot was set up (for comparison): `docs-flow-lab-bot` in the test
organisation has exactly these permissions (Contents write, Pull requests
read, Metadata read), no webhook and no events, and is installed on selected
repositories only.

Check: `gh api orgs/<org>/installations --jq '.installations[] | select(.app_slug=="<bot>") | .permissions'`
prints `contents: write`, `metadata: read`, `pull_requests: read`; and on the
App's settings page, **Install App** lists only `<repo>`.

## 4. Environment `bot`, the key and the Client ID

```sh
node setup/setup.mjs --repo <org>/<repo> --only environment --client-id <Client ID> --private-key <path to the .pem>
```

- Creates the environment **`bot`** with **deployment branches `main` and
  `release/*`** only. A job from any other branch cannot start in it, so it
  cannot read the key.
- Stores the private key as the secret **`BOT_PRIVATE_KEY` in the
  environment only** (never as a repository secret; the script reports a
  repository-level one as a problem).
- Sets the repository variable **`BOT_CLIENT_ID`** (the workflows use the
  Client ID; `app-id` is deprecated in `create-github-app-token`).

Delete the `.pem` file afterwards.

Check: `node setup/setup.mjs --repo <org>/<repo> --only environment --check`
reports `OK` for the environment, both deployment branches, the variable and
the secret.

## 5. The system files on `main`

```sh
node setup/setup.mjs --repo <org>/<repo> --only content
```

Commits the system files from your checkout to `main`, in one commit:
`cli/`, `plugin/`, `config/`, `setup/`, `SETUP.md` and the workflows
`docs-validate`, `docs-post-merge`, `docs-index-trigger`, `docs-index`,
`docs-index-remove`, `docs-site` and `plugin-build`. Only when `main` does
not exist yet; afterwards every change goes through a pull request.

This push starts the workflows, which is why the bot comes first: the index
of `main` (`meta/index`), the site (`meta/site`) and the plugin
(`meta/plugin`) are built by the bot within a few minutes (step 6).

Check: the **Actions** tab shows green runs of "Documentation index",
"Documentation site" and "Claude Code plugin" for the commit.

## 6. Branches and rulesets

```sh
node setup/setup.mjs --repo <org>/<repo> --only ids,rulesets --app-id <App ID>
```

### Branches

| Branch | Holds | Created by |
| --- | --- | --- |
| `main` | the documentation and the system | step 5 |
| `release/vX.Y.Z` | the documentation of a planned release | the bot, after a release PR is merged |
| `meta/ids` | `counters.json`, the next ID per type | the script (step `ids`), before its ruleset; developers' CLIs update it |
| `meta/index` | one index per documentation branch, and post-merge's record of the last handled commit per truth branch | the bot, on the first index build (step 5) |
| `meta/site` | the rendered HTML per truth branch and `v*` tag | the bot, on the first site build (step 5) |
| `meta/plugin` | the Claude Code plugin (marketplace) | the bot, on the first plugin build (step 5) |

The `meta/*` branches are orphan branches (no shared history with `main`).

### Rulesets

The rulesets are JSON files under `setup/rulesets/`; the script fills in the
bot's App ID as the **only bypass actor** and creates or updates each one by
name. Nobody else bypasses them, organisation owners included.

| Ruleset | Target | Rules |
| --- | --- | --- |
| `truth-branches` | branches `main`, `release/*` | pull request required (merge commit only, no required approvals: the developer reviews and merges); required check **`validate`** (from GitHub Actions); no creation, deletion or force push |
| `release-tags` | tags `v*` | no creation, update or deletion |
| `meta-ids` | `meta/ids` | no creation, deletion or force push (updates allowed: developers' CLIs allocate IDs) |
| `meta-index` | `meta/index` | no creation, update, deletion or force push |
| `meta-plugin` | `meta/plugin` | no creation, update, deletion or force push |
| `meta-site` | `meta/site` | no creation, update, deletion or force push |

Check:

```sh
node setup/setup.mjs --repo <org>/<repo> --app-id <App ID> --check
```

reports `OK` everywhere, and a push to a protected branch by you is
refused, for example:

```sh
gh api -X POST repos/<org>/<repo>/git/refs -f ref=refs/tags/v0.0.1 -f sha=$(gh api repos/<org>/<repo>/git/ref/heads/main --jq .object.sha)
```

fails with "Repository rule violations found".

## 7. Configuration (`config/`)

The configuration is part of the repository and changes through a pull
request like any document; the `validate` check checks the YAML files
against `cli/schemas/config.schema.json`. Each top-level key lives in exactly
one file.

- **`repositories.yaml`** → `repositories`: the code repositories
  (`org/repo`) that may have code documentation under `code/<org>/<repo>/`.
  Add every code repository you link (step 8).
- **`jira.yaml`** → `jira_base_url`: the URL a Jira key is appended to,
  ending with a slash, for example `https://<company>.atlassian.net/browse/`.
  While it is `null`, references to Jira fail validation.
- **`priming.yaml`** → `priming_budget`: the maximum characters of the
  priming that starts every Claude Code session (fixed text plus all
  `featured` documents). Claude Code caps it at 10,000; 8,000 leaves room.
- **`cooldown.yaml`** → `cooldown_days`: how many days a package version
  must be public before `tech check` accepts it (a guard against
  compromised releases). 3 is the default.
- **`attachments.yaml`** → `attachment_types`: allowed file extensions
  (lowercase, no dot) and their media types; `attachment_max_bytes`: the
  maximum size of one attachment (26214400 = 25 MB).
- **`instructions.md`**: the instructions every Claude Code session starts
  with (how to work with the official documentation). The text is shipped
  as approved; change it by pull request like any document. It must keep
  the placeholders `{{release}}`, `{{commands}}` and `{{featured}}`, each
  exactly once: the hook fills in the release of the code branch, the most
  important commands and the featured documents there. The `validate`
  check enforces this and reports the size of the whole priming against
  `priming_budget`. `idc365-decisions instructions` prints the text as a
  session receives it.
- **`categories.yaml`** → `categories.adr`, `categories.procedure`,
  `categories.techstack`: the categories per document type. Each has a
  `description` for people and a `when` for agents (when a document belongs
  there). The shipped lists are a starting point; rename, add or remove
  categories by pull request (documents in a removed category fail
  validation until they are moved).

Check: a pull request that changes `config/` gets a green `validate` check,
and `node cli/dist/index.js validate` in a local checkout reports no findings.

## 8. Code repositories

In the root of each code repository (with the plugin installed, Claude can do
this; otherwise build the CLI from `cli/`):

```sh
idc365-decisions setup --repository <org>/<repo>
```

It writes two files; commit both:

- **`.idc365-decisions.json`**: `{"repository": "<org>/<repo>"}`, which
  links the code repository to the documentation repository.
- **`.claude/settings.json`**: `extraKnownMarketplaces` (the marketplace
  `idc365-decisions` = `<org>/<repo>`, branch `meta/plugin`, auto-update) and
  `enabledPlugins` (`idc365-decisions@idc365-decisions`), so Claude Code
  offers the plugin to everyone who opens the repository. Anything else in
  the file is kept.

Also add the code repository to `config/repositories.yaml` (step 7).

Check: `idc365-decisions setup` in the code repository reports `OK` for the
link file, the project settings and the token.

## 9. Developers

Each developer follows `cli/README.md`: Git access to the documentation
repository, the plugin (`/plugin marketplace add <org>/<repo>#meta/plugin`,
`/plugin install idc365-decisions@idc365-decisions`), and their own
fine-grained token in `IDC365_DECISIONS_TOKEN` (the plugin's skill and
`idc365-decisions setup` give the steps with a pre-filled link).

## 10. Final check

All of these should hold:

1. `node setup/setup.mjs --repo <org>/<repo> --app-id <App ID> --check` reports
   "Everything is set up."
2. The branches `main`, `meta/ids`, `meta/index`, `meta/site` and
   `meta/plugin` exist.
3. A document created with the CLI (for example `idc365-decisions adr create
   …`) gets an ID (`meta/ids` counts up) and a pull request whose
   `validate` check is green.
4. After the pull request is merged, the Actions tab shows green runs of
   "Documentation post-merge", "Documentation index" and "Documentation
   site", and `idc365-decisions view` shows the document.
5. A push by a person to `meta/index` and the creation of a `v*` tag are
   refused with "Repository rule violations found".
6. In a linked code repository, a new Claude Code session is primed (ask
   Claude which release and documentation branch it was given).
