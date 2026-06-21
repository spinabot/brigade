# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/spinabot/brigade/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab).

We aim to acknowledge reports within 5 business days and to provide a remediation
timeline after triage. Please give us reasonable time to investigate and patch before
any public disclosure.

### Required in reports

For the fastest triage, include all of the following:

1. **Title**
2. **Severity assessment**
3. **Impact**
4. **Affected component** — file / function / line on a current revision
5. **Technical reproduction** — a proof-of-concept against the latest `main` or the
   latest published release
6. **Demonstrated impact** — tied to a documented trust boundary below
7. **Environment** — Brigade version and/or commit SHA, OS, and Node version
8. **Remediation advice**

Reports without reproduction steps, demonstrated impact, and remediation advice will
be deprioritized. Given the volume of AI-generated scanner findings, we prioritize
vetted reports from researchers who understand the issue.

## Supported versions

Brigade is pre-1.0 and ships from `main`; fixes land on the latest published release.
Please run the most recent version before reporting.

## Operator trust model (important)

Brigade is a **single-operator** personal AI crew — not a multi-tenant, adversarial-user
platform.

- Authenticated gateway callers are treated as **trusted operators** for that gateway
  instance. The gateway binds to `127.0.0.1` by default; clients pair via an Ed25519
  handshake.
- Session identifiers (`sessionKey`, session ids) are **routing controls, not per-user
  authorization boundaries**.
- If two people can message the same tool-enabled agent (e.g. a shared group chat),
  they can both steer it within its granted permissions. Non-owner sender status only
  affects **owner-only** tools and commands.
- Anyone who can modify `~/.brigade/` state (including `brigade.json`) is effectively a
  trusted operator. For mutually untrusted users, isolate by **OS user / host /
  separate gateway** — one operator per machine is the recommended model.

## Agent & model assumptions

- The model/agent is **not a trusted principal** — assume prompt and content injection
  can manipulate its behavior.
- Security boundaries come from host/config trust, gateway authentication, owner-only
  tool policy, and the `bash`-tool approval allowlist (`brigade exec`).
- **Prompt injection by itself is not a vulnerability** unless it crosses one of those
  boundaries (auth, ownership, or an exec approval).

## Tool execution

- The `bash` tool is gated by a per-agent approval allowlist. Approvals are **operator
  guardrails to reduce accidental execution**, not a multi-tenant authorization
  boundary.
- Read-only tools (`read` / `grep` / `find` / `ls`) are open by design and never prompt.

## Plugins & extensions

Extensions load **in-process** with the gateway and are **trusted code** — installing or
enabling one grants it the same OS privileges as Brigade itself. Only install extensions
you trust. A security report must demonstrate a boundary bypass (e.g. unauthenticated
load, or an allowlist/policy bypass), not merely that a trusted-installed extension can
act.

## Workspace & memory trust

- Workspace files (`~/.brigade/workspace/` persona files, `memory/facts.jsonl`,
  `MEMORY.md`) are **trusted local operator state**. If someone can edit them, they have
  already crossed the operator boundary.
- Tideline's provenance **write-gate** stops *untrusted* sources (tool output, retrieved
  documents, distilled extractions) from authoring or overwriting protected memory, and
  **per-origin isolation** keeps channel-peer facts out of the operator's recall. These
  are recall-safety mechanisms, not a host authorization boundary.

## Credentials

- Provider API keys and OAuth tokens are stored under `~/.brigade/` at mode `0600` on
  POSIX, used only to talk to the providers you configure, and never sent to the model.
- Config secrets use `${VAR}` references resolved at read time and restored (never
  persisted resolved) on write.
- In Convex storage mode, byte columns can be sealed with **AES-256-GCM at-rest
  encryption** (`brigade encrypt`).
- The owner-only `composio` connector key is stored encrypted and never echoed or logged.

## Out of scope

- Prompt-injection-only attacks without an auth / ownership / approval boundary bypass.
- Deployments where mutually untrusted users share one gateway host and config (per-user
  isolation is not modeled — use separate OS users/hosts).
- Anything requiring pre-existing local filesystem access to `~/.brigade/` or the
  operator's home directory.
- The operator deliberately exposing the gateway to a hostile network (it binds to
  loopback by default; exposing it is at your own risk).
- Operator-enabled "dangerous" / break-glass options that weaken defaults by design.
- Exposed third-party / user-supplied credentials that are not Brigade-owned.
- Scanner-only findings against stale or nonexistent paths, or reports without a working
  reproduction.

## Deployment assumptions

- The host running Brigade is within a trusted OS/admin boundary.
- One operator per gateway (one host/VPS per user when multiple people need Brigade).
- The gateway stays loopback-only (`127.0.0.1`) unless you add your own authentication
  and network controls in front of it.

## Runtime requirements

Brigade requires **Node.js 22.12 or later**, which includes important security patches.
Verify with `node --version`.
