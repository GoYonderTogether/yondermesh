---
title: Installation
description: Install yondermesh via npm, build from source, manage releases, run it as a LaunchAgent service on macOS, and verify or uninstall the installation.
outline: [2, 3]
---

# Installation

yondermesh ships as a single `ymesh` CLI. There are three ways to get it onto
your machine: install from npm, build from source, or update an existing clone.
All three end with the same `ymesh` binary on your `PATH`.

## System requirements

- **Node.js 20 or later** (`>=20.0.0`). Check with `node --version`.
- **macOS, Linux, or WSL.** The daemon watches filesystem events and writes to
  a local SQLite database. Native Windows is not yet supported; use WSL.
- **Write access to `~/.yondermesh/`** (or wherever you point `YONDERMESH_HOME`).
  The daemon creates this directory on first run.
- **At least one CLI agent already installed** if you want yondermesh to harvest
  real sessions. See the [CLI Adapters reference](/reference/adapters) for the
  full list.

## Option A: npm global install

The simplest path. Install the published package globally:

```bash
npm install -g yondermesh
```

Verify the binary is on your `PATH`:

```bash
ymesh version
```

This gives you the latest released version. To upgrade later, re-run the same
command, or use the in-place update mechanism described in
[Option C](#option-c-ymesh-update-local-from-a-clone) if you switch to a source
clone.

## Option B: build from source

Use this if you want to run a pre-release, contribute patches, or keep a local
checkout.

```bash
git clone https://github.com/GoYonderTogether/yondermesh.git
cd yondermesh
npm install
npm run build
```

Then install the built release into `~/.yondermesh/`:

```bash
ymesh install
```

`ymesh install` compiles the TypeScript source (if needed), bundles it into a
versioned release directory under `~/.yondermesh/releases/<version>/`, and
creates (or updates) the `~/.yondermesh/bin/ymesh` symlink that points to the
current release. Add `~/.yondermesh/bin` to your `PATH`, or symlink
`~/.yondermesh/bin/ymesh` into a directory that is already on your `PATH`.

Verify:

```bash
ymesh version
ymesh doctor
```

## Option C: `ymesh update --local` from a clone

Once you have a source clone (from Option B), you can pull the latest changes and
rebuild in place without re-cloning:

```bash
cd yondermesh
git pull
ymesh update --local
```

The `--local` flag tells yondermesh to skip the clone step and build from the
current directory. The update flow is: build -> install -> atomic symlink swap ->
auto-rollback on failure. If the build fails, the symlink is left pointing at
the previous good release, so your running daemon is not disrupted.

To update from a remote Git source instead (clone or pull, then build):

```bash
ymesh update
```

## Release management

Every `ymesh install` and `ymesh update` creates a versioned release under
`~/.yondermesh/releases/<version>/`. The active release is the one the
`~/.yondermesh/bin/ymesh` symlink points to.

List every installed release:

```bash
ymesh releases
```

Manually roll back to the previous release (useful if a new release introduces a
regression and the automatic rollback did not trigger because the build itself
succeeded):

```bash
ymesh rollback
```

There is no separate `ymesh pin` command; to pin a specific version, point the
symlink yourself or run `ymesh install` from the source checkout of the version
you want.

## LaunchAgent service (macOS only)

On macOS you can run the daemon as a LaunchAgent so it starts on login and
restarts on crash. yondermesh manages the plist for you:

```bash
ymesh service install     # install the LaunchAgent plist
ymesh service start       # start the daemon via launchctl
ymesh service stop        # stop the daemon
ymesh service status      # check whether the daemon is running
ymesh service uninstall   # remove the LaunchAgent plist
```

The plist lives under `~/Library/LaunchAgents/` and points the daemon at the
default data directory (`~/.yondermesh/`). If you override `YONDERMESH_HOME`,
make sure the LaunchAgent environment matches.

::: tip
The LaunchAgent integration is macOS-only. On Linux, use a systemd user unit or
a process manager of your choice; the daemon itself is just a long-running
process invoked by `ymesh daemon`.
:::

## Verify the installation

Run the doctor command to check installation health, database connectivity,
daemon status, and log health in one pass:

```bash
ymesh doctor
```

Check the version:

```bash
ymesh version
```

Check the daemon status and the most recent scan results:

```bash
ymesh status
```

If `ymesh doctor` reports no issues, you are ready to follow the
[Quickstart](/guide/quickstart).

## Uninstall

There is no single `ymesh uninstall` command. To fully remove yondermesh:

1. Stop and remove the LaunchAgent if you installed it:

   ```bash
   ymesh service stop
   ymesh service uninstall
   ```

2. Remove the data directory (this deletes the SQLite database, all release
   builds, the symlink, and any briefings):

   ```bash
   rm -rf ~/.yondermesh
   ```

3. If you installed via npm, remove the global package:

   ```bash
   npm uninstall -g yondermesh
   ```

4. If you mounted yondermesh into any CLIs, clean up the mounts so the CLIs do
   not keep referencing a missing MCP server:

   ```bash
   ymesh mount remove
   ```

   Run this before deleting `~/.yondermesh/`, since `ymesh mount remove` needs
   the binary to be available.

::: warning
Removing `~/.yondermesh/` deletes all harvested sessions stored locally.
Cross-device synced copies on other machines are not affected, but this
machine's local copy is gone for good. Back up the database first if you might
need it.
:::

## Next steps

- [Quickstart](/guide/quickstart) — start the daemon and connect an agent.
- [CLI Commands](/reference/cli) — the full command reference.
- [Architecture](/guide/architecture) — how the daemon, store, MCP server, and
  sync agent fit together.
