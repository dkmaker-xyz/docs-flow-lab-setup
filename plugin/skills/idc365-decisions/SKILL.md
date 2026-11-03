---
description: Use for anything about this project's architecture decisions (ADR), procedures (PROC), approved tech stack (TECH), releases (REL), attachments or code documentation, and when the idc365-decisions CLI reports that setup or the token is missing.
---

# idc365-decisions

The documentation repository `{{REPOSITORY}}` holds the project's decisions, procedures, approved tech stack and releases. The `idc365-decisions` CLI is the way to read and write it; run it in the Bash or PowerShell tool.

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

- Not linked yet: ask the user for the documentation repository (here `{{REPOSITORY}}`), then run `idc365-decisions setup --repository {{REPOSITORY}}`. It writes `.idc365-decisions.json` and the Claude Code project settings; ask the user to commit both.
- Token missing or rejected: give the user these steps. The user creates and stores the token; ask them never to paste it into the chat.

{{TOKEN_STEPS}}

After the restart, run `idc365-decisions setup` again; it passes when the token can read and write `{{REPOSITORY}}`.
