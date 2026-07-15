---
title: Contributing
description: How to contribute to yondermesh — development setup, code style, adapters, doc-sync discipline, CI, and pull request process.
outline: [2, 3]
---

# Contributing

Thanks for your interest in contributing to yondermesh. This is an open-source
project by [未至之境 (GoYonderTogether)](https://github.com/GoYonderTogether).
This page mirrors the canonical
[CONTRIBUTING.md](https://github.com/GoYonderTogether/yondermesh/blob/main/CONTRIBUTING.md)
and [AGENTS.md](https://github.com/GoYonderTogether/yondermesh/blob/main/AGENTS.md)
at the repo root — those files are the source of truth; this page is the
browsable version.

## Quick contribution paths

- **Bug reports** →
  [open an issue](https://github.com/GoYonderTogether/yondermesh/issues/new?labels=bug&template=bug_report.md)
- **Feature requests** →
  [open an issue](https://github.com/GoYonderTogether/yondermesh/issues/new?labels=enhancement&template=feature_request.md)
- **Security reports** → see
  [SECURITY.md](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md)
  (do **not** open a public issue for security)
- **Code changes** → fork → branch → PR against `main`

## Getting started

```bash
git clone https://github.com/GoYonderTogether/yondermesh.git
cd yondermesh
npm install            # root deps (TypeScript, vitest, tsx)
npm run build          # compile TS → dist/
npm test               # run vitest
npm run typecheck      # tsc --noEmit
```

You can run the CLI from source without installing:

```bash
npm run dev -- help
npm run dev -- scan
npm run dev -- daemon
```

## Project layout

The full file/directory map lives in
[ARCHITECTURE.md](https://github.com/GoYonderTogether/yondermesh/blob/main/ARCHITECTURE.md)
§II and is mirrored on [File Layout](/reference/files). The short version:

| Path | Role |
|---|---|
| `src/bin/ymesh.ts` | CLI entry point; the only place commands are registered |
| `src/<adapter>/` | One directory per supported CLI agent (importer/wrapper/inject/extractor) |
| `src/store/` | The only writer to SQLite |
| `src/daemon/` | Daemon lifecycle (scan-once → watch → reconcile) |
| `src/mcp/` | MCP server, registration, handoff package builder |
| `src/mount/` | Mount system: non-invasive extensions into CLI config dirs |
| `src/install/` | Release build, launcher symlink, updater with auto-rollback |
| `scripts/docs/` | Doc generators and drift/link checkers |
| `site/` | VitePress public docs site (this site) |

## Code style

- **TypeScript throughout.** `npm run typecheck` must pass.
- **No external CLI framework** in `src/bin/ymesh.ts` — the hand-rolled
  `parseArgs` is intentional. Do not pull in `commander`, `yargs`, etc.
- **Follow existing patterns.** Every adapter follows the
  importer/wrapper/inject/extractor file pattern; see any existing adapter
  under `src/` for the template.
- **Surgical diffs.** Every line traces to the task. No drive-by cleanup of
  unrelated code.
- **Verify before "done".** Run `npm test`, `npm run typecheck`, and exercise
  the real path (CLI / daemon / MCP). Post the evidence in the PR description.
- **Fail loud.** List what was skipped, what warned, what wasn't verified.

## Adding a new CLI adapter

1. Create `src/<cli-name>/` with an `importer.ts` that reads the CLI's native
   session format into `SessionStore`. Add an `index.ts` exporting the
   adapter's public surface.
2. Register the adapter in `cmdScan()` inside `src/bin/ymesh.ts` so
   `ymesh scan` invokes it.
3. Add a test: `tests/<cli-name>-importer.test.ts`. Every adapter has its
   own test file.
4. Run the doc-sync pipeline (see the next section) so the adapter matrix
   regenerates.
5. See the "Adding a New Adapter" section of the
   [adapter matrix](/reference/adapters) for the canonical checklist.

## Doc-sync discipline (highest priority)

> Docs naturally lag behind code. This project treats doc/code sync as a
> **hard rule**: every change must update the corresponding docs in the
> **same commit**. **Doc lag = an unfinished bug.**

The canonical mapping lives in
[AGENTS.md](https://github.com/GoYonderTogether/yondermesh/blob/main/AGENTS.md).
The high-traffic rows:

| You changed… | Must also update |
|---|---|
| `src/bin/ymesh.ts` (CLI commands / flags / help text) | Run `npm run sync --prefix site` — regenerates `site/reference/cli.md` (en + zh) from `ymesh help`. Commit the result. |
| `src/<adapter>/` (added / removed / coverage level changed) | Run `npm run sync --prefix site` — regenerates `site/reference/adapters.md` (en + zh) from `src/*/`. Commit the result. |
| Daemon protocol, MCP tool list, mount strategies | `site/reference/mcp-tools.md`, `site/guide/mount.md`, `ARCHITECTURE.md` codemap |
| `package.json` version bump | `CHANGELOG.md` entry in the same commit |
| New top-level feature | `README.md` feature list + new `site/guide/<topic>.md` page linked from `site/.vitepress/config.ts` sidebar |
| `~/.yondermesh/` file layout | `site/reference/files.md` |
| `install.sh` or release / update flow | `site/guide/installation.md` |
| Doc/code mismatch, or a TODO left behind | Open an issue; do not let it rot silently |

The procedure (run before marking your PR "ready for review"):

```bash
# 1. Re-run the auto-generators (regenerates CLI reference + adapter matrix)
npm run sync --prefix site
git add site/reference/cli.md site/zh/reference/cli.md \
        site/reference/adapters.md site/zh/reference/adapters.md

# 2. Drift check: regen + assert no diff vs committed
node scripts/docs/check-drift.mjs

# 3. Link check: every internal link in site/ must resolve
node scripts/docs/verify-links.mjs

# 4. Full site build (catches broken VitePress config / frontmatter)
npm run build --prefix site
```

All three hygiene gates must pass before the PR is reviewable. CI will fail
the PR if any of them drift. The canonical procedure is the `doc-sync` skill
at [`skills/doc-sync/SKILL.md`](https://github.com/GoYonderTogether/yondermesh/blob/main/skills/doc-sync/SKILL.md).

### Auto-generated vs hand-written docs

| File | Source | Edit by hand? |
|---|---|---|
| `site/reference/cli.md` | Auto-generated from `ymesh help` | No |
| `site/zh/reference/cli.md` | Auto-generated from `ymesh help` | No |
| `site/reference/adapters.md` | Auto-generated from `src/*/` | No |
| `site/zh/reference/adapters.md` | Auto-generated from `src/*/` | No |
| `site/guide/*.md` | Hand-written | Yes |
| `site/zh/guide/*.md` | Hand-written | Yes |
| `site/reference/files.md`, `mcp-tools.md`, `config.md` | Hand-written | Yes |
| `site/.vitepress/config.ts` | Hand-written | Yes |
| Top-level `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `AGENTS.md`, `SECURITY.md`, `CHANGELOG.md` | Hand-written | Yes |

Never hand-edit an auto-generated file — the next `npm run sync` will
overwrite your changes and CI will flag the drift.

## Adding documentation

- **Hand-written pages** go in `site/guide/` (English) and `site/zh/guide/`
  (Chinese). The two locales must stay in sync — if you add or restructure a
  page, do it in both.
- **Auto-generated pages** live under `site/reference/` and
  `site/zh/reference/`. Never hand-edit them.
- **New sidebar entries** go in `site/.vitepress/config.ts` — both
  `sidebarEn()` and `sidebarZh()`. The link checker will fail CI if a sidebar
  link does not resolve to a real `.md` file.
- **Internal links** are root-absolute paths with no `.md` extension
  (`cleanUrls: true`). Example: `/guide/faq`, not `./faq.md`.

## Running tests

```bash
npm test                                 # full vitest suite
npx vitest tests/claude-importer.test.ts # single file
npm run test:watch                       # watch mode
```

Every adapter has a `tests/<adapter>-importer.test.ts`. End-to-end
verification (when touching the daemon or MCP): run `ymesh daemon` in one
terminal, `ymesh mcp call <tool>` in another.

## CI workflows

Two GitHub Actions workflows enforce docs-as-code:

### `.github/workflows/docs-check.yml` (runs on every PR)

Triggered on PRs touching `site/`, `scripts/docs/`, `src/`, `package.json`,
`README.md`, or the workflow itself. Steps:

1. Install root deps + site deps.
2. Build ymesh (so `ymesh help` works during sync).
3. **Check doc drift** — `node scripts/docs/check-drift.mjs` regenerates
   auto-generated pages and fails if any diff vs committed.
4. **Verify internal links** — `node scripts/docs/verify-links.mjs` walks
   every `site/**/*.md` and asserts every internal link resolves.
5. **Build the docs site** — `npm run build --prefix site` catches broken
   VitePress config / frontmatter.

This is the **docs-as-code gate**: code change = doc change in the same PR.

### `.github/workflows/docs-deploy.yml` (runs on `main`)

Triggered on pushes to `main` that touch `site/`, `scripts/docs/`, `src/`,
`package.json`, `README.md`, or the workflow itself. Steps:

1. Same build + sync + verify pipeline as above.
2. Upload the built site as a Pages artifact.
3. Deploy to GitHub Pages (one concurrent deploy; never cancels an in-flight
   deploy to prevent partial publishes).

## Commit style

Conventional Commits, atomic, module-level:

```
feat(cli): add ymesh foo command
fix(daemon): handle EACCES on watched path
docs(site): sync adapter matrix
chore(release): v0.2.0
```

- One logical change per commit. Do not bundle unrelated work.
- `package.json` version bumps go with a `CHANGELOG.md` entry in the same
  commit.
- Tag releases: `git tag v0.Y.Z && git push --tags`.
- `npm publish` is manual (no automated publish workflow yet).

## Pull request process

1. Fork the repo, create a feature branch off `main`.
2. Make your change. Run the doc-sync pipeline and hygiene gates locally.
3. Open a PR against `main`. Fill in the PR template — include evidence that
   `npm test`, `npm run typecheck`, and the real-path exercise all passed.
4. CI runs `docs-check.yml`. All three gates (drift, link, build) must pass.
5. A maintainer reviews. Address feedback by pushing new commits (do not
   force-push unless asked).
6. Once approved and CI is green, a maintainer squashes and merges.

## Internal docs (gitignored)

`docs/` at the repo root is **gitignored** — it contains internal architecture
specs, implementation loops, and acceptance baselines that are not
open-source. Do not commit anything under `docs/`. Public docs go in `site/`
or top-level `*.md` (`README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`,
`CHANGELOG.md`, `SECURITY.md`).

## Security

Read
[SECURITY.md](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md)
before contributing changes that touch sync, the MCP server, the mount
system, or anything that handles session content. Key invariants:

- **Ciphertext only leaves the device.** The sync relay never sees plaintext.
- **No model proxy.** yondermesh never sees API keys.
- **No CLI binary modification.** Mounts write into the CLI's own config
  dir; they never patch the binary or its session writer.
- **Local SQLite is not encrypted at rest.** File permissions are the only
  protection — don't put yondermesh on a shared account.

Report vulnerabilities **privately** via GitHub's "Report a vulnerability"
flow or by emailing the maintainers. Do not open a public issue. Initial
response is within 72 hours. See SECURITY.md for the full disclosure policy.

## License

By contributing, you agree that your contributions are licensed under the MIT
License (see
[LICENSE](https://github.com/GoYonderTogether/yondermesh/blob/main/LICENSE)).

## Related

- [File Layout](/reference/files)
- [Architecture](/guide/architecture)
- [FAQ](/guide/faq)
- [Troubleshooting](/guide/troubleshooting)
- [SECURITY.md](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md)
- [CONTRIBUTING.md](https://github.com/GoYonderTogether/yondermesh/blob/main/CONTRIBUTING.md)
- [AGENTS.md](https://github.com/GoYonderTogether/yondermesh/blob/main/AGENTS.md)
