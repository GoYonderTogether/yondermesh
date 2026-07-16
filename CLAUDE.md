# CLAUDE.md — Claude Code guide for yondermesh

> **Read `AGENTS.md` first** — it is the canonical guide for all AI coding agents on this project (architecture map, conventions, doc-sync discipline, code quality, release discipline). This file adds Claude Code-specific notes on top.

## Dogfooding principle (fix it while you use it)

> As an agent developing yondermesh, **if you notice something unreasonable while using this project itself** — a confusing query result, a missing CLI option, a detection that's off — **fix it immediately**: modify the code, write a test, and commit. Don't file a TODO and move on.

Rules:
- Every fix must pass `npm test` + `npm run typecheck` before committing.
- Keep changes within the current module boundary; don't refactor unrelated code on the way through.
- The fix must trace to a concrete observation, not a hypothetical.
- One observation → one focused fix → one commit.
- Architectural invariants (§III in `ARCHITECTURE.md`) are non-negotiable.

## Quick reference

- **Run tests:** `npm test`
- **Typecheck:** `npm run typecheck`
- **Try it live:** `npx tsx src/bin/ymesh.ts <command>`
- **Architecture:** `ARCHITECTURE.md` — "Where does X live?" check here first.
- **Doc sync:** any change to `src/bin/ymesh.ts` commands or `src/<adapter>/` requires `npm run sync --prefix site` + commit the regenerated docs.
