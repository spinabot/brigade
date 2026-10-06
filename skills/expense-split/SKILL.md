---
name: expense-split
description: Use when a group of people share expenses and need to settle up fairly — trips, roommates, dinners, shared subscriptions. Tracks who paid and who owes with exact integer-cent math, computes per-person balances, simplifies the debt graph to the fewest transfers, and records real repayments. Keyless — no API keys or network access required.
metadata:
  {
    "brigade":
      {
        "emoji": "🧾",
      },
  }
---

# Expense Split

Goal: keep group money boring and exact. Every expense logged the moment it happens, balances computed in integer cents (never floating-point), and settle-up reduced to the fewest transfers so nobody pays five people back separately. The ledger is the source of truth; memory and mental math are not.

## The ledger

One JSON file, `<workspace>/expenses/expenses.json`, created on first use (`--db` overrides). Run from the workspace root so the default path lands there:

```bash
node {baseDir}/scripts/split.mjs group add "Ski Trip" --members ana,bob,cy
node {baseDir}/scripts/split.mjs expense add "Ski Trip" ana 90.00 --desc "cabin" --split ana,bob,cy
node {baseDir}/scripts/split.mjs expense add "Ski Trip" bob 42.80 --desc "groceries"        # split defaults to everyone
node {baseDir}/scripts/split.mjs balances "Ski Trip"               # who's up, who's down
node {baseDir}/scripts/split.mjs simplify "Ski Trip"               # fewest transfers to settle
node {baseDir}/scripts/split.mjs settle "Ski Trip" bob ana 30.00 --note "first transfer"
node {baseDir}/scripts/split.mjs expense list "Ski Trip"
node {baseDir}/scripts/split.mjs expense remove "Ski Trip" e1      # wrong entry, logged twice, etc.
node {baseDir}/scripts/split.mjs group show "Ski Trip"
node {baseDir}/scripts/split.mjs group remove "Old Trip" --yes     # destructive; needs --yes
```

Groups are referenced by name or id; members by name (case-insensitive). `--split a,b` restricts who shares an expense; the default is every member. Balances always sum to exactly zero — if a user's mental math disagrees with `balances`, the ledger wins; check the expense list before arguing.

## Workflow

1. **Create the group before the first receipt.** Get the member list once, spelled as the user wants them displayed. Adding members later is fine (`member add`); they simply start with a zero balance.
2. **Log the moment money moves.** `expense add <group> <payer> <amount> --desc <what>` with the payer exactly as it happened — one person pays, the group shares. For an expense only some people benefit from (e.g. one ski lesson), pass `--split` with just those names.
3. **Balances on demand, simplify at the end.** Mid-trip, `balances` answers "do I owe anything?". At the end, `simplify` produces the minimal transfer list — show it, then wait for people to actually pay.
4. **Record real repayments with `settle`.** Only when the money actually moved. A settle changes balances immediately; never pre-record a planned transfer.
5. **Correct mistakes with `expense remove`, never by offsetting.** A double-logged dinner is removed, not cancelled out with a fake negative expense.
6. **Report neutrally.** Money is awkward; be the boring ledger. State numbers, not judgments ("bob is down $43.20", not "bob never pays"). Never share a group's numbers outside the group.

## Anti-patterns

- **Never settle on the user's behalf or move real money.** The script records repayments; it does not send, request, or split via any payment service. If the user asks to "Venmo someone", stop — that's the user's own hands.
- Don't round shares unevenly or eyeball amounts. Shares are cent-exact by construction (remainder cents go deterministically to the first names in the split); report whatever `balances` says.
- Don't log IOUs as expenses. If ana pays for dinner and bob hands ana cash at the table, that's a `settle`, not a new expense with a negative amount.
- Don't edit history silently. Removing an expense needs the user's say-so; say what the correction does to balances.
- Don't put card numbers, bank details, or full transaction IDs in descriptions — it's a plain local JSON file.
- Don't let a stale `simplify` linger. After new expenses or settles, re-run it; the transfer list is only valid for the ledger moment it was computed from.
