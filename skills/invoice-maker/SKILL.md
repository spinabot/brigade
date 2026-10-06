---
name: invoice-maker
description: Run a freelance invoicing workflow from the current workspace — create invoices from line items, send them, record partial or full payments, chase overdue clients with escalation-ready reminders, render a shareable HTML invoice, and report collected vs outstanding earnings. Trigger when the user asks to invoice or bill a client, get paid, chase or remind about an unpaid invoice, record a payment, or see how much they've earned. Pairs with lead-scout (find the work) and expense-split (track spending) — this one is for revenue.
metadata:
  {
    "brigade":
      {
        "emoji": "💰",
      },
  }
---

# Invoice maker

The revenue half of freelancing: quote the work, invoice it, get paid, and
chase what's late. Where `expense-split` divides what you spent, this tracks
what you are owed and what you've collected.

The ledger is a single JSON file at `<cwd>/invoices/invoices.json`, so it
lives in the workspace and travels with it (diffable, committable).

## Running the tool

```bash
node {baseDir}/scripts/invoice.mjs <command> [args]
```

Run it from the workspace root — the ledger is written relative to the
current directory.

| Command | What it does |
| --- | --- |
| `new <client> --item "desc\|qty\|rate" [--item ...] [--currency CUR] [--tax PCT] [--discount PCT] [--terms N\|--due-date D] [--date D] [--from S] [--email S] [--pay-instructions S] [--notes S]` | Create a draft invoice (due date defaults to `--terms` days after issue) |
| `list [--status draft\|sent\|partial\|paid\|void\|overdue] [--client C] [--json]` | List invoices; `overdue` matches sent/partial past their due date |
| `show <id>` | Full detail: line items, totals, payments, balance |
| `render <id> [--out PATH]` | Write a standalone HTML invoice ready to send (default `invoices/rendered/<id>.html`) |
| `send <id>` | Mark a draft as sent (stamps `sentAt`) |
| `pay <id> <amount> [--method S] [--date D]` | Record a payment; the invoice flips to `paid` when the balance hits zero |
| `void <id>` | Void an unpaid invoice (kept as a record — financial records are never deleted) |
| `remind <id>` | Print a ready-to-send reminder, escalated by how overdue it is |
| `stats [--json]` | Collected vs outstanding vs overdue, average days to pay, top clients |

`<id>` is the invoice number (`INV-0001`). A bare number (`1`, `0001`) works
too. An exact id always wins; a partial id or client fragment works when it
matches exactly one invoice, and an ambiguous fragment is refused with the
candidates listed.

## Rules to respect

- **Money math happens in integer cents.** Line amounts, tax, discount, and
  totals are computed on whole cents (rate in cents × qty, rounded once) so a
  total can never drift by a floating-point ulp. Tax is applied **after** the
  discount.
- **Never invent a payment.** `pay` only records an amount the user states,
  and it refuses an amount above the outstanding balance — an overpayment is
  a bookkeeping error, not a windfall.
- **`remind` only works on overdue invoices.** Draft, paid, void, or simply
  not-yet-due are all refused with the reason — there is nothing to chase yet.
- **`send` moves draft → sent, exactly once.** Resending a sent invoice is
  refused; run `remind` instead.
- **Void, don't delete.** Paid invoices cannot be voided, and no command
  removes an invoice from the ledger — the audit trail is the point.
- Dates are ISO (`YYYY-MM-DD`, UTC). The due date defaults to `--terms`
  (14) days after the issue date; a `--due-date` before the issue date is
  refused.
- If the ledger is corrupt or malformed the tool **refuses to run** (exit 2)
  rather than overwrite it. Tell the user, and do not "fix" it by rewriting
  the file — surface the path so they can repair or restore it.

## Exit codes

- `0` — success
- `1` — usage error, unknown invoice, or a refused operation
- `2` — corrupt/unreadable ledger (nothing was changed)

## Reporting

After a mutation, confirm the change in one line (the tool prints one). For
`stats`, present the numbers as-is; do not editorialize earnings the data
does not support. When the user asks to "send" an invoice, `render` it and
hand them the file — the tool never emails anything itself.
