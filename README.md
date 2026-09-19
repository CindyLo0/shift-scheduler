# Shift Scheduler

A single-page shift-scheduling app for an 8-person support team with 24/7 coverage.
No build step, no npm, no framework — just `index.html`, `styles.css`, `app.js`.
Open `index.html` in a browser and it works. All state persists in `localStorage`.

## The scheduling model

- The week is **168 hourly slots** (Mon 00:00 → Sun 23:00), **Asia/Manila**.
- Each person works **exactly 5 shifts of exactly 9 hours** on 5 distinct days.
- Each person has a **personal start hour** (0–23). By default every shift uses that
  same start hour all week (predictable body clock). A toggle enables **per-day
  variation**, which is softly penalised.
- A shift may cross midnight within the week (e.g. Mon 22:00 → Tue 07:00).
- Coverage is **cyclic across the week boundary** (true 24/7 operation): a Sunday
  23:00 shift wraps to cover Monday 00:00–07:00, so there are never coverage gaps
  at the week edges.

### Hard constraints (never silently violated)
- 8 people, 5 shifts each, 9h each.
- **≥2 people on duty in every slot** (24/7, no gaps). There is no hard maximum — 3, 4, or more overlapping is never a hard-constraint failure. (It can still get a small *soft* nudge if it lands away from a shift changeover - see "Handover" under soft constraints.)
- **≥11h rest** between the end of one shift and the start of the next.
- ≤5 consecutive working shifts (auto-satisfied by 5 distinct days).
- Never assign an unavailable day or hour range.

### Soft constraints (weighted, adjustable)
Per person: preferred start window, earliest/latest acceptable start, preferred days
off, wants consecutive days off, max overnight shifts, max weekend shifts.
Team-level: even overnight/weekend distribution, fair rotation of undesirable
("graveyard") starts across weeks (history persisted), extra coverage (any slot
above the 2-person minimum) placed at shift changeovers (handover), and a
**minimax** term so no single person absorbs a disproportionate share of unmet
preferences.

## How the solver works

The optimizer is a **two-phase simulated-annealing local search** written in plain
JS (no external library).

**Phase 1 — feasibility.** It searches for a schedule that satisfies every hard
constraint, scoring candidates as `hard_violations × 1,000,000 + soft_penalty`.
Coverage-aware moves (shifting a person who works a gapped day so their shift covers
the gap) give the annealer a gradient toward full coverage. A greedy repair pass
then drives the best candidate to `hard = 0`. Several independent attempts run and
the best feasible schedule is kept.

**Phase 2 — optimisation.** Starting from that feasible schedule, it anneals the
weighted soft objective while **refusing any move that would break a hard
constraint**, so feasibility is never lost.

Moves include: change a person's start hour (or a single day's start when per-day
variation is on), and swap one working day for another.

The soft score is the sum of every person's personal penalty plus team-fairness
terms (overnight/weekend spread, rotation, handover) plus
`worstIndividual × (worst person's penalty)`. Raising the **"Minimise worst-off
person"** weight pushes the solver to balance the load rather than just optimise the
average.

### Feasibility & diagnostics
Before solving, the app checks total supply vs demand:
`supply = people × 5 × 9`, `demand = 168 × 2`. If supply is below demand it stops and
reports the exact shortfall. If the arithmetic works but no valid assignment is found,
the validation panel reports which hard constraint is blocking and suggests the
smallest relaxation.

## Tuning the weights

Open **Settings — Soft-Constraint Weights**. Each slider is 0–30 (defaults are
sensible). Raise a weight to make that preference matter more; set to 0 to ignore it.
After changing weights, click **Solve** to re-optimise.

## Locking

In each person's card, tick **Lock start** or **Lock days** to pin that attribute.
The solver will work around locked values. Edit the start hour or working days
directly, then re-run Solve.

## Changing team size or coverage requirements

The app is hard-coded to 8 people and a 2-person minimum for simplicity, but the
constants are easy to change in `app.js`:

- **Team size:** edit the `demoPeople()` array (add/remove `mkPerson(...)` entries).
  The feasibility check and solver adapt automatically.
- **Coverage minimum:** change the `2` in `feasibilityCheck()` (`demand = SLOTS * 2`)
  and the `< 2` check in `evaluate()`. The heatmap legend and validation text
  reference this value too. (There is no coverage maximum in this version — the
  `> 3` check that used to enforce one was removed; `over` is still tracked and
  shown, informationally only.)
- **Shift length / rest:** change `SHIFT_LEN` and `REST_MIN` at the top of `app.js`.

## Export

**Export CSV** downloads `shift-schedule.csv` with one row per shift: person, day,
start, end, hours, overnight, weekend.
