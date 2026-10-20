---
name: zwei-grill-with-docs
description: Interviews the user about a Zwei feature or design while grounding decisions in repository behavior, domain language, and durable docs.
---

# Zwei Grill With Docs

Use for non-trivial feature, behavior, or architecture planning where unresolved choices could change scope, contracts, domain rules, or persistence. For a small isolated choice, use the installed `grill-me` skill instead.

## Interview

1. Inspect relevant code, tests, `README.md`, existing domain docs, and the current worktree before asking questions. Do not ask the user to supply facts already discoverable in the repository.
2. Build a concise decision tree and ask one focused question at a time. State a recommendation and its trade-offs; wait for the user's answer when the decision is material.
3. Use concrete direct/group messaging, delivery/read state, auth/session, realtime, or call scenarios as relevant. Check empty, failure, duplicate, concurrent, offline/reconnect, authorization, and compatibility cases where they affect the requested behavior.
4. Surface conflicts between the request, current code, protocol, migrations, tests, and documented product behavior. Do not silently resolve product or compatibility conflicts.
5. Stop when material decisions are clear. Summarize outcome, scope/non-goals, numbered acceptance criteria, decisions, risks, open questions, and a verification plan for the working feature plan/spec. Do not implement before the user approves a material proposal.

## Domain and decision records

- Keep `GLOSSARY.md` for concise agreed domain terms only. Create/update it lazily when a reusable term is introduced or clarified; do not add implementation notes.
- Record a consequential, hard-to-reverse decision in an ADR only when future maintainers would need its rationale and there are real alternatives. Ask the user before adding an ADR and follow existing repository conventions; if none exist, propose a concise Context / Decision / Alternatives / Consequences format.
- Do not create an ADR or glossary entry merely to make a spec look complete. Keep ordinary task decisions in the active, temporary feature plan.
- No issue tracker, GitHub issue, commit, PR, or publication action is implied by this skill.

## Handoff

Involve PM, TL/architect, DBA, security, QA, or an implementation engineer only where their expertise changes a decision. Return settled requirements and relevant proposed durable-doc changes to the primary engineer. This skill is planning guidance; it does not authorize implementation or unapproved documentation changes.
