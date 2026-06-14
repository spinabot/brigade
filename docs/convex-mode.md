# Convex mode — operator runbook

Brigade runs in one of two storage modes. **Filesystem mode** (default) keeps
everything under `~/.brigade/` exactly as always. **Convex mode** moves all
Brigade state into a Convex deployment — self-hosted on your machine or
Convex Cloud — with credentials encrypted before they ever leave the process.

## What lives where in convex mode

| State | Home |
|---|---|
| Config (brigade.json + backups + audit + health) | Convex tables |
| Auth profiles (API keys — **sealed with your key**), auth/profile state | Convex tables |
| Session index + **full conversation transcripts** | Convex tables |
| Exec approvals, channel allow-lists + pairing codes | Convex tables |
| Cron jobs + run history | Convex tables |
| Memory facts + dream cursors | Convex tables |
| Pi event log + subsystem log | Convex tables (batched) |
| Provider catalog (models.json) | Sealed blob + OS-cache mirror |
| **WhatsApp Baileys auth** (creds + all signal keys) | Convex tables (sealed) |
| Channel media (inbound + sent) | Local cache hot path + **background Convex mirror** |
| Workspace (persona MDs, **git repo**, agent working files) | **Local** (your choice) + persona/state mirror in Convex with restore-on-missing |
| Gateway lock / browser profile / org charts / temps | OS cache dir (`%LOCALAPPDATA%\Brigade\…`), never `~/.brigade` |
| `mode.sentinel` | The ONE bootstrap file under `~/.brigade` |

`rm -rf ~/.brigade` in convex mode loses: workspace git history + scratch
files (personas restore from Convex on next boot) and nothing else.

## Fresh start (recommended for first switch)

```powershell
# 1. Stop everything
brigade gateway stop

# 2. (You said you don't need current data) wipe the old state
Remove-Item -Recurse -Force ~/.brigade

# 3. Start the self-hosted Convex backend
npm run convex:dev     # boots the local backend + pushes convex/ functions

# 4. Point Brigade at it + onboard
$env:BRIGADE_CONVEX_URL = "http://127.0.0.1:3210"
brigade store mode set convex   # auto-creates your encryption key (see below)
brigade onboard        # provider + key (key lands SEALED in authProfiles)

# 5. Run
brigade gateway run    # or just: brigade
```

**Encryption key — automatic.** Credentials are AES-256-GCM sealed BEFORE
they leave the process; Convex never sees plaintext. On your first convex
setup (`store mode set convex` or the onboard wizard's convex choice) Brigade
generates a key, prints it ONCE (save it in your password manager), and
stores it at the OS config location — `%LOCALAPPDATA%\Brigade\encryption.key`
on Windows, `~/Library/Application Support/brigade/` on macOS,
`~/.config/brigade/` on Linux — deliberately OUTSIDE `~/.brigade` so the
wipe-and-restore flow can't destroy it. Resolution order:
`BRIGADE_ENCRYPTION_KEY` env var (always wins) → key file → off.
Check with `brigade encrypt status` (shows the active source).

**Restore vs fresh.** Wiping `~/.brigade` is RESTORE — the next boot brings
everything back from Convex (the onboard wizard also detects an existing
Brigade in the backend and asks "Restore / Start fresh"). A true fresh start
is `brigade store reset` — it permanently erases every backend record,
removes the mode pin, and sets the old key file aside as a `.bak` (never
deleted) so the next onboard mints a new key.

WhatsApp: re-link once (`brigade channels link whatsapp`) — signal keys now
live sealed in Convex; the old on-disk auth dir is not migrated by design.
After that, even a full `~/.brigade` wipe reconnects WITHOUT a new QR scan.

## Verifying strict-zero

Automated end-to-end check (run while the backend is up, after onboard):

```powershell
npm run smoke:strict-zero
# PASS = every domain round-trips through Convex AND ~/.brigade stayed clean
```


The guard is on by default in convex mode (`BRIGADE_STRICT_MODE=warn`):
every write targeting `~/.brigade/` outside the allowlist (sentinel +
workspace) is logged loudly with a stack. Flip to hard enforcement once a
session runs clean:

```powershell
$env:BRIGADE_STRICT_MODE = "enforce"   # violations now THROW
```

Watch for `STRICT-ZERO VIOLATION` lines in the gateway output; none should
appear in normal operation.

## Mode switching

- `brigade store mode show` — current mode
- `brigade store mode set filesystem` — back to files (works even when the
  Convex backend is down; diagnostic commands never require the backend)
- The sentinel pins the choice; `BRIGADE_MODE` env overrides for one-shot
  diagnostics (`BRIGADE_FORCE_MODE=1` to bypass the mismatch refusal).

## Key rotation

```powershell
$env:BRIGADE_ENCRYPTION_KEY_OLD = $env:BRIGADE_ENCRYPTION_KEY
$env:BRIGADE_ENCRYPTION_KEY = "<new 64-char hex>"
# Reads try the new key first, then the old — rotate at leisure, then
# drop the OLD var once everything has been re-sealed.
```

## Latency posture

- Reads on hot paths (config, sessions index, approvals gate, memory,
  Baileys signal keys) are served from in-process caches hydrated in one
  parallel round at boot — per-turn cost is unchanged from filesystem mode.
- Writes prime the cache synchronously (the next read sees them
  immediately) and flush to Convex on ordered background chains; the
  gateway drains every chain on shutdown.
- Media sends stream from local disk (zero added latency); the Convex copy
  uploads in the background.
- Transcripts batch (50 records / 250 ms) and drain at each turn end.
