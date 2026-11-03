---
id: ADR-0001
title: Store documents as Markdown
description: Documents are Markdown files with frontmatter.
intent: Where documents live; test of SETUP.md.
when: Phase 12 test only.
state: superseded
category: data
relations:
  - type: superseded-by
    target: ADR-0002
    why: frontmatter adds a checked schema
    link: ./0002-store-documents-as-markdown-with-checked-frontmatter.md
---
## Context

The test repository needs one storage decision to prove the setup.

## Decision

Store documents as Markdown with frontmatter in git.

## Consequences

Every change is reviewed in a pull request.
