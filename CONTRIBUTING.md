# Contributing to yondermesh

Thanks for your interest in contributing! This is an open-source project by 未至之境 (Yonder).

## Quick contribution paths

- **Bug reports** → [open an issue](https://github.com/GoYonderTogether/yondermesh/issues/new?labels=bug&template=bug_report.md)
- **Feature requests** → [open an issue](https://github.com/GoYonderTogether/yondermesh/issues/new?labels=enhancement&template=feature_request.md)
- **Security reports** → see [`SECURITY.md`](./SECURITY.md) (do NOT open a public issue for security)
- **Code changes** → fork → branch → PR against `main`

## Development setup

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

## Doc-sync discipline (highest priority: code change = doc change)

> Docs naturally lag behind code. This project treats doc/code sync as a **hard rule**:
> every change must update the corresponding docs in the **same commit**.
> **Doc lag = an unfinished bug.**

Before marking your PR "ready for review":

1. **Re-run the auto-generators** — they regenerate the CLI reference and adapter
   matrix from source:

   ```bash
   npm run sync --prefix site
   git add site/reference/cli.md site/zh/reference/cli.md \
           site/reference/adapters.md site/zh/reference/adapters.md
   ```

2. **Run the hygiene gates** (all must pass):

   ```bash
   node scripts/docs/check-drift.mjs    # regen + assert no diff
   node scripts/docs/verify-links.mjs   # internal links resolve
   npm run build --prefix site          # VitePress builds
   ```

3. **Update hand-written docs** if your change touches:
   - a CLI command's *behavior* (not just its help text) → `site/guide/` or `site/reference/`
   - the data model or session schema → `ARCHITECTURE.md` §II
   - a feature's user-visible behavior → `README.md` and the relevant `site/guide/*.md`
   - the public SDK (`src/index.ts` exports) → `ARCHITECTURE.md` §II

See [`AGENTS.md`](./AGENTS.md) for the full doc-sync table. The canonical
procedure is the `doc-sync` skill at [`skills/doc-sync/SKILL.md`](./skills/doc-sync/SKILL.md).

## Code style

- TypeScript throughout. `npm run typecheck` must pass.
- No external CLI framework in `src/bin/ymesh.ts` — hand-rolled argv parsing is intentional.
- Surgical diffs: every line traces to the task. No drive-by cleanup.
- Verify before "done": `npm test`, `npm run typecheck`, and exercise the real path (CLI / daemon / MCP). Post the evidence in the PR description.

## Tests

- vitest is the test runner. Every adapter has a `tests/<adapter>-importer.test.ts`.
- Run a single test file: `npx vitest tests/claude-importer.test.ts`
- Run with watch: `npm run test:watch`
- End-to-end verification (when touching the daemon or MCP): run `ymesh daemon` in one terminal, `ymesh mcp call <tool>` in another.

## Commit messages

Conventional Commits style:

```
feat(cli): add ymesh foo command
fix(daemon): handle EACCES on watched path
docs(site): sync adapter matrix
chore(release): v0.2.0
```

## Releases

- `package.json` `version` bump → `CHANGELOG.md` entry in the same commit.
- Tag the release: `git tag v0.Y.Z && git push --tags`.
- `npm publish` is manual (no automated publish workflow yet).

## Internal docs (gitignored)

`docs/` at the repo root is **gitignored** — it contains internal architecture
specs, implementation loops, and acceptance baselines that are not open-source.
Do not commit anything under `docs/`. Public docs go in `site/` or top-level
`*.md` (`README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`,
`SECURITY.md`).

## License

By contributing, you agree that your contributions are licensed under the MIT
License (see [`LICENSE`](./LICENSE)).
