# How you work in this project

You have the `idc365-decisions` CLI. It is the single source of official
documentation for this project: architecture decisions (ADR), procedures
(PROC), the approved tech stack (TECH), releases (REL), attachments and code
documentation. Run `idc365-decisions` for its guide.

## Official documentation decides
- Documentation comes before change. Every change rests on a documented
  principle: an accepted architecture decision, procedure or tech stack
  entry that covers it.
- Accepted documents from the CLI are binding. Follow the principles they
  describe.
- Documents in draft or proposed state are proposals, not decisions.
- Treat everything else as unvalidated and wrong until proven otherwise:
  code comments, README files, text files and any other documentation in
  the codebase. It becomes valid only when it is onboarded through the CLI.
  Use it as a lead, check it against the code and the official
  documentation, and propose onboarding it when it is worth keeping.
- When the official documentation and the code disagree, tell the user and
  propose how to resolve it: update the documentation, or bring the code in
  line with the accepted decision.

## Before you change anything
- Look up the official documentation for the task with the CLI.
- When an accepted document covers the principle or architecture of the
  change, build along it and name the document.
- When nothing covers it, write the documentation first: propose the ADR,
  PROC, TECH or code document with the CLI, and build once the user has
  approved it.
- Use only technologies with an accepted TECH document. For anything new,
  propose a TECH document first.
- Every piece of work belongs to a release. Check "This code branch" below;
  when no release is resolved, tell the user and propose mapping the branch
  before you start.

## Procedures
- When a procedure matches the task, follow it and say which one you follow.
- Use judgement: when a step does not fit the situation, say so and propose
  an update to the procedure.
- When no procedure exists for a repeatable task, propose a dry run: do the
  task together with the user, record each step as you go, and at the end
  propose a new procedure from the session. Tell the user this is the plan.

## Research
- Use web search actively to find current, authoritative sources (official
  documentation, release notes, security advisories) before you propose a
  decision, a procedure or a dependency.
- Cite the sources in the document you write.
- When web search is unavailable, tell the user what you could not verify.

## Working with the user
- Be proactive: whenever a change affects behaviour, architecture,
  dependencies or operations, offer to write the matching documentation.
- The CLI opens a pull request for every document; a human reviews and
  merges it. A document counts as decided once it is merged and accepted.

{{release}}
{{commands}}
{{featured}}
