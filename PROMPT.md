Build a single-page shift scheduling app for an 8-person support team.



\## Deliverable

\- One self-contained folder: index.html, styles.css, app.js. No build step, no npm, no framework.

\- You may use ONE external library, loaded from a CDN or vendored as a single JS file, with zero transitive dependencies. Choose whatever best fits the solver work (e.g. a small LP/constraint solver), or implement the optimizer in plain JS if that's cleaner. Justify the choice in a comment at the top of app.js.

\- All state persists in localStorage so my edits survive a refresh.



\## Scheduling model (IMPORTANT - read this carefully)

There are NO fixed shift blocks. Each employee has their OWN shift start time.



\- The week is modelled as 168 hourly slots (Mon 00:00 through Sun 23:00), Asia/Manila.

\- Each employee is assigned a personal shift START HOUR (on the hour, 00-23) and a set

&#x20; of 5 working days. Their shift is that start hour plus 9 hours, and may cross midnight.

\- The solver chooses both the start hours and the day sets. Start hours may be staggered

&#x20; freely across the team - that stagger is the whole point of this model.

\- By default a person keeps the SAME start hour all week (predictable body clock). Allow

&#x20; per-day variation only as a soft-penalised option, controlled by a toggle.



\## HARD CONSTRAINTS (must never be violated)

\- 8 employees.

\- Each person works exactly 5 shifts per week.

\- Every shift is exactly 9 hours.

\- At least 2 people must be on duty during every one of the 168 hourly slots. 24/7 coverage,

&#x20; no gaps.

\- Overstaffing to 3 is permitted and expected: 8 x 5 x 9 = 360 person-hours supplied vs

&#x20; 336 required, so exactly 24 person-hours will be triple-covered. Treat these as handover

&#x20; windows and prefer to place them at shift changeovers rather than scattering them randomly.

\- Never more than 3 people on duty in any slot.

\- Minimum 11 hours of rest between the end of one shift and the start of the next.

\- No more than 5 consecutive working shifts.

\- A person marked unavailable for a given day or hour range is never assigned it.

\- All times are Asia/Manila. Display the timezone in the UI.



\## SOFT CONSTRAINTS (preferences to optimize, each with an adjustable weight)

Per person, editable in the UI:

\- Preferred start-time window (e.g. "between 06:00 and 10:00"), or "no preference".

\- Earliest acceptable start / latest acceptable start (soft bounds, penalised if crossed).

\- Preferred days off: pick any days of the week.

\- Wants consecutive days off (yes/no).

\- Max overnight shifts they're willing to take (an overnight = any shift covering 00:00-05:00).

\- Max weekend shifts they're willing to take.



Team-level fairness goals:

\- Distribute overnight and weekend hours evenly across the team.

\- Rotate the least desirable start times fairly across weeks; persist history in localStorage

&#x20; so the same person doesn't draw graveyard two weeks running.

\- Avoid any single person absorbing a disproportionate share of unmet preferences.



\## Optimization

\- Score each candidate schedule with a weighted sum of satisfied soft constraints.

\- Do NOT just maximize the total. Also minimize the worst individual dissatisfaction score,

&#x20; so no one person gets a terrible week to make the average look good. Show both the team

&#x20; total and the worst-off individual.

\- Before solving, run a feasibility check: total person-hours supplied vs required, and report

&#x20; the margin in plain language. If supply is below demand, stop and say so with the exact

&#x20; shortfall.

\- If the arithmetic works but no valid assignment exists, report which hard constraint is

&#x20; blocking it and suggest the smallest relaxation that would make it solvable.

\- Never silently produce a schedule with a coverage gap.

\- Make the weights adjustable via sliders in a settings panel, with sensible defaults.



\## UI requirements

\- A 168-slot coverage heatmap for the week: hours on one axis, days on the other, each cell

&#x20; coloured by how many people are on duty (2 = good, 3 = handover, 1 or 0 = error, flagged red).

\- A gantt-style timeline showing each person's 5 shift bars laid across the week, so the

&#x20; stagger pattern is visible at a glance.

\- Per-person panel: their start time, their 5 days, total hours, overnight count, weekend

&#x20; count, satisfaction score, and a list of which preferences were not met and why.

\- A validation panel confirming each hard constraint, with counts (e.g. "Coverage: 168/168

&#x20; slots have >=2 people", "Rest periods: 40/40 OK").

\- Let me lock a person's start time or specific days and re-run, so the solver works around

&#x20; what I've pinned.

\- Export to CSV.

\- Clean, readable, responsive layout. Works on a laptop and a phone.



\## Also include

\- Seeded demo data for all 8 people with varied, realistic preferences so the app is usable

&#x20; the moment it opens.

\- A "Reset to demo data" button.

\- A short README.md explaining how the solver works, how to tune the weights, and how to

&#x20; change team size or coverage requirements.



Ask me any clarifying questions before you start building.

