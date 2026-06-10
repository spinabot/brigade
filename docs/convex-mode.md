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

# 3. Generate your encryption key — credentials are AES-256-GCM sealed
#    with this BEFORE they leave the process; Convex never sees plaintext
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$env:BRIGADE_ENCRYPTION_KEY = "<the 64-char hex from above>"
# Persist it for future shells (System Properties → Environment Variables,
# or your daemon unit). Losing this key = losing access to sealed secrets.

# 4. Start the self-hosted Convex backend
npm run convex:dev     # boots the local backend + pushes convex/ functions

# 5. Point Brigade at it + onboard
$env:BRIGADE_CONVEX_URL = "http://127.0.0.1:3210"
brigade store mode set convex
brigade onboard        # provider + key (key lands SEALED in authProfiles)

# 6. Run
brigade gateway run    # or just: brigade
```

WhatsApp: re-link once (`brigade channels link whatsapp`) — signal keys now
live sealed in Convex; the old on-disk auth dir is not migrated by design.

## Verifying strict-zero

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
