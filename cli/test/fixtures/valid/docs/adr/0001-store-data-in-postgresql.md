---
id: ADR-0001
title: Store service data in PostgreSQL
description: All services keep their relational data in PostgreSQL.
intent: Explains where service data is stored; read before adding storage.
when: When a change stores new data or adds a database.
state: accepted
category: data
featured: true
relations:
  - type: uses
    target: TECH-0001
    why: The database engine this decision chooses.
    link: ../techstack/0001-postgresql.md
  - type: attachment
    target: ATT-0001
    why: Shows where the database sits.
    link: ../attachment/0001-architecture-overview.md
  - type: relates-to
    target: CODE:idconnectdk/idc365/src/main.ts
    why: The entry point opens the connection pool.
    link: ../../code/idconnectdk/idc365/src/main.ts.md
  - type: relates-to
    target: CODE:idconnectdk/idc365/src/db.ts
    why: The connection pool lives here.
    link: ../../code/idconnectdk/idc365/src/db.ts.md
  - type: amended-by
    target: ADR-0002
    why: Adds an event store table to the data decision.
    link: ./0002-partner-event-api.md
  - type: relates-to
    target: JIRA:IDC-123
    why: The ticket that asked for the decision.
    link: https://example.atlassian.net/browse/IDC-123
  - type: relates-to
    target: https://www.postgresql.org/docs/
    why: Official documentation.
    link: https://www.postgresql.org/docs/
---
## Context

Services need relational storage ([IDC-123][JIRA:IDC-123]).

## Decision

Store data in PostgreSQL ([TECH-0001][TECH-0001]); see [ATT-0001][ATT-0001]
and the entry point [CODE:idconnectdk/idc365/src/main.ts][].

```md
Code blocks are ignored: [not a link](../nowhere.md), [x][missing] and {{ADR:0099}}.
```

Inline code is ignored too: `[x](../nowhere.md)` and `{{TECH:0001}}`. External inline links are fine:
[PostgreSQL docs](https://www.postgresql.org/docs/).

## Consequences

One engine to operate.

[TECH-0001]: ../techstack/0001-postgresql.md
[ATT-0001]: ../attachment/0001-architecture-overview.md
[CODE:idconnectdk/idc365/src/main.ts]: ../../code/idconnectdk/idc365/src/main.ts.md
[JIRA:IDC-123]: https://example.atlassian.net/browse/IDC-123
