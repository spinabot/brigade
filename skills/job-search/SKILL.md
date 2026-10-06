---
name: job-search
description: Use when the user is job hunting — finding and vetting roles, applying, tracking applications, tailoring resumes or cover letters, following up, preparing for interviews, or weighing offers. Maintains a durable, searchable application ledger with follow-up reminders and funnel stats via the bundled tracker script. Keyless — web_search, the browser, and local files do everything.
metadata:
  {
    "brigade":
      {
        "emoji": "💼",
      },
  }
---

# Job Search

Goal: run the hunt like a pipeline — every role vetted before applying, every application logged the moment it goes out, every follow-up on time, every status current. The bundled tracker script is the source of truth; your memory is not.

## The ledger

One JSON file, `<workspace>/job-search/applications.json`, created on first use (`--db` overrides). Run the script from the workspace root so the default path lands there:

```bash
node {baseDir}/scripts/tracker.mjs add --company "Acme" --role "Backend Engineer" --url "https://acme.example/careers/123" --source "linkedin" --location "Remote"
node {baseDir}/scripts/tracker.mjs list                       # table of everything
node {baseDir}/scripts/tracker.mjs update 3 --status interview --notes "Tech screen Thu 2pm"
node {baseDir}/scripts/tracker.mjs note 3 --notes "Recruiter said decision by Friday"
node {baseDir}/scripts/tracker.mjs followups                  # what needs attention today
node {baseDir}/scripts/tracker.mjs stats                      # funnel + response rate
node {baseDir}/scripts/tracker.mjs show 3                     # full record + history
node {baseDir}/scripts/tracker.mjs remove 3                   # only when the user asks
```

### Web dashboard

`dashboard.mjs` serves the same ledger as a small read-only web page (funnel, response rate, follow-ups, full table) for the user's browser:

```bash
node {baseDir}/scripts/dashboard.mjs            # binds 127.0.0.1 on an ephemeral port, prints the URL
node {baseDir}/scripts/dashboard.mjs --db <path> --port 7691   # when the ledger is elsewhere
```

It re-reads the file on every refresh (auto-refreshes every 30s) so tracker edits appear immediately. It is strictly read-only — the dashboard never writes the ledger — and binds to loopback only, so nothing outside the machine can reach it. Tell the user the URL and let them open it; don't screen-scrape it yourself, use `tracker.mjs list/stats` for that.

Statuses, in pipeline order: `applied` → `screening` → `interview` → `offer` → `accepted`, plus `rejected` / `withdrawn` (terminal). `--json` on list/show/followups/stats when you need to process the output further.

## Workflow

1. **Vet before applying.** `web_search "<company> <role>"` first — the company's own careers page beats job boards for freshness and detail. Check the posting is live (a stale aggregator listing wastes an application). Then dedupe: `list --company <name>` so you never double-apply.
2. **Log the moment it's submitted.** `add` with url + source, every time. An unlogged application is a lost follow-up.
3. **Tailor per role.** Resume bullets mirror the posting's vocabulary, backed by the user's real evidence; cover letters stay 150–250 words and reference specifics of the role or company. Save tailored docs under `job-search/docs/<company>-<role>/` so they sit next to the ledger.
4. **Follow up on cadence.** Start every job-hunt session with `followups`. Nudge ~7 days after a silent application; thank-you within 24h of an interview; check in ~2 weeks after a final round. The script's suggested-action text tells you which is due.
5. **Update status the moment news arrives** — a recruiter reply, an OA link, a rejection. The funnel and follow-ups are only as good as the statuses. When in doubt, `note` what happened verbatim.
6. **Review weekly with `stats`** and report the shape to the user: where the funnel stalls (many applies, no screens → targeting or resume problem; screens but no offers → interview prep problem).
7. **Interview prep.** Research the company (web_search + browser: product, recent news, engineering blog). Mine the posting for likely questions. Prep STAR stories from the user's real background, and 2–3 questions for the interviewer. Practice answers out loud with the user if they want.
8. **Offers.** Compare base / bonus / equity / benefits / level / remote policy side by side against the ledger's other offers. The user decides; you lay out the trade-offs.

## Anti-patterns

- **NEVER submit an application, or send any follow-up email/message, without the user's explicit go-ahead.** Draft, show, wait for the word.
- Never fabricate or inflate experience, titles, or dates. Tailoring is emphasis, not invention — and never touch credentials, licenses, or eligibility claims.
- Don't put the user's PII (full name, phone, address, resume text) into search queries. Search the company and role, not the person.
- Don't store passwords, 2FA codes, or government IDs in the ledger — it's a plain local JSON file.
- Don't mark `rejected` on silence alone; a status change needs evidence. Use `followups` instead.
- Don't mass-apply. One tailored application to a vetted role beats twenty form-fills, and the user's ledger should show that.
- Don't re-derive what the ledger already answers — `list` / `show` first.

## Privacy

The ledger is local-only and it is the user's data. Never paste its contents into public forms or third-party sites, and `remove` an entry (or the whole file) the moment the user asks.
