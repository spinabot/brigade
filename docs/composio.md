# Connecting your apps (Composio)

Brigade can connect to **1,000+ external apps** — Gmail, Slack, GitHub, Notion, Google
Calendar, Linear, HubSpot, Jira, and many more — and act on them on your behalf
(read your email, post to Slack, open a GitHub issue, add a calendar event, …).

This works through **Composio** (composio.dev), a service that handles the sign-in
(OAuth) and the per-app plumbing. You bring **one** Composio API key; after that you
just ask your crew in plain language — *"connect my Gmail"*, *"send a Slack message to
#team"* — and Brigade does the rest.

---

## Step 1 — Get your Composio API key

> ⚠️ **The one thing people get wrong.** The Composio dashboard has **two modes**,
> shown as a toggle in the top‑left next to the logo:
>
> | Mode | What it's for | Use it for Brigade? |
> |------|---------------|---------------------|
> | **PLATFORM** | "Build and manage AI agents with the Composio SDK" | ✅ **Yes — this is the key Brigade needs** |
> | **FOR YOU** | "Connect apps to AI clients like Claude, Cursor, ChatGPT" | ❌ No — this gives a different key (for desktop AI apps) that Brigade can't use |
>
> Brigade is built on the Composio **SDK**, so it needs a **PLATFORM** key. The
> **FOR YOU** section hands out a consumer key (starts with `ck_`) for plugging apps
> into Claude/Cursor/ChatGPT — it will be **rejected** by Brigade. A PLATFORM key
> starts with `ak_`.

1. Go to **[dashboard.composio.dev](https://dashboard.composio.dev)** and sign in.
2. In the top‑left, make sure the mode toggle is set to **PLATFORM** (not FOR YOU).
3. Open **Settings → API Keys** and copy your key (it looks like `ak_…`).

That's the only thing you need from the dashboard for everyday use.

---

## Step 2 — Give the key to Brigade

Just tell your crew, in any channel:

> *"Here's my Composio key: `ak_…`"* — or — *"set my Composio key to `ak_…`"*

Brigade verifies the key with Composio and stores it **privately and encrypted** — it
is never shown back to you or written into chat logs. You only do this once.

If the key is wrong, Brigade tells you immediately (*"that key was rejected"*) rather
than failing later — so you'll know right away if you grabbed a FOR YOU key by mistake.

---

## Step 3 — Connect an app

Ask for whatever you want to hook up:

> *"Connect my Gmail."*  *"Hook up Slack."*  *"Connect GitHub."*

Brigade replies with a **secure sign‑in link**. Click it, approve access in the normal
provider screen (Google, Slack, GitHub, …), and you're connected. Ask
*"is it connected yet?"* any time to check.

Not sure what's available? Ask *"what apps can I connect?"* (optionally *"…to do with
calendars?"*). The list is pulled live from Composio, so apps Composio adds later show
up automatically — nothing is hard‑coded.

---

## Step 4 — Use it

Once an app is connected, just ask:

> *"Email Sarah the Q3 numbers."*  *"Post the release notes to #announcements."*
> *"Open a GitHub issue titled 'Login bug' in acme/web."*  *"What's on my calendar tomorrow?"*

Brigade finds the right action and runs it.

---

## Apps that need your own sign‑in credentials

Composio hosts the sign‑in for most apps, so they connect with zero setup. A few apps
(and some on certain plans) require **your own OAuth credentials** instead. If you hit
one, Brigade will tell you, and the fix is a one‑time setup in the dashboard:

1. In **[dashboard.composio.dev](https://dashboard.composio.dev)** (PLATFORM mode),
   open **Toolkits**, search for the app, and **Add to project**.
2. When prompted, either use Composio's default integration if offered, or paste in
   OAuth credentials you create on that app's developer site (the dashboard tells you
   the exact redirect URL to use).
3. Once the app shows as added, ask Brigade to *"connect it"* again — you'll get the
   normal sign‑in link.

---

## Security & privacy

- Your Composio API key is **encrypted at rest** and kept private to your Brigade — it
  is never echoed back, logged, or sent to the model.
- Connecting apps and acting on your accounts is **owner‑only**: only you (the operator)
  can ask Brigade to connect apps or run actions on them.
- App access lives in **your** Composio account — you can review or revoke any
  connection from the Composio dashboard at any time.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| *"That key was rejected"* | You used a **FOR YOU** key (`ck_…`) or mistyped/truncated the key | Get a **PLATFORM** key (`ak_…`) from dashboard.composio.dev → PLATFORM → Settings → API Keys |
| *"No Composio API key is set"* | Key not provided yet | Tell Brigade *"set my Composio key to `ak_…`"* |
| *"Composio doesn't host a managed sign‑in for X"* | That app needs your own OAuth credentials | Add the app in the dashboard (see *Apps that need your own sign‑in credentials* above), then connect again |
| The connect link doesn't activate | You haven't finished the sign‑in in the browser | Click the link, approve access, then ask *"is it connected yet?"* |

---

*For operators / developers:* the integration is the always‑on, owner‑gated `composio`
tool (`src/agents/tools/composio-tool.ts`). The key resolves from the sealed credential
store first, then `tools.composio.apiKey` in config, then the `COMPOSIO_API_KEY`
environment variable; the connecting user id can be set via `tools.composio.userId`
(defaults to `brigade-owner`).
