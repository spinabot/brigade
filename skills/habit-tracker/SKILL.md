---
name: habit-tracker
description: Use when the user wants to build, track, or stay accountable to daily or weekly habits — exercise, reading, meditation, journaling, practice of any kind, or breaking a bad habit. Maintains a durable local habit ledger with streaks, a due-today list, weekly scores, and honest broken-streak handling via the bundled habit script. Keyless — no API keys, services, or network access required.
metadata:
  {
    "brigade":
      {
        "emoji": "🔥",
      },
  }
---

# Habit Tracker

Goal: make the habit visible, make today's obligation concrete, and keep the streak count honest. A streak only motivates if it's real — the ledger is the source of truth, not memory, and a missed day is recorded as a miss, not rationalized away.

## The ledger

One JSON file, `<workspace>/habits/habits.json`, created on first use (`--db` overrides). Run from the workspace root so the default path lands there:

```bash
node {baseDir}/scripts/habit.mjs add "Meditate" --schedule daily --goal 10
node {baseDir}/scripts/habit.mjs add "Gym" --schedule weekly --days mon,wed,fri
node {baseDir}/scripts/habit.mjs due                            # what's owed today (or this week)
node {baseDir}/scripts/habit.mjs check Meditate --note "10 min breathing"
node {baseDir}/scripts/habit.mjs check Gym --date 2026-10-03
node {baseDir}/scripts/habit.mjs uncheck Meditate --date 2026-10-02    # honest correction
node {baseDir}/scripts/habit.mjs list                           # streaks, due flags, scores
node {baseDir}/scripts/habit.mjs stats Meditate                 # 8-week heatmap + best streak
node {baseDir}/scripts/habit.mjs pause Gym                      # streak clock stops, habit stays
node {baseDir}/scripts/habit.mjs resume Gym
node {baseDir}/scripts/habit.mjs archive Gym                    # out of due rotation, history kept
node {baseDir}/scripts/habit.mjs remove Gym                     # only when the user asks
```

Paused habits stay checkable (life happens) — the entry is recorded but the streak stays frozen at 0 until `resume`. Archived habits refuse check-ins entirely.

Schedules: `daily`, or `weekly` with `--days mon,tue,…` (three-letter, comma-separated). `--goal N` is minutes (a plain number) or a duration (`10m`, `45min`, `1.5h`) — checked-offs shorter than the goal still count, but the note should say why.

## Workflow

1. **Onboard concretely.** A vague habit ("be healthier") is never trackable. Get the habit name, schedule, and (for time-based habits) a goal before running `add`. One `add` per habit, never a batch on the user's behalf without their explicit list.
2. **Start sessions with `due`.** When the user opens a session in a habit context, run `due` first and report what's owed today in one line per habit, streak included. The due list is the agenda; don't re-derive it.
3. **Log the check the moment it happens.** `check <habit>` with a `--note` when the user gives context (minutes read, distance run). Same-day only unless the user says otherwise — backfilling silently turns the ledger into fiction.
4. **Correct honestly.** If the user says "actually I skipped Tuesday", run `uncheck` for that date. A broken streak is data, not failure — report the new streak without drama and keep the cadence.
5. **Review weekly with `stats <habit>`** and with `list`: point at the longest current streak, the weakest weekday (heatmap gaps), and ask whether the schedule needs adjusting rather than whether the user needs more willpower.
6. **Adjust the system, not the person.** If a habit is missed repeatedly, propose: shrink the goal (10 min instead of 45), change the schedule (3 days instead of 7), or `pause` for a declared period. Never mark a missed day as done to "protect" a streak.
7. **Accountability nudges.** If the agent runs on a schedule, a morning nudge may list `due` output; an evening one may ask about unchecked habits. Never nag more than once a day per habit, and never nag paused or archived habits.

## Anti-patterns

- **Never invent a check-in.** A `check` happens on the user's word. If they didn't say they did it, it isn't done — no optimistic marking, no "I'll assume yes".
- **Never backfill without the user explicitly giving the date(s).** "I did it this week" is not a date; ask which days before checking anything.
- Don't moralize misses. Report the streak change, suggest the smallest next step, move on.
- Don't move the goalposts silently. Changing a goal or schedule is a user decision; propose it, don't apply it.
- Don't store sensitive content in notes — the ledger is a plain local JSON file; "gym — leg day" beats a diary.
- Don't let `due` output become a wall of text. One line per due habit; details on request.
