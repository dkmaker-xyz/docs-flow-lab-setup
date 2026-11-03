---
id: ADR-0002
title: Store documents as Markdown with checked frontmatter
description: Markdown documents with schema-checked frontmatter.
intent: "Replaces ADR-0001: documents carry checked frontmatter."
when: Phase 12 test only.
state: accepted
category: data
relations:
  - type: supersedes
    target: ADR-0001
    why: frontmatter adds a checked schema
    link: ./0001-store-documents-as-markdown.md
  - type: uses
    target: TECH-0001
    why: the validator runs on Node.js
    link: ../techstack/0001-node-js.md
---
## Context

Markdown alone (ADR-0001) does not give the documents a schema.

## Decision

Documents are Markdown with YAML frontmatter that the validator checks ([ADR-0001][ADR-0001]), on the approved runtime ([TECH-0001][TECH-0001]).

## Consequences

The validate check fails documents with bad frontmatter.

[ADR-0001]: ./0001-store-documents-as-markdown.md
[TECH-0001]: ../techstack/0001-node-js.md
