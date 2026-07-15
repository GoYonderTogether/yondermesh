---
title: Cross-device Sync
description: yondermesh syncs sessions across your devices through a self-hosted relay, with ciphertext only ever leaving the device. Learn how it works, how to configure it, and the privacy model.
outline: [2, 3]
---

# Cross-device Sync

Your AI coding agents span multiple machines — a laptop, a desktop, a work VM. Context should follow. yondermesh syncs sessions across your devices through a self-hosted relay, with ciphertext only ever leaving the device.

## Why sync

Without sync, each device is an island. A session you ran on your laptop is invisible to the daemon on your desktop; an agent on the desktop cannot recall what an agent on the laptop did yesterday. Sync closes that gap: every device's local SQLite store eventually converges with the others, so any agent on any device can query any other agent's context via the same MCP tools.

Sync is opt-in. If you only ever run agents on one machine, leave it disabled and yondermesh works as a purely local tool.

## How it works

The sync agent (`src/sync/agent.ts`, class `SyncAgent`) runs a periodic push/pull loop on top of the local `SessionStore`:

```text
local SessionStore → encrypt with local key → POST ciphertext to self-hosted relay
                                                                       │
self-hosted relay → GET peer ciphertext → decrypt with local key → upsert into local SessionStore
```

1. The agent queries the local store for sessions not yet pushed (those with `sync_state = 'local'`).
2. Each session's content is encrypted with the local key.
3. The ciphertext is POSTed to the relay URL.
4. The agent GETs ciphertext that peer devices have pushed.
5. The ciphertext is decrypted with the local key and upserted into the local store.
6. The `sync_state` column on synced sessions is updated.

The loop runs every 60 seconds by default, with an immediate sync on `start()`. If `relayUrl` is not configured, the agent logs a warning and skips — sync is disabled but the rest of yondermesh is unaffected.

## The invariant: ciphertext only leaves the device

This is the core privacy invariant, stated in `src/sync/agent.ts`:

> 代码离开设备前永远是密文。
> (Code leaving the device is always ciphertext.)

The relay is a dumb pipe. It stores and forwards opaque blobs. It never sees plaintext, never sees keys, and cannot decrypt anything it carries. If the relay is compromised, an attacker gets ciphertext only.

This is why yondermesh has **no model proxy** (invariant 2 in [Architecture](/guide/architecture)) — the relay does not need to understand session content to forward it, and yondermesh never touches your API keys.

## Self-hosted relay setup

The relay is a relay, not a cloud. You run it.

- **Self-hosted** — deploy the relay on any host you control (a VPS, a home server, a Tailscale node). Point each device's `sync.relay_url` at it. The relay only needs to store and forward opaque ciphertext blobs; it does not need a database of plaintext.
- **Cloud relay (optional convenience)** — a hosted relay may be offered for convenience, but it is never a trusted party. It sees the same ciphertext a self-hosted relay would. You can switch between self-hosted and cloud at any time by changing `relay_url`; no data migration is required because the relay holds no plaintext state.

Because the relay carries ciphertext only, you do not need to trust the relay operator. The security boundary is your local key, not the relay.

## Key management

Each device has a local keypair stored at `~/.yondermesh/key.pem`. The key is auto-generated on first run if it does not exist.

- The key never leaves the device.
- The key is never sent to the relay.
- Losing the key means losing the ability to decrypt sessions synced from that device — back it up.

For devices to read each other's sessions, they need to share keys (or use a pre-shared key approach). Pairing is covered below.

## Configuring sync

Sync is configured in `~/.yondermesh/config.yaml` under the `sync` key (see `examples/config.yaml`):

```yaml
sync:
  enabled: false                    # set to true to enable
  relay_url: https://relay.your-domain.com
  key_file: ~/.yondermesh/key.pem   # auto-generated on first run
```

| Field | Default | Meaning |
|---|---|---|
| `sync.enabled` | `false` | Master switch for the sync agent. |
| `sync.relay_url` | — | URL of the self-hosted (or cloud) relay. Required when `enabled: true`. |
| `sync.key_file` | `~/.yondermesh/key.pem` | Path to the local encryption key. Auto-generated if absent. |

The `SyncAgent` constructor (in `src/sync/agent.ts`) takes `{ enabled, relayUrl, keyFile }`. If `enabled` is true but `relayUrl` is unset, the agent logs a warning and skips — it does not crash.

See [Configuration](/reference/config) for the full config schema.

## Pairing devices

Pairing is the step where two devices agree to sync with each other through a shared relay. At the protocol level, pairing boils down to: both devices point at the same `relay_url`, and both devices can decrypt what the other pushes.

Because the relay is a dumb ciphertext pipe, the practical pairing flow is:

1. Stand up a relay and note its URL.
2. On device A, set `sync.relay_url` to the relay URL and enable sync. The local key is generated at `~/.yondermesh/key.pem`.
3. On device B, do the same. Device B generates its own key.
4. Arrange key sharing so each device can decrypt the other's ciphertext (e.g. copy device A's key to device B, or use a pre-shared key placed on both).

Once both devices are pushing and pulling from the same relay with compatible keys, sessions converge automatically.

## Privacy model

yondermesh's privacy model follows directly from the invariants in [Architecture](/guide/architecture):

- **No model proxy.** yondermesh never touches your API keys. The CLI runs the model; yondermesh only reads what the CLI wrote and forwards ciphertext.
- **No plaintext on the relay.** The relay stores and forwards opaque blobs. It cannot decrypt anything it carries, and compromising it yields ciphertext only.
- **No cloud lock-in.** The relay is self-hostable. A cloud relay is optional convenience and sees the same ciphertext a self-hosted relay would. Switching relays is a `relay_url` change, not a data migration.
- **Keys stay local.** The encryption key at `~/.yondermesh/key.pem` never leaves the device and never goes to the relay.

The combination means the trust boundary is your device, not any third party. You do not need to trust the relay operator, the cloud provider hosting the relay, or yondermesh itself as a service — because yondermesh is not a service, it is software running on your devices.

## Related

- [Architecture](/guide/architecture) — the three planes and the invariants that govern sync.
- [Configuration](/reference/config) — the full `~/.yondermesh/config.yaml` schema.
- [Daemon](/guide/daemon) — the daemon whose store the sync agent reads from and writes to.
