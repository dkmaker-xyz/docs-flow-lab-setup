---
id: TECH-0001
title: PostgreSQL
description: Relational database for all services.
intent: The approved database engine and image versions.
when: When code stores relational data or starts a database container.
state: accepted
category: service
ecosystem: docker
packages:
  - name: postgres
    version: "16.*"
relations:
  - type: used-by
    target: ADR-0001
    why: The database engine this decision chooses.
    link: ../adr/0001-store-data-in-postgresql.md
rationale: One well-known relational database keeps operations simple.
license: PostgreSQL
last_review: "2026-10-01"
review_interval_months: 12
---
Use the official image.
