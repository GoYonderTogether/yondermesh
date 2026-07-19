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

yondermesh is **self-hosted and local-first**. Today the trust boundary is your
own machine — the daemon makes no outbound calls. Specifically:

- **Local SQLite (`~/.yondermesh/yondermesh.db`)** — stores every harvested session. File permissions are the only protection. Don't put yondermesh on a shared account.
- **Cross-device sync relay (planned — not yet implemented)** — when sync ships, the relay would see only **ciphertext**, with the E2E encryption key living on your devices (`~/.yondermesh/key.pem`) and never reaching the relay. Until then, nothing syncs and no relay is contacted.
- **MCP server** — runs as a stdio child process of an agent (Claude Code, Codex, …). It exposes query tools over the agent's stdin/stdout. It does not listen on any TCP port by default (`port: 0` = stdio).
- **Mount system** — writes into CLI config dirs (`~/.claude/`, `~/.codex/`, `~/.cursor/`, …) to register the ymesh MCP server and skill symlinks. It never modifies the CLI binary or its session writer.
- **No model proxy** — ymesh never sees your API keys. The CLI runs the model; ymesh only reads what the CLI wrote.

## What is NOT in scope

- yondermesh does not authenticate users. Anyone with read access to `~/.yondermesh/` can read every session. Treat the data dir as privileged.
- yondermesh does not encrypt the local SQLite at rest. Use OS-level full-disk encryption (FileVault / BitLocker / LUKS) for sensitive environments.
- The sync relay (planned) is designed as a store-and-forward ciphertext relay. It would not be anonymous: it would see source/destination device ids and message sizes. When sync ships, host the relay behind a privacy proxy if you need metadata protection.

## Disclosure policy

- Acknowledge the report within 72 hours.
- Coordinate a fix and a release date with the reporter.
- Publish a fixed release + a CVE (if applicable) + a CHANGELOG entry describing the issue.
- Public disclosure happens **after** the fixed release is available, typically within 7 days of the fix.
