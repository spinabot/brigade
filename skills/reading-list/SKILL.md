---
name: reading-list
description: Keep a durable reading list (books, papers, articles) in the current workspace — add titles, track page progress, finish and rate them, attach tags and notes, and report stats. Trigger when the user asks to remember a book/paper/article to read, to update how far they've gotten, to mark something finished or rate it, to list what they're reading or want to read, or to summarize their reading. Complements habit-tracker (recurring routines) and expense-split (money) — this one is for things you read once, front to back.
metadata:
  {
    "brigade":
      { "emoji": "📚" },
  }
---

# Reading list

A ledger for things you intend to read once, front to back. Distinct from
`habit-tracker`: a book is not a recurring habit — it has a start, a finish, and
a page count that only ever goes up.

The ledger is a single JSON file at `<cwd>/reading/reading.json`, so it lives in
the workspace and travels with it (diffable, committable).

## Running the tool

```bash
node {baseDir}/scripts/reading.mjs <command> [args]
```

Run it from the workspace root — the ledger is written relative to the current
directory.

| Command | What it does |
| --- | --- |
| `add "<title>" [--author A] [--kind book\|paper\|article] [--pages N] [--tags a,b] [--url U]` | Add a new item in `want` state |
| `list [--status want\|reading\|finished] [--tag T]` | List items (sorted by title) |
| `show <id>` | Full detail for one item, including notes |
| `start <id> [--page N]` | Move to `reading`; optionally jump to a page |
| `progress <id> <page>` | Set the current page; auto-finishes at the last page |
| `finish <id> [--rating 1-5]` | Mark finished (optionally rate it) |
| `rate <id> <1-5>` | Set or change the rating |
| `note <id> <text>` | Append a timestamped note |
| `remove <id> --yes` | Delete an item (refuses without `--yes`) |
| `stats [--json]` | Totals, finished-this-year, pages, average rating, top tags |

`<id>` is a slug of the title (e.g. `deep-work`). An exact id always wins; a
partial id or title fragment works when it matches exactly one item, and an
ambiguous fragment is refused with the candidates listed.

## Rules to respect

- **Never invent progress.** Only report a page the user actually told you.
  `progress` refuses a page past the end of an item that has a `--pages` value.
- **`add` does not start the book.** Adding means "want to read"; `start` or
  `progress` is what moves it to `reading`.
- **Ratings are 1–5 whole numbers.** Anything else is refused.
- **`remove` needs `--yes`.** It is not reversible.
- If the ledger is corrupt or malformed the tool **refuses to run** (exit 2)
  rather than overwrite it. Tell the user, and do not "fix" it by rewriting the
  file — surface the path so they can repair or restore it.

## Exit codes

- `0` — success
- `1` — usage error, unknown item/command, or a refused operation
- `2` — corrupt/unreadable ledger (nothing was changed)

## Reporting

After a mutation, confirm the change in one line (the tool prints one). For
`stats`, present the numbers as-is; do not editorialize a reading pace the data
does not support.
