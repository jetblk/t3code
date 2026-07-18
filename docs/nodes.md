# T3 Code nodes (jetblk fork)

How our nodes run the fork's server instead of upstream's `npx t3@nightly`.

## How it works

```
nightly cron ──► GitHub Actions (nightly-fork.yml)
                   gate: skip unless main gained a non-docs commit
                   stamp version → typecheck + usage tests
                   → build web client + server bundle → dist/client
                   → pnpm deploy (bundle + prod node_modules)
                 └► GitHub Releases (t3-server.tgz, ~125 MB):
                      • `nightly`     rolling — what nodes pull
                      • `v<version>`  immutable — pin/rollback target
                              │
        systemctl --user restart t3code.service  (on any node)
                              │
                   ExecStartPre: curl | tar → ~/.local/share/t3-nightly
                   ExecStart:    node dist/bin.mjs serve --host <tailnet ip> --port 3773
```

**A restart is an update.** There is no separate update command — same contract the old
`npx t3@nightly` line gave us, just sourced from our fork.

**When builds happen.** Every 3 hours, at :37 past the hour (06:37, 09:37, … UTC) — the
same cadence upstream's release.yml uses for its nightly channel, so our builds stay about
as fresh as theirs. A window's merges land in **one** build, not one per PR.

A scheduled run first checks whether `main` gained a commit touching something other than
docs since the last published build; if not, it skips without building — so a quiet window,
or one of nothing but docs, costs a ~10s gate check and burns no version number. **Need a
build sooner?** `gh workflow run nightly-fork.yml --repo jetblk/t3code` skips that gate and
always builds.

`nightly` is still a _channel_ (like an npm dist-tag) as well as a cadence: it is the name of
the rolling release nodes pull, whether it was produced by the cron or by you.

**Each build publishes two releases:**

| Release                  | Purpose                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `nightly` (rolling)      | The stable URL nodes curl. Recreated every build, so its tag tracks the newest commit and the asset name never changes. |
| `v<version>` (immutable) | Never deleted. The pin/rollback target — point a node's `ExecStartPre` at this URL to freeze it on a known-good build.  |

The repo is public, so nodes download the release **unauthenticated**. No tokens, no
registry, no `~/.npmrc`.

The release asset is **self-contained**: `dist/` plus production `node_modules/`,
including the native deps (`node-pty`, sqlite). A node needs no build tooling.
`dist/client` holds the browser UI — the server answers "No static directory configured
and no dev URL set." without it, so the workflow builds `@t3tools/web` and copies it in.

**Everything ships from one commit.** The web client, the server bundle and the version
stamp all come from the same CI run, so a node's browser UI can never drift from its
server. Settings → General → About shows that version.

There is deliberately **no release-channel switcher** in the web UI: it is gated on the
`VITE_HOSTED_APP_CHANNEL` build env, which only upstream's hosted Vercel deploy sets
(to switch between `latest.app.t3.codes` / `nightly.app.t3.codes`). Self-hosted builds
have no channels to switch between — its absence confirms you are on our build.

## Prerequisites

| Requirement                       | Why                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| **linux-x64**                     | The tarball ships natives compiled for it. See gotcha 3.                             |
| **Node ≥ 22.16**                  | Server `engines: ^22.16 \|\| ^23.11 \|\| >=24.10`; the bundle targets `node22.16.0`. |
| **tailscale**, joined             | The unit waits for a tailnet IP and binds it.                                        |
| **curl**, **tar**                 | The update step.                                                                     |
| **systemd user session** + linger | See gotcha 2.                                                                        |

A node needs **none** of: a repo checkout, pnpm/vp, npm/npx, or Node 24. Node 24 is only
needed to _build_ the repo (its dev tooling pins `^24.13.1`); running the server is not building it.

## Bootstrap a new node

```bash
# 1. prerequisites (node >= 22.16, tailscale joined)
node -v && tailscale ip -4

# 2. scratch dir — keeps agent scratch off the /tmp RAM disk (gotcha 1)
mkdir -p ~/.cache/t3-scratch

# 3. install the unit
mkdir -p ~/.config/systemd/user
curl -fsSL https://raw.githubusercontent.com/jetblk/t3code/main/docs/t3code.service \
  -o ~/.config/systemd/user/t3code.service

# 4. let the user unit run headless / at boot (gotcha 2)
loginctl enable-linger "$USER"

# 5. start it (this pulls the current nightly)
systemctl --user daemon-reload
systemctl --user enable --now t3code.service

# 6. verify
journalctl --user -u t3code.service -n 30 --no-pager   # expect: t3 nightly: 0.0.28-jetblk.<date>.<run>
ss -tlnp | grep 3773                                    # bound to the tailnet IP, not 0.0.0.0
```

**Pair a client.** On first start the server prints pairing details to the journal:

```
Listening on http://100.x.y.z:3773
Connection string: http://100.x.y.z:3773
Token: XXXXXXXXXXXX
Pairing URL: http://100.x.y.z:3773/pair#token=XXXXXXXXXXXX
```

Open the Pairing URL (or scan the QR in the journal) from the mobile/desktop client while
on the tailnet. Pairing is stored in `~/.t3/userdata/secrets/` and survives restarts and
upgrades.

## Switch an existing node off `npx t3@nightly`

```bash
# keep a way back
cp ~/.config/systemd/user/t3code.service ~/.config/systemd/user/t3code.service.npx-bak

systemctl --user stop t3code.service
curl -fsSL https://raw.githubusercontent.com/jetblk/t3code/main/docs/t3code.service \
  -o ~/.config/systemd/user/t3code.service
mkdir -p ~/.cache/t3-scratch
systemctl --user daemon-reload
systemctl --user start t3code.service
journalctl --user -u t3code.service -n 30 --no-pager
```

**Existing pairings survive.** The unit passes no `--base-dir`, so the server keeps using
the default `~/.t3` — the same data dir `npx t3@nightly` used. Its `secrets/` (server
signing key) and `state.sqlite` are untouched, so clients reconnect to the _same_ server
identity with no re-pairing.

Nothing in the unit is node-specific: it resolves the tailnet IP itself, so the same file
works on every node.

## Operations

| Task                         | Command                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update to latest nightly     | `systemctl --user restart t3code.service`                                                                                                                             |
| Which build is running       | `cat ~/.local/share/t3-nightly/dist/VERSION`                                                                                                                          |
| Logs (service)               | `journalctl --user -u t3code.service -f`                                                                                                                              |
| Logs (server traces)         | `~/.t3/userdata/logs/server.trace.ndjson*`                                                                                                                            |
| Roll back to upstream        | `cp ~/.config/systemd/user/t3code.service.npx-bak ~/.config/systemd/user/t3code.service && systemctl --user daemon-reload && systemctl --user restart t3code.service` |
| Pin / roll back to a build   | Point the unit's `curl` at an immutable tag: `/download/v<version>/t3-server.tgz` instead of `/download/nightly/`. `gh release list --repo jetblk/t3code` lists them. |
| Freeze entirely (no updates) | Comment out the `curl` `ExecStartPre`; the node then keeps running whatever is in `~/.local/share/t3-nightly`.                                                        |
| Build without a code change  | `gh workflow run nightly-fork.yml --repo jetblk/t3code`                                                                                                               |

## Gotchas

These are all load-bearing — each one cost us an outage or an hour.

1. **`/tmp` is a small RAM disk** (tmpfs, ~half of RAM), not real disk. The
   `Environment=TMPDIR/TMP/TEMP=%h/.cache/t3-scratch` lines exist because an agent ran
   `pnpm install` under `/tmp`, put a 2.4 GB pnpm store on the RAM disk, filled it, broke
   the shell, and crashed the server. **Never checkout or install under `/tmp`** on these
   boxes, and don't drop those env lines. The update step extracts to `~/.local/share` for
   the same reason.
2. **`loginctl enable-linger`** — without it a systemd _user_ unit stops at logout and does
   not start at boot. Easy to miss on a fresh node; the node looks fine until you log out.
3. **linux-x64 only.** The tarball contains natives (`node-pty`, sqlite) compiled on the
   CI runner. A macOS or arm64 node needs its own build (add a matrix to
   `nightly-fork.yml`) — the current single artifact will not run there.
4. **Runtime Node ≠ build Node.** The server runs on ≥ 22.16; only building the repo needs
   Node 24. Don't install Node 24 on a node just to run the server.
5. **The update is best-effort.** `ExecStartPre=-` (leading dash) means a failed download is
   ignored, so a node with no GitHub reachability still boots on its last-good install
   rather than refusing to start. Check the journal for `t3 nightly: <version>` to confirm
   an update actually landed.
6. **Desktop client shows "Client and server versions differ."** Expected and cosmetic. Our
   builds report `0.0.28-jetblk.<date>.<run>`; upstream's auto-updating desktop client
   reports `0.0.29-nightly.<...>`, and the check is an exact string compare. The RPC
   contract is what matters, and it is in sync as long as `main` is merged with upstream.
   Upstream never commits nightly versions (only stable ones), which is why a source build
   otherwise reports the last stable forever.
7. **This node no longer runs your working tree.** Once switched, the server runs the
   published release, not `~/workspace/t3code`. Local rebuilds have no effect until pushed
   and released. That is the point (every node runs the same reproducible build), but it is
   a mental-model shift if you are used to `node apps/server/dist/bin.mjs`.
8. **Merging is not releasing.** Since builds went on a cron, a merge to `main` publishes
   nothing on its own — restart a node right after merging and you will still get the last
   published build, with no error to tell you why. The next scheduled check (≤3 h out) will
   pick it up; to get it onto a node sooner, dispatch a build
   (`gh workflow run nightly-fork.yml --repo jetblk/t3code`), wait for it to publish, then
   restart. `cat ~/.local/share/t3-nightly/dist/VERSION` tells you which build you actually
   have.

## Fork CI notes

- Only `nightly-fork.yml` is enabled. All 8 workflows inherited from upstream are
  `disabled_manually` — they need pingdotgg's `blacksmith-*` runners and secrets, and would
  queue forever on every push. Disabling is a repo setting, so upstream merges don't
  re-enable them.
- The nightly gates on typecheck + the provider-usage tests only. The full server suite has
  pre-existing ACP-transport failures unrelated to this fork; gating on it would block every
  release.
