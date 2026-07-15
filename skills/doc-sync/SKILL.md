---
name: doc-sync
description: Reconcile the public docs site (site/, VitePress) and top-level canonical docs (README/ARCHITECTURE/CONTRIBUTING) with source code after a change. Use before calling any change "done", at the end of every PR, or when asked to audit doc/code drift. Enforces this repo's hard rule: code change = doc change in the same commit.
---

# doc-sync — keep docs and code converged

This repo treats doc lag as **an unfinished bug**. This skill is the executable
procedure; the canonical *mapping table* (which change owes which doc) lives in
**`AGENTS.md`** at the repo root — read it there, do not copy it here.

## When to run

- End of every PR that touches `src/`, `package.json`, CLI commands, or adapter
  directories.
- Whenever someone says "the docs are out of date" / "doc audit" / "漂移检查".
- Before cutting a release.

## Mode 1 — per-change sync (run at the end of every change)

1. **Determine the change surface.**

   ```bash
   git diff --stat origin/main...HEAD
   # or for uncommitted work:
   git diff --stat
   ```

2. **Map each changed path against the AGENTS.md doc-sync table.** Produce the
   list of docs owed by this change. The high-traffic rows:

   | You changed… | Must also update |
   |---|---|
   | `src/bin/ymesh.ts` (CLI commands / flags / help text) | Run `npm run sync --prefix site` — `site/reference/cli.md` (en + zh) is auto-regenerated from `ymesh help`. |
   | `src/<adapter>/` (added / removed / coverage level changed) | Run `npm run sync --prefix site` — `site/reference/adapters.md` (en + zh) is auto-regenerated from `src/*/`. |
   | Daemon protocol, MCP tool list, mount strategies | `site/reference/mcp-tools.md`, `site/guide/mount.md`, `AGENTS.md` codemap section |
   | `package.json` version bump | `CHANGELOG.md` entry in the same commit |
   | New top-level feature | `README.md` feature list + a new `site/guide/<topic>.md` page linked from the sidebar in `site/.vitepress/config.ts` |
   | `~/.yondermesh/` file layout | `site/reference/files.md` |
   | `install.sh` or release / update flow | `site/guide/installation.md` |
   | Doc/code mismatch, or a TODO left behind | Open an issue; do not let it rot silently |

3. **Re-run the auto-generators.**

   ```bash
   # from repo root
   npm run sync --prefix site
   ```

   This regenerates `site/reference/cli.md` and `site/reference/adapters.md`
   (both en + zh) from `ymesh help` and `src/*/`. Commit the result if it
   changed — that is the whole point.

4. **Hygiene gates.**

   ```bash
   # drift check: regenerates + asserts no diff vs committed
   node scripts/docs/check-drift.mjs

   # link check: every internal link in site/ must resolve
   node scripts/docs/verify-links.mjs

   # full site build (catches broken VitePress config / frontmatter)
   npm run build --prefix site
   ```

   All three must pass before "done".

5. **Fail loud.** In the PR/summary, list:
   - docs updated (with file paths)
   - docs checked-and-clean (no change needed)
   - drift found but deferred (with the issue link)

## Mode 2 — periodic full audit (on request / doc-gardening)

1. **`site/reference/adapters.md` vs `src/`**: every adapter dir appears in the
   matrix; coverage level matches the files present (A=importer, B=wrapper/inject,
   C=extractor only).
2. **`site/reference/cli.md` vs `ymesh help`**: every command and flag listed in
   help appears in the doc page (auto-checked by `check-drift.mjs`).
3. **`site/.vitepress/config.ts` sidebar** vs `site/`: every sidebar link
   resolves to an existing `.md` file (auto-checked by `verify-links.mjs`).
4. **`README.md`** vs `site/index.md`: pitch + quickstart stay aligned. README is
   the GitHub poster; the site is the manual. They overlap on purpose only on
   the quickstart.
5. **`CHANGELOG.md`** vs `package.json`: every published version has an entry.

Report findings with `file:line` evidence; fix mechanically-safe drift in the
same pass, open issues for anything needing a decision.

## Map, not a manual

This skill is a map: details go into their respective files. **Don't accumulate
history or changelogs here** — that's what `git log` is for. When the
doc-sync table changes, update `AGENTS.md` (not this file).
