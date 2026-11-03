---
description: Use for anything about this project's architecture decisions (ADR), procedures (PROC), approved tech stack (TECH), releases (REL), attachments or code documentation, and when the idc365-decisions CLI reports that setup or the token is missing.
---

# idc365-decisions

The documentation repository `dkmaker-xyz/docs-flow-lab-setup` holds the project's decisions, procedures, approved tech stack and releases. The `idc365-decisions` CLI is the way to read and write it; run it in the Bash or PowerShell tool.

## How to work

Run `idc365-decisions instructions` and follow what it prints: the project's instructions for working with the official documentation (the same text the session started with, from `config/instructions.md` in the documentation repository), with the release of the current branch and the featured documents.

## When to use it

- Before designing or changing code: `idc365-decisions adr list` and `idc365-decisions adr show <ID>` for the decisions that apply.
- Before adding or upgrading a dependency: `idc365-decisions tech check`.
- To record a decision, procedure or code documentation: `idc365-decisions adr|proc|tech|code` prints the guide and the verbs; every write opens a pull request that the user reviews and merges.
- To see which release the current branch belongs to: `idc365-decisions release current`.
- When the user wants to read or browse the documentation: start `idc365-decisions view` as a background command (it keeps serving until stopped) and give the user the URL it prints.
- Every command ends with `## Next action`; follow it.

## Setup

Run `idc365-decisions setup` in the root of the code repository and follow its next action.

- Not linked yet: ask the user for the documentation repository (here `dkmaker-xyz/docs-flow-lab-setup`), then run `idc365-decisions setup --repository dkmaker-xyz/docs-flow-lab-setup`. It writes `.idc365-decisions.json` and the Claude Code project settings; ask the user to commit both.
- Token missing or rejected: give the user these steps. The user creates and stores the token; ask them never to paste it into the chat.

1. Open https://github.com/settings/personal-access-tokens/new?name=idc365-decisions&description=idc365-decisions+CLI%3A+read+and+write+dkmaker-xyz%2Fdocs-flow-lab-setup&target_name=dkmaker-xyz&expires_in=90&contents=write&pull_requests=write (signed in to GitHub).
2. **Resource owner:** select `dkmaker-xyz` again in the dropdown, even if it already shows it (a known GitHub issue: otherwise the token is created for the personal account). Then check that **Contents** and **Pull requests** are still *Read and write*; add them again if the switch cleared them.
3. **Repository access:** *Only select repositories* → `dkmaker-xyz/docs-flow-lab-setup` only.
4. **Expiration:** 90 days (or what the organisation allows). Generate the token; if the organisation requires approval, wait for an owner to approve it.
5. Store it as `IDC365_DECISIONS_TOKEN` yourself; never paste it into the chat:
   - **Windows** (PowerShell): `[Environment]::SetEnvironmentVariable("IDC365_DECISIONS_TOKEN", "<token>", "User")`, or System Properties → Environment Variables → User variables.
   - **Linux / macOS:** add `export IDC365_DECISIONS_TOKEN=<token>` to `~/.bashrc` (or `~/.zshrc`, `~/.profile`).
6. Close the terminal and Claude Code, open them again (they read the variable at start), and run `idc365-decisions setup`.

After the restart, run `idc365-decisions setup` again; it passes when the token can read and write `dkmaker-xyz/docs-flow-lab-setup`.
