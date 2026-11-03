---
id: ADR-0002
title: Partner events use the integration spec format
description: Partner events follow the delivered specification.
intent: Defines the event contract with the partner.
when: When code sends or receives partner events.
state: proposed
category: api
relations:
  - type: amends
    target: ADR-0001
    why: Adds an event store table to the data decision.
    link: ./0001-store-data-in-postgresql.md
  - type: attachment
    target: ATT-0002
    why: The contract itself.
    link: ../attachment/0002-integration-spec.md
---
## Context

The partner delivered a specification ([ATT-0002][ATT-0002]).

## Decision

Follow it; this amends [ADR-0001][ADR-0001].

## Consequences

Changes to the spec need a new attachment.

[ATT-0002]: ../attachment/0002-integration-spec.md
[ADR-0001]: 0001-store-data-in-postgresql.md
