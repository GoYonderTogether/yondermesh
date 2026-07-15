# Security Policy

## Reporting a vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, report privately:

1. Open a private security advisory via GitHub: **Security tab → Report a vulnerability**, or
2. Email the maintainers directly (see the repo's `package.json` `author` field for the project's GitHub org).

You should receive an initial response within 72 hours. Please provide:
- A clear description of the issue and its impact.
- Reproduction steps (a minimal CLI invocation or a small repo is ideal).
- Affected versions, if known.
- Any suggested mitigations.

We credit reporters in the release notes that ships the fix, unless you prefer otherwise.

## Threat model (summary)

yondermesh is **self-hosted and local-first**. The trust boundary is your own
machine + your own self-hosted relay. Specifically:

- **Local SQLite (`~/.yondermesh/yondermesh.db`)** — stores every harvested session. File permissions are the only protection. Don't put yondermesh on a shared account.
- **Cross-device sync relay** — sees only **ciphertext**. The E2E encryption key lives on your devices (`~/.yondermesh/key.pem`); the relay never has it. If you run the official cloud relay as a convenience, the same holds: it cannot read your sessions.
- **MCP server** — runs as a stdio child process of an agent (Claude Code, Codex, …). It exposes query tools over the agent's stdin/stdout. It does not listen on any TCP port by default (`port: 0` = stdio).
- **Mount system** — writes into CLI config dirs (`~/.claude/`, `~/.codex/`, `~/.cursor/`, …) to register the ymesh MCP server and skill symlinks. It never modifies the CLI binary or its session writer.
- **No model proxy** — ymesh never sees your API keys. The CLI runs the model; ymesh only reads what the CLI wrote.

## What is NOT in scope

- yondermesh does not authenticate users. Anyone with read access to `~/.yondermesh/` can read every session. Treat the data dir as privileged.
- yondermesh does not encrypt the local SQLite at rest. Use OS-level full-disk encryption (FileVault / BitLocker / LUKS) for sensitive environments.
- The sync relay is a store-and-forward ciphertext relay. It is not anonymous: it sees source/destination device ids and message sizes. If you need metadata protection, host the relay behind a privacy proxy.

## Disclosure policy

- Acknowledge the report within 72 hours.
- Coordinate a fix and a release date with the reporter.
- Publish a fixed release + a CVE (if applicable) + a CHANGELOG entry describing the issue.
- Public disclosure happens **after** the fixed release is available, typically within 7 days of the fix.
