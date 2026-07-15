---
title: Skills System
description: yondermesh ships markdown-defined skills that extend what an agent can do — shipped in the repo, symlinked into each CLI's own skill directory by the mount system.
outline: [2, 3]
---

# Skills System

A **skill** is a markdown-defined capability bundle that extends what an agent can do without modifying the agent itself. yondermesh ships a handful of skills in the `skills/` directory of the repo and, at mount time, symlinks each one into every supported CLI's own skill directory. The agent then discovers the skill the same way it discovers any of its native skills — ymesh just places the link.

The mount strategy that does this is `skill-symlink`, implemented in `src/mount/strategies.ts` and declared per-CLI in `src/mount/registry.ts`. It is one of the three extension types the [Mount System](/guide/mount) installs (alongside MCP server config and always-on paragraphs).

## What a skill is

A skill is a directory containing at minimum a `SKILL.md` file. The markdown frontmatter declares the skill's `name` and `description` and is what the host CLI reads to decide when to surface the skill to the agent. The body of `SKILL.md` is the instruction set the agent loads when the skill is activated — it can reference additional files in the same directory (scripts, references, sub-configs).

A skill is **not** a plugin binary and **not** an MCP tool. It is a pure-text instruction bundle. The host CLI decides how to consume it; ymesh only ensures the directory is reachable from the CLI's skill lookup path.

## Where ymesh skills live

Shipping skills live in the repo at `skills/<name>/`:

```text
skills/
  doc-sync/
    SKILL.md
  new-cli-onboarding/
    SKILL.md
  trae-awareness/
    SKILL.md
  yondermesh-diagnose/
    SKILL.md
    agents/
      openai.yaml
    references/
      healthy-state.md
      known-issues.md
    scripts/
      diagnose.sh
```

When ymesh is installed, `buildRelease()` copies the `skills/` directory into the versioned release dir under `~/.yondermesh/releases/<version>/skills/`. The `~/.yondermesh/bin/ymesh` symlink points at the current release, so `releases/current/skills/<name>/` always reflects the active version. Skills update automatically when you run `ymesh update` and the `current` symlink flips to the new release.

## How skill linking works

There are two code paths that link skills into a CLI's skill directory. They use the same mechanism (a symlink pointing at the release's `skills/<name>/`) but are invoked at different times.

### Mount-time linking (`src/mount/strategies.ts`)

The `skillSymlinkStrategy` is what `ymesh mount all` uses. For each CLI in the registry that declares a `skill-symlink` capability, ymesh:

1. Resolves the CLI's skill directory from the registry (for example `~/.codex/skills/`, `~/.cursor/skills/`, `~/.trae/skills/`).
2. Creates the directory if it does not exist.
3. For each ymesh skill in `defaultExtensions()`, removes any existing symlink at `<skillsDir>/<name>` (regardless of where it pointed) and creates a fresh symlink to `releases/current/skills/<name>`.

The strategy verifies a symlink is genuinely a ymesh mount by checking that the link target contains `yondermesh`, `ymesh`, or `release` — this prevents a same-named symlink created by another tool (for example a marketplace) from being misreported as a ymesh mount.

`isMounted()` returns true only when the symlink exists, is a symbolic link, and points back into a ymesh release path. `unmount()` removes the symlink and is a no-op if the link is absent.

### Install-time linking (`src/install/skill-linker.ts`)

`linkSkills()` / `unlinkSkills()` is the older install-time helper that the release installer calls. It links the bundled skill set (currently `yondermesh-diagnose`) into a small fixed list of CLI skill directories. The mount system's `skill-symlink` strategy is the comprehensive path — it covers every CLI the registry declares — so for day-to-day use prefer `ymesh mount all`.

## Which CLIs support skill mounting

The CLI coverage table (from `src/mount/registry.ts`) lists every CLI that declares a `skill-symlink` capability. The primary supported CLIs are:

| CLI | Skill directory |
|---|---|
| Codex | `~/.codex/skills/` |
| Cursor | `~/.cursor/skills/` |
| Windsurf | `~/.codeium/windsurf/skills/` |
| Trae (international) | `~/.trae/skills/` |
| Trae CN (Chinese) | `~/.trae-cn/skills/` |
| Continue | `~/.continue/skills/` |

Additional CLIs in the registry (Factory, Vibe, CodeBuddy, Copilot, Pi / OMP / GSD-Pi, OpenHands, Goose, Crush, Cline, Antigravity, Amp, and the IDE-shared variants) also declare `skill-symlink` capabilities. The full live matrix is regenerated on the [CLI Adapters](/reference/adapters) page.

Claude Code does **not** support skill mounting through a skills directory — it has no file-based skill lookup. ymesh reaches Claude Code via the always-on paragraph and the MCP server instead.

## Shipping skills

The skills that ship in the repo and get linked into every supported CLI:

- **`yondermesh-diagnose`** — system health checks. Walks the ymesh install, database, daemon, and logs, and reports what is healthy and what is not. The default mount set always includes this skill so any agent can run a diagnose on request.
- **`trae-awareness`** — a signpost skill that tells a Trae session ymesh exists and what it can do. Trae does not read global instruction files (no always-on injection point), so this skill is the substitute: Trae sees ymesh in its skill list at session start. The default mount set includes this skill specifically for the Trae targets.
- **`doc-sync`** — keeps documentation in sync with code. Used by the docs generator workflow.
- **`new-cli-onboarding`** — guided workflow for onboarding a new CLI adapter into ymesh.

The first two are pushed by `defaultExtensions()` in `src/mount/manager.ts`; the latter two ship in the repo and are available for explicit linking or for agents to read directly.

## Adding a custom skill

To ship your own skill:

1. Create a directory `skills/<your-skill-name>/` containing a `SKILL.md`. The frontmatter must declare `name` and `description`.

   ```markdown
   ---
   name: my-team-conventions
   description: Use when writing code in the monorepo — covers naming, test layout, and review checklist.
   ---

   # My Team Conventions

   ...
   ```

2. Optionally add subdirectories (`scripts/`, `references/`, `agents/`) with supporting files that `SKILL.md` references.

3. Re-run the mount step so the new skill is symlinked everywhere:

   ```bash
   ymesh mount all
   ```

The `defaultExtensions()` list in `src/mount/manager.ts` controls which skills the mount system links automatically. Skills that ship in `skills/` but are not in that list are still available — agents can read them directly from the release directory, or you can symlink them by hand into the CLI's skill dir.

Because skills are plain markdown, you can version them in the same repo as your code, review them in pull requests, and roll them forward or back together with a ymesh release.

## Related

- [Mount System](/guide/mount) — how ymesh installs extensions into each CLI's config dir.
- [MCP Server](/guide/mcp) — the other way ymesh exposes capabilities to agents.
- [File Layout](/reference/files) — where skills live on disk after install.
- [CLI Adapters](/reference/adapters) — full live matrix of which CLIs support which extension types.
