/*
 * Shift Scheduler — 8-person support team, 24/7 coverage.
 *
 * SOLVER CHOICE: implemented as a plain-JS simulated-annealing local search.
 * No external library is used. Rationale: the search space (8 people x 5
 * shifts, each shift = {day, startHour}) is small enough that a well-tuned
 * annealer reliably finds a feasible, near-optimal schedule in ~1-2s, and it
 * keeps the app fully self-contained with zero dependencies. A general-purpose
 * constraint/LP solver would add a vendored dependency and integration
 * complexity without meaningfully better results at this scale.
 *
 * MODEL
 *   - The week is 168 hourly slots, Mon 00:00 (slot 0) .. Sun 23:00 (slot 167),
 *     Asia/Manila. slot = day*24 + hour.
 *   - Each person works exactly 5 shifts of exactly 9 hours on 5 distinct days.
 *   - Each person has a base start hour (0-23). By default every shift uses the
 *     base start (predictable body clock). If "per-day variation" is enabled,
 *     individual days may override the base start, softly penalised.
 *   - A shift {day, start} covers slots day*24+start .. day*24+start+8 (clamped
 *     to the week window), so it may cross midnight within the week.
 *
 * HARD CONSTRAINTS (heavily penalised, never silently violated):
 *   - exactly 5 shifts/person, 9h each, 8 people
 *   - >=2 and <=3 people on duty in every slot
 *   - >=11h rest between consecutive working days (start_next >= start_prev+20)
 *   - <=5 consecutive working shifts (auto-satisfied: 5 distinct days)
 *   - never assign an unavailable day/hour range
 *
 * SOFT CONSTRAINTS (weighted, adjustable in the UI): preferred start window,
 * soft earliest/latest bounds, preferred days off, consecutive days off,
 * max overnight shifts, max weekend shifts, plus team fairness (even overnight
 * & weekend distribution, fair rotation of undesirable starts across weeks,
 * and a minimax term so no single person absorbs a disproportionate share).
 */

"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SLOTS = 168;
const SHIFT_LEN = 9;
const REST_MIN = 11; // hours between end of one shift and start of next
const HARD_PENALTY = 1e6;
const UNDESIRABLE_STARTS = [0, 1, 2, 3, 4, 22, 23]; // "graveyard" for rotation fairness
const STORAGE_KEY = "shiftSchedulerState.v1";

const DEFAULT_WEIGHTS = {
  prefWindow: 10,
  softBounds: 8,
  prefDaysOff: 12,
  consecutiveOff: 6,
  maxOvernight: 10,
  maxWeekend: 10,
  fairnessOvernight: 8,
  fairnessWeekend: 8,
fairnessRotation: 6,
  handover: 4,
  worstIndividual: 15,
};

const WEIGHT_LABELS = {
  prefWindow: "Preferred start window",
  softBounds: "Earliest / latest bounds",
  prefDaysOff: "Preferred days off",
  consecutiveOff: "Consecutive days off",
  maxOvernight: "Max overnight shifts",
  maxWeekend: "Max weekend shifts",
  fairnessOvernight: "Fairness: overnight spread",
  fairnessWeekend: "Fairness: weekend spread",
fairnessRotation: "Fairness: undesirable-start rotation",
  handover: "Handover: triple-coverage at changeovers",
  worstIndividual: "Minimise worst-off person",
};

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------
function demoPeople() {
  return [
    mkPerson("Cindy", 8, [0, 1, 2, 3, 4], { prefWindow: { start: 6, end: 10 }, earliest: 5, latest: 12, prefDaysOff: [5, 6], wantConsecutiveOff: true, maxOvernight: 0, maxWeekend: 1 }, { unavailableDays: [2] }),
    mkPerson("Sherie", 0, [0, 1, 2, 3, 4], { prefWindow: null, earliest: 0, latest: 23, prefDaysOff: [0, 1], wantConsecutiveOff: true, maxOvernight: 3, maxWeekend: 2 }, { unavailableHours: [{ start: 12, end: 14 }] }),
    mkPerson("Bing", 15, [0, 1, 2, 3, 4], { prefWindow: { start: 14, end: 18 }, earliest: 12, latest: 20, prefDaysOff: [2, 3], wantConsecutiveOff: true, maxOvernight: 1, maxWeekend: 1 }, {}),
    mkPerson("Daphine", 23, [0, 1, 2, 3, 4], { prefWindow: { start: 22, end: 2 }, earliest: 20, latest: 4, prefDaysOff: [4, 5], wantConsecutiveOff: true, maxOvernight: 5, maxWeekend: 2 }, {}),
    mkPerson("LA", 9, [0, 1, 2, 3, 4], { prefWindow: { start: 8, end: 12 }, earliest: 7, latest: 14, prefDaysOff: [0, 6], wantConsecutiveOff: true, maxOvernight: 0, maxWeekend: 1 }, {}),
    mkPerson("Phoebe", 2, [0, 1, 2, 3, 4], { prefWindow: null, earliest: 0, latest: 23, prefDaysOff: [1, 2], wantConsecutiveOff: true, maxOvernight: 2, maxWeekend: 2 }, {}),
    mkPerson("Inah", 11, [0, 1, 2, 3, 4], { prefWindow: { start: 10, end: 14 }, earliest: 9, latest: 16, prefDaysOff: [3, 4], wantConsecutiveOff: true, maxOvernight: 0, maxWeekend: 1 }, {}),
    mkPerson("Joan", 19, [0, 1, 2, 3, 4], { prefWindow: { start: 18, end: 22 }, earliest: 16, latest: 23, prefDaysOff: [5, 6], wantConsecutiveOff: true, maxOvernight: 2, maxWeekend: 1 }, {}),
  ];
}

function mkPerson(name, baseStart, days, prefs, extra) {
  return {
    id: name.toLowerCase(),
    name,
    baseStart,
    days: days.slice(),
    perDay: {}, // day -> startHour override (only used when variation is on)
    prefs,
    unavailableDays: (extra && extra.unavailableDays) || [],
    unavailableHours: (extra && extra.unavailableHours) || [],
    lockedStart: false,
    lockedDays: false,
  };
}

// ---------------------------------------------------------------------------
// State + persistence
// ---------------------------------------------------------------------------
let state = {
  people: demoPeople(),
  weights: { ...DEFAULT_WEIGHTS },
  variationOn: false,
  rotationHistory: {}, // personId -> last week number they had an undesirable start
  weekNumber: 1,
  lastResult: null, // { feasible, hard, soft, worst, ... }
};

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.people) && parsed.people.length === 8) {
      state = {
        ...state,
        ...parsed,
        weights: { ...DEFAULT_WEIGHTS, ...(parsed.weights || {}) },
      };
    }
  } catch (e) { /* ignore */ }
}

function resetToDemo() {
  state.people = demoPeople();
  state.weights = { ...DEFAULT_WEIGHTS };
  state.variationOn = false;
  state.rotationHistory = {};
  state.weekNumber = 1;
  state.lastResult = null;
  save();
  renderAll();
}

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------
function effectiveStart(p, day) {
  if (state.variationOn && p.perDay[day] != null) return p.perDay[day];
  return p.baseStart;
}

function shiftSlots(day, start) {
  // A shift covers 9 consecutive slots. Coverage is cyclic across the week
  // boundary (24/7 continuous operation): a Sunday 23:00 shift wraps to cover
  // Monday 00:00-07:00, so there are never coverage gaps at the week edges.
  const slots = [];
  for (let h = 0; h < SHIFT_LEN; h++) {
    slots.push((day * 24 + start + h) % SLOTS);
  }
  return slots;
}

// A shift is overnight if any of its 9 covered hours falls in 00:00-04:59.
// This catches late starts (e.g. 21:00, 22:00, 23:00) that run through the
// small hours via the modulo-24 wrap, not just shifts that start at 00:00-04:00.
function isOvernight(start) {
  for (let h = 0; h < SHIFT_LEN; h++) {
    const hour = (start + h) % 24;
    if (hour >= 0 && hour < 5) return true;
  }
  return false;
}
function isWeekend(day) { return day === 5 || day === 6; }

// True if any two off days are consecutive, treating the week as cyclic so
// Sunday (6) and Monday (0) count as consecutive.
function hasConsecutiveOff(offDays) {
  const s = new Set(offDays);
  for (let d = 0; d < 7; d++) {
    if (s.has(d) && s.has((d + 1) % 7)) return true;
  }
  return false;
}

function overlapsUnavailable(start, ranges) {
  for (const r of ranges) {
    for (let h = 0; h < SHIFT_LEN; h++) {
      const hour = (start + h) % 24;
      const hit = r.start <= r.end
        ? (hour >= r.start && hour < r.end)
        : (hour >= r.start || hour < r.end);
      if (hit) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
function evaluate(people, weights) {
  const coverage = new Array(SLOTS).fill(0);
  const personShifts = [];

  for (const p of people) {
    const shifts = [];
    for (const d of p.days) {
      const start = effectiveStart(p, d);
      shifts.push({ day: d, start });
      for (const s of shiftSlots(d, start)) coverage[s]++;
    }
    personShifts.push(shifts);
  }

  // --- hard constraints ---
let under = 0, over = 0;
  let hardPenalty = 0;
  for (let s = 0; s < SLOTS; s++) {
    if (coverage[s] < 2) { under++; hardPenalty += HARD_PENALTY * (2 - coverage[s]); }
    if (coverage[s] > 3) { over++; hardPenalty += HARD_PENALTY * (coverage[s] - 3); }
  }
  let restViol = 0, unavailViol = 0;
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    const shifts = personShifts[i].slice().sort((a, b) => a.day - b.day);
for (let k = 1; k < shifts.length; k++) {
      if (shifts[k].day - shifts[k - 1].day === 1) {
        // rest = 15 + start_next - start_prev; violation if < REST_MIN
        if (shifts[k].start < shifts[k - 1].start - (24 - SHIFT_LEN - REST_MIN)) { restViol++; hardPenalty += HARD_PENALTY; }
      }
    }
    for (const sh of shifts) {
      if (p.unavailableDays.includes(sh.day)) { unavailViol++; hardPenalty += HARD_PENALTY; }
      if (overlapsUnavailable(sh.start, p.unavailableHours)) { unavailViol++; hardPenalty += HARD_PENALTY; }
    }
  }
  const hard = under + over + restViol + unavailViol;

  // --- soft constraints ---
  const personal = people.map((p, i) => personalPenalty(p, personShifts[i], weights));
  const worst = personal.length ? Math.max(...personal) : 0;
  const sumPersonal = personal.reduce((a, b) => a + b, 0);

  const overnightCounts = personShifts.map(sh => sh.filter(s => isOvernight(s.start)).length);
  const weekendCounts = personShifts.map(sh => sh.filter(s => isWeekend(s.day)).length);
  const fairnessOvernight = variancePenalty(overnightCounts) * weights.fairnessOvernight;
  const fairnessWeekend = variancePenalty(weekendCounts) * weights.fairnessWeekend;

  let rotationPenalty = 0;
  for (const p of people) {
    if (UNDESIRABLE_STARTS.includes(p.baseStart)) {
      const last = state.rotationHistory[p.id];
      if (last != null && state.weekNumber - last <= 1) rotationPenalty += weights.fairnessRotation;
    }
  }

  // Handover preference: triple-coverage should sit at shift changeovers
  // (where a shift starts or ends) rather than scattered mid-shift.
  const changeovers = new Set();
  for (const sh of personShifts.flat()) {
    changeovers.add((sh.day * 24 + sh.start) % SLOTS);
    changeovers.add((sh.day * 24 + sh.start + SHIFT_LEN) % SLOTS);
  }
  let handoverPenalty = 0;
  for (let s = 0; s < SLOTS; s++) {
    if (coverage[s] === 3 && !changeovers.has(s)) handoverPenalty += weights.handover;
  }

  const soft = sumPersonal + fairnessOvernight + fairnessWeekend + rotationPenalty + handoverPenalty + worst * weights.worstIndividual;
  const total = hardPenalty + soft;

  return { coverage, personShifts, hard, under, over, restViol, unavailViol, soft, total, personal, worst, overnightCounts, weekendCounts };
}

function personalPenalty(p, shifts, weights) {
  let pen = 0;
  const base = p.baseStart;
  const w = weights;

  if (p.prefs.prefWindow) {
    const { start, end } = p.prefs.prefWindow;
    let dist = 0;
    if (base < start) dist = start - base;
    else if (base > end) dist = base - end;
    pen += dist * w.prefWindow;
  }
  if (p.prefs.earliest != null && base < p.prefs.earliest) pen += (p.prefs.earliest - base) * w.softBounds;
  if (p.prefs.latest != null && base > p.prefs.latest) pen += (base - p.prefs.latest) * w.softBounds;

  for (const d of p.prefs.prefDaysOff) if (p.days.includes(d)) pen += w.prefDaysOff;

  if (p.prefs.wantConsecutiveOff) {
    const offDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !p.days.includes(d));
    if (!hasConsecutiveOff(offDays)) pen += w.consecutiveOff;
  }

  const overnight = shifts.filter(s => isOvernight(s.start)).length;
  if (overnight > p.prefs.maxOvernight) pen += (overnight - p.prefs.maxOvernight) * w.maxOvernight;

  const weekend = shifts.filter(s => isWeekend(s.day)).length;
  if (weekend > p.prefs.maxWeekend) pen += (weekend - p.prefs.maxWeekend) * w.maxWeekend;

  return pen;
}

function variancePenalty(counts) {
  if (counts.length === 0) return 0;
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  return counts.reduce((a, c) => a + (c - avg) * (c - avg), 0);
}

// ---------------------------------------------------------------------------
// Solver (simulated annealing)
// ---------------------------------------------------------------------------
function clonePeople(people) {
  return people.map(p => ({
    ...p,
    days: p.days.slice(),
    perDay: { ...p.perDay },
    prefs: { ...p.prefs, prefWindow: p.prefs.prefWindow ? { ...p.prefs.prefWindow } : null },
    unavailableDays: p.unavailableDays.slice(),
    unavailableHours: p.unavailableHours.map(r => ({ ...r })),
  }));
}

function initialPeople(people) {
  const out = clonePeople(people);
  // Evenly-spread start hours give near-feasible coverage immediately. The
  // annealer then refines days and starts. 8 starts every 3h = 0,3,6,...,21.
  const evenStarts = [0, 3, 6, 9, 12, 15, 18, 21];
  const desired = out.map(p => {
    if (p.lockedStart) return p.baseStart;
    if (p.prefs.prefWindow) return (p.prefs.prefWindow.start + p.prefs.prefWindow.end) / 2 % 24;
    if (p.prefs.earliest != null && p.prefs.latest != null) return (p.prefs.earliest + p.prefs.latest) / 2 % 24;
    return Math.random() * 24;
  });
  const used = new Set();
  for (const idx of shuffle(out.map((_, i) => i))) {
    const p = out[idx];
    if (p.lockedStart) { used.add(p.baseStart); continue; }
    let best = null, bestDist = Infinity;
    for (const s of evenStarts) {
      if (used.has(s)) continue;
      let d = Math.abs(s - desired[idx]);
      d = Math.min(d, 24 - d);
      if (d < bestDist) { bestDist = d; best = s; }
    }
    p.baseStart = best == null ? Math.floor(Math.random() * 24) : best;
    used.add(p.baseStart);
  }
  for (const p of out) {
    if (p.lockedDays) continue;
    const pool = [0, 1, 2, 3, 4, 5, 6].filter(d => !p.prefs.prefDaysOff.includes(d));
    const fallback = [0, 1, 2, 3, 4, 5, 6].filter(d => !p.unavailableDays.includes(d));
    const source = pool.length >= 5 ? pool : fallback;
    p.days = shuffle(source.slice()).slice(0, 5).sort((a, b) => a - b);
  }
  return out;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function proposeMove(people) {
  // With some probability, target an under-covered slot directly instead of a
  // blind random move. This gives the annealer a gradient toward full coverage.
  if (Math.random() < 0.35) {
    const targeted = coverageMove(people);
    if (targeted) return targeted;
  }
  return randomMove(people);
}

// Try to fix an under-covered slot by shifting a person who works that day so
// their shift covers the gap. Returns null if no useful move is available.
function coverageMove(people) {
  const out = clonePeople(people);
  const r = evaluate(out, state.weights);
  const gaps = [];
  for (let s = 0; s < SLOTS; s++) if (r.coverage[s] < 2) gaps.push(s);
  if (gaps.length) {
    const s = gaps[Math.floor(Math.random() * gaps.length)];
    const day = Math.floor(s / 24), hour = s % 24;
    // person working `day` can cover the gap by starting at `hour`
const cand = out.filter(p => p.days.includes(day) && !p.lockedStart);
    if (cand.length) {
      const p = cand[Math.floor(Math.random() * cand.length)];
if (overlapsUnavailable(hour, p.unavailableHours)) return null;
      if (state.variationOn) p.perDay[day] = hour;
      else p.baseStart = hour;
      return out;
    }
    // otherwise a person working the previous day with a late start crosses
    // midnight and covers early hours of `day`
    const prevDay = (day + 6) % 7;
    const cand2 = out.filter(p => p.days.includes(prevDay) && !p.lockedStart);
    if (cand2.length) {
      const p = cand2[Math.floor(Math.random() * cand2.length)];
const lo = Math.max(16, hour + 15);
if (lo <= 23 && !overlapsUnavailable(lo, p.unavailableHours)) {
        if (state.variationOn) p.perDay[prevDay] = lo;
        else p.baseStart = lo;
        return out;
      }
    }
  }
  return null;
}

function randomMove(people) {
  const out = clonePeople(people);
  const idx = Math.floor(Math.random() * out.length);
  const p = out[idx];
  const moveStart = Math.random() < 0.5;

  if (moveStart) {
    if (p.lockedStart) return out;
    if (state.variationOn && Math.random() < 0.5 && p.days.length) {
      const day = p.days[Math.floor(Math.random() * p.days.length)];
      p.perDay[day] = Math.floor(Math.random() * 24);
    } else {
      p.baseStart = Math.floor(Math.random() * 24);
    }
  } else {
    if (p.lockedDays) return out;
    const removeIdx = Math.floor(Math.random() * p.days.length);
    const candidates = [0, 1, 2, 3, 4, 5, 6].filter(d => !p.days.includes(d) && !p.unavailableDays.includes(d));
    if (!candidates.length) return out;
    const add = candidates[Math.floor(Math.random() * candidates.length)];
    p.days[removeIdx] = add;
    p.days.sort((a, b) => a - b);
  }
  return out;
}

function solve() {
  const weights = state.weights;
  const zeroWeights = Object.fromEntries(Object.keys(weights).map(k => [k, 0]));

  // Phase 1: find a feasible schedule (hard constraints only). Coverage-aware
  // moves give the annealer a gradient toward full coverage.
  let feasible = null, feasibleScore = Infinity;
  let bestHard = null, bestHardScore = Infinity;
  for (let a = 0; a < 8; a++) {
    let cur = initialPeople(state.people);
    let curScore = evaluate(cur, zeroWeights).total;
    let lb = clonePeople(cur), lbs = curScore;
    let T = 100;
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const next = proposeMove(cur);
      const ns = evaluate(next, zeroWeights).total;
      const d = ns - curScore;
      if (d <= 0 || Math.random() < Math.exp(-d / T)) {
        cur = next; curScore = ns;
        if (curScore < lbs) { lb = clonePeople(cur); lbs = curScore; }
      }
      T *= 0.9995;
    }
    lb = repairHard(lb, zeroWeights);
    const lr = evaluate(lb, zeroWeights);
    if (lr.hard === 0 && lr.total < feasibleScore) { feasible = lb; feasibleScore = lr.total; }
    if (lr.total < bestHardScore) { bestHard = lb; bestHardScore = lr.total; }
  }

  // If no fully feasible schedule was found, run extra hard-only attempts.
  let guard = 0;
  while (!feasible && guard++ < 4) {
    let cur = initialPeople(state.people);
    let curScore = evaluate(cur, zeroWeights).total;
    let lb = clonePeople(cur), lbs = curScore;
    let T = 100;
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const next = proposeMove(cur);
      const ns = evaluate(next, zeroWeights).total;
      const d = ns - curScore;
      if (d <= 0 || Math.random() < Math.exp(-d / T)) { cur = next; curScore = ns; if (curScore < lbs) { lb = clonePeople(cur); lbs = curScore; } }
      T *= 0.9995;
    }
    lb = repairHard(lb, zeroWeights);
    if (evaluate(lb, zeroWeights).hard === 0) feasible = lb;
  }

  // Phase 2: from the best feasible schedule, optimise soft constraints while
  // refusing any move that would break a hard constraint.
  const startFrom = feasible || bestHard;
  let best = clonePeople(startFrom), bestScore = evaluate(best, weights).total;
  let cur = clonePeople(startFrom), curScore = bestScore;
  let T = 40;
  const start = Date.now();
  while (Date.now() - start < 1800) {
    const next = proposeMove(cur);
    const ns = evaluate(next, weights).total;
    const nh = evaluate(next, zeroWeights).hard;
    if (nh > 0) { T *= 0.9995; continue; } // reject infeasible
    const d = ns - curScore;
    if (d <= 0 || Math.random() < Math.exp(-d / T)) {
      cur = next; curScore = ns;
      if (curScore < bestScore) { best = clonePeople(cur); bestScore = curScore; }
    }
    T *= 0.9995;
  }
  best = repairHard(best, weights);

  state.people = best;
  const result = evaluate(state.people, weights);
  state.lastResult = result;

  // update rotation history
  for (const p of state.people) {
    if (UNDESIRABLE_STARTS.includes(p.baseStart)) {
      state.rotationHistory[p.id] = state.weekNumber;
    }
  }
  state.weekNumber++;
  save();
  renderAll();
}

// Greedy repair: try adjusting each person's start hour and day set to
// eliminate coverage gaps and overstaffing, keeping only improving changes.
// Greedy repair that keeps trying start, per-day and day moves until every hard
// constraint is satisfied (or no single move improves the score). Because hard
// violations carry a huge penalty, this reliably drives a near-feasible schedule
// to full feasibility when one is reachable.
function repairHard(people, weights) {
  let cur = clonePeople(people);
  let guard = 0;
  while (guard++ < 400) {
    const r = evaluate(cur, weights);
    if (r.hard === 0) break;
    let curScore = r.total;
    let improved = false;
    for (let i = 0; i < cur.length; i++) {
      const p = cur[i];
      if (!p.lockedStart) {
        const orig = p.baseStart;
        for (let h = 0; h < 24; h++) {
          if (h === orig) continue;
          p.baseStart = h;
          const s = evaluate(cur, weights).total;
          if (s < curScore) { curScore = s; improved = true; }
          else p.baseStart = orig;
        }
        if (state.variationOn) {
          for (const d of p.days) {
            const origD = p.perDay[d];
            for (let h = 0; h < 24; h++) {
              if (h === origD) continue;
              p.perDay[d] = h;
              const s = evaluate(cur, weights).total;
              if (s < curScore) { curScore = s; improved = true; }
              else p.perDay[d] = origD;
            }
          }
        }
      }
      if (!p.lockedDays) {
        const origDays = p.days.slice();
        for (let di = 0; di < p.days.length; di++) {
          for (let d = 0; d < 7; d++) {
            if (p.days.includes(d) || p.unavailableDays.includes(d)) continue;
            p.days[di] = d;
            p.days.sort((a, b) => a - b);
            const s = evaluate(cur, weights).total;
            if (s < curScore) { curScore = s; improved = true; }
            else { p.days = origDays.slice(); }
          }
        }
      }
    }
    if (!improved) break;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Feasibility + validation
// ---------------------------------------------------------------------------
function feasibilityCheck() {
  const numPeople = state.people.length;
  const supply = numPeople * 5 * SHIFT_LEN;
  const demand = SLOTS * 2;
  const margin = supply - demand;
  return { supply, demand, margin, ok: supply >= demand };
}

function blockingReport(result) {
  const parts = [];
  if (result.under > 0) parts.push(`coverage gaps in ${result.under} slot(s) — add staff or lower the 2-person minimum`);
  if (result.over > 0) parts.push(`overstaffing (>3) in ${result.over} slot(s) — reduce staff or raise the cap`);
  if (result.restViol > 0) parts.push(`${result.restViol} rest-period violation(s) — allow shorter rest or fewer consecutive days`);
  if (result.unavailViol > 0) parts.push(`${result.unavailViol} assignment(s) to unavailable time — relax unavailability`);
  return parts.length ? parts : ["no specific hard constraint is blocking — the search may need more time"];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll() {
  renderFeasibility();
  renderValidation();
  renderHeatmap();
  renderRoster();
  renderWeights();
  renderPeople();
  document.getElementById("variationToggle").checked = state.variationOn;
}

function renderFeasibility() {
  const el = document.getElementById("feasibilityMsg");
  const f = feasibilityCheck();
  if (!f.ok) {
    el.className = "feasibility-msg err";
    el.textContent = `Infeasible: supply is ${f.supply} person-hours but demand is ${f.demand}. Shortfall: ${f.demand - f.supply} person-hours. Add staff or lower coverage requirements.`;
    return;
  }
  el.className = "feasibility-msg ok";
  el.textContent = `Feasible: ${f.supply} person-hours supplied vs ${f.demand} required (margin ${f.margin} person-hours, expected as handover/triple-coverage).`;
}

function renderValidation() {
  const list = document.getElementById("validationList");
  list.innerHTML = "";
  const r = state.lastResult;
  const items = [];

  if (!r) {
    items.push({ ok: true, text: "Run Solve to validate the schedule." });
  } else {
    const f = feasibilityCheck();
    items.push({ ok: f.ok, text: `Feasibility: ${f.supply} supplied / ${f.demand} required (margin ${f.margin})` });
    items.push({ ok: r.under === 0, text: `Coverage: ${SLOTS - r.under}/${SLOTS} slots have >=2 people` });
    items.push({ ok: r.over === 0, text: `Overstaffing: ${r.over} slot(s) above 3 people` });
    items.push({ ok: r.restViol === 0, text: `Rest periods: ${40 - r.restViol}/40 OK (>=11h)` });
    items.push({ ok: r.unavailViol === 0, text: `Unavailability: ${r.unavailViol} violation(s)` });
items.push({ ok: true, text: `Shifts: ${state.people.length} people x 5 shifts x 9h` });
    items.push({ ok: true, text: `Team soft score: ${r.soft.toFixed(1)} | Worst-off person: ${r.worst.toFixed(1)}` });
    if (r.hard > 0) {
      items.push({ ok: false, text: "Blocking: " + blockingReport(r).join("; ") });
    }
  }

  for (const it of items) {
    const div = document.createElement("div");
    div.className = "validation-item " + (it.ok ? "ok" : "bad");
    div.textContent = it.text;
    list.appendChild(div);
  }
}

function renderHeatmap() {
  const el = document.getElementById("heatmap");
  el.innerHTML = "";
  const coverage = state.lastResult ? state.lastResult.coverage : new Array(SLOTS).fill(0);

  const corner = document.createElement("div");
  corner.className = "hm-label";
  corner.textContent = "";
  el.appendChild(corner);
  for (let h = 0; h < 24; h++) {
    const d = document.createElement("div");
    d.className = "hm-hour";
    d.textContent = String(h).padStart(2, "0");
    el.appendChild(d);
  }
  for (let day = 0; day < 7; day++) {
    const label = document.createElement("div");
    label.className = "hm-label";
    label.textContent = DAYS[day];
    el.appendChild(label);
    for (let h = 0; h < 24; h++) {
      const c = coverage[day * 24 + h];
      const cell = document.createElement("div");
      cell.className = "hm-cell " + (c >= 2 && c <= 3 ? "c" + c : "cbad");
      cell.textContent = c;
      cell.title = `${DAYS[day]} ${String(h).padStart(2, "0")}:00 — ${c} on duty`;
      el.appendChild(cell);
    }
  }
}

// ---------------------------------------------------------------------------
// Roster grid
// ---------------------------------------------------------------------------
const PASTELS = [
  { bg: "#f8c8dc", fg: "#7a1f4d" },
  { bg: "#c8e6c9", fg: "#1b5e20" },
  { bg: "#bbdefb", fg: "#0d47a1" },
  { bg: "#ffe0b2", fg: "#bf360c" },
  { bg: "#d1c4e9", fg: "#4a148c" },
  { bg: "#b2ebf2", fg: "#006064" },
  { bg: "#fff9c4", fg: "#827717" },
  { bg: "#f0f4c3", fg: "#33691e" },
];

// Two-letter code from the first two characters of a name, first capitalised.
function shortCode(name) {
  const s = name.slice(0, 2);
  return s[0].toUpperCase() + s.slice(1);
}
function threeLetterCode(name) {
  const s = name.slice(0, 3);
  return s[0].toUpperCase() + s.slice(1);
}

// Generate a unique code per person; extend colliding codes to three letters.
function generateCodes(people) {
  const codes = {};
  for (const p of people) codes[p.id] = shortCode(p.name);
  const byCode = {};
  for (const p of people) (byCode[codes[p.id]] = byCode[codes[p.id]] || []).push(p);
  const warnings = [];
  for (const c in byCode) {
    if (byCode[c].length > 1) {
      for (const p of byCode[c]) codes[p.id] = threeLetterCode(p.name);
      warnings.push(`Duplicate code "${c}" — extended to 3 letters for ${byCode[c].map(p => p.name).join(", ")}`);
    }
  }
  return { codes, warnings };
}

function formatHour(h) {
  const period = h < 12 ? "AM" : "PM";
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${String(hr).padStart(2, "0")}:00 ${period}`;
}
function hourLabel(h) {
  return `${formatHour(h)} - ${formatHour((h + 1) % 24)}`;
}
function formatShiftStart(p) {
  return `${String(p.baseStart).padStart(2, "0")}:00-${String((p.baseStart + SHIFT_LEN) % 24).padStart(2, "0")}:00`;
}
function formatRestDays(offDays) {
  const sorted = offDays.slice().sort((a, b) => a - b);
  const runs = [];
  let run = [sorted[0]];
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k] === sorted[k - 1] + 1) run.push(sorted[k]);
    else { runs.push(run); run = [sorted[k]]; }
  }
  runs.push(run);
  return runs.map(r => r.length > 1 ? `${DAYS[r[0]]}-${DAYS[r[r.length - 1]]}` : DAYS[r[0]]).join(", ");
}
function offDaysOf(p) {
  return [0, 1, 2, 3, 4, 5, 6].filter(d => !p.days.includes(d));
}

// duty[day][hour] = array of person indices on duty that hour.
function buildDutyGrid() {
  const r = state.lastResult;
  const shifts = r ? r.personShifts : state.people.map(p => p.days.map(d => ({ day: d, start: effectiveStart(p, d) })));
  const duty = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  shifts.forEach((personShifts, i) => {
    for (const sh of personShifts) {
      for (const s of shiftSlots(sh.day, sh.start)) {
        duty[Math.floor(s / 24)][s % 24].push(i);
      }
    }
  });
  return duty;
}

function renderRoster() {
  const el = document.getElementById("roster");
  el.innerHTML = "";
  const { codes, warnings } = generateCodes(state.people);
  const duty = buildDutyGrid();
  const coverage = state.lastResult ? state.lastResult.coverage : new Array(SLOTS).fill(0);

  // single CSS grid: 1 hour column + 7 day blocks (each "#" + 8 person cols)
  const cols = ["150px"];
  for (let d = 0; d < 7; d++) cols.push("30px", "repeat(8, 1fr)");
  el.style.gridTemplateColumns = cols.join(" ");

  // header row 0: day names spanning each day block
  const h0 = document.createElement("div");
  h0.className = "r-hour";
  h0.textContent = "";
  el.appendChild(h0);
  for (let d = 0; d < 7; d++) {
    const cell = document.createElement("div");
    cell.className = "r-dayhead r-dayblock" + (d === 0 ? "" : "");
    cell.style.gridColumn = "span 9";
    cell.textContent = DAYS[d];
    el.appendChild(cell);
  }

  // header row 1: "#" + person codes
  const h1 = document.createElement("div");
  h1.className = "r-hour";
  h1.textContent = "";
  el.appendChild(h1);
  for (let d = 0; d < 7; d++) {
    const c = document.createElement("div");
    c.className = "r-count r-dayblock";
    c.textContent = "#";
    el.appendChild(c);
    for (let i = 0; i < state.people.length; i++) {
      const cell = document.createElement("div");
      cell.className = "r-cell";
      cell.textContent = codes[state.people[i].id];
      cell.style.background = PASTELS[i % PASTELS.length].bg;
      cell.style.color = PASTELS[i % PASTELS.length].fg;
      el.appendChild(cell);
    }
  }

  // 24 hour rows
  for (let h = 0; h < 24; h++) {
    const hl = document.createElement("div");
    hl.className = "r-hour";
    hl.textContent = hourLabel(h);
    el.appendChild(hl);
    for (let d = 0; d < 7; d++) {
      const count = duty[d][h].length;
      const cc = document.createElement("div");
      cc.className = "r-count r-dayblock" + (count < 2 ? " bad" : "");
      cc.textContent = count;
      cc.title = `${DAYS[d]} ${formatHour(h)} — ${count} on duty`;
      el.appendChild(cc);
      for (let i = 0; i < state.people.length; i++) {
        const cell = document.createElement("div");
        const on = duty[d][h].includes(i);
        cell.className = "r-cell" + (on ? "" : " blank");
        cell.textContent = on ? codes[state.people[i].id] : "";
        if (on) {
          cell.style.background = PASTELS[i % PASTELS.length].bg;
          cell.style.color = PASTELS[i % PASTELS.length].fg;
        }
        el.appendChild(cell);
      }
    }
  }

  renderRosterLegend(codes);
  renderRosterNotes(coverage, warnings);
}

function renderRosterLegend(codes) {
  const el = document.getElementById("rosterLegend");
  el.innerHTML = "";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Code", "Name", "Shift start", "Hours", "Rest days"].forEach(t => {
    const th = document.createElement("th");
    th.textContent = t;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  state.people.forEach((p, i) => {
    const tr = document.createElement("tr");
    const codeTd = document.createElement("td");
    const chip = document.createElement("span");
    chip.className = "code-chip";
    chip.textContent = codes[p.id];
    chip.style.background = PASTELS[i % PASTELS.length].bg;
    chip.style.color = PASTELS[i % PASTELS.length].fg;
    codeTd.appendChild(chip);
    tr.appendChild(codeTd);
    const nameTd = document.createElement("td");
    nameTd.textContent = p.name;
    tr.appendChild(nameTd);
    const startTd = document.createElement("td");
    startTd.textContent = formatShiftStart(p);
    tr.appendChild(startTd);
    const hoursTd = document.createElement("td");
    hoursTd.textContent = p.days.length * SHIFT_LEN;
    tr.appendChild(hoursTd);
    const restTd = document.createElement("td");
    restTd.textContent = formatRestDays(offDaysOf(p));
    tr.appendChild(restTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  el.appendChild(table);
}

function renderRosterNotes(coverage, warnings) {
  const el = document.getElementById("rosterNotes");
  el.innerHTML = "";

  // 1. coverage confirmation
  const h1 = document.createElement("h3");
  h1.textContent = "Coverage";
  el.appendChild(h1);
  const failing = [];
  for (let s = 0; s < SLOTS; s++) if (coverage[s] < 2) failing.push(s);
  const p1 = document.createElement("p");
  if (failing.length === 0) {
    p1.className = "ok";
    p1.textContent = "Coverage never drops below 2 across all 168 hours.";
  } else {
    p1.className = "err";
    p1.textContent = "Coverage drops below 2 in: " + failing.map(s => `${DAYS[Math.floor(s / 24)]} ${formatHour(s % 24)}`).join(", ");
  }
  el.appendChild(p1);

  // 2. shared rest-day pairs
  const h2 = document.createElement("h3");
  h2.textContent = "Shared rest-day pairs";
  el.appendChild(h2);
  const pairCount = {};
  for (const p of state.people) {
    const off = new Set(offDaysOf(p));
    for (let d = 0; d < 7; d++) {
      if (off.has(d) && off.has((d + 1) % 7)) {
        const key = `${DAYS[d]}-${DAYS[(d + 1) % 7]}`;
        pairCount[key] = (pairCount[key] || 0) + 1;
      }
    }
  }
  const shared = Object.entries(pairCount).filter(([, n]) => n > 1);
  const p2 = document.createElement("p");
  if (shared.length === 0) {
    p2.textContent = "No rest-day pair is shared by more than one person.";
  } else {
    p2.className = "warn";
    p2.textContent = "Shared by more than one person: " + shared.map(([k, n]) => `${k} (${n} people)`).join(", ");
  }
  el.appendChild(p2);

  // 3. resting on a weekend day
  const h3 = document.createElement("h3");
  h3.textContent = "Resting on a weekend day";
  el.appendChild(h3);
  const weekendResters = state.people.filter(p => offDaysOf(p).some(d => d === 5 || d === 6));
  const p3 = document.createElement("p");
  if (weekendResters.length === 0) {
    p3.textContent = "No one is resting on a Saturday or Sunday this week.";
  } else {
    p3.textContent = "Resting on a weekend day: " + weekendResters.map(p => {
      const days = offDaysOf(p).filter(d => d === 5 || d === 6).map(d => DAYS[d]);
      return `${p.name} (${days.join(", ")})`;
    }).join("; ");
  }
  el.appendChild(p3);

  if (warnings.length) {
    const hw = document.createElement("h3");
    hw.textContent = "Warnings";
    el.appendChild(hw);
    const ul = document.createElement("ul");
    for (const w of warnings) {
      const li = document.createElement("li");
      li.className = "warn";
      li.textContent = w;
      ul.appendChild(li);
    }
    el.appendChild(ul);
  }
}

function renderWeights() {
  const el = document.getElementById("weightsPanel");
  el.innerHTML = "";
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const item = document.createElement("div");
    item.className = "weight-item";
    const label = document.createElement("label");
    label.textContent = WEIGHT_LABELS[key];
    const val = document.createElement("span");
    val.className = "wval";
    val.id = "wval-" + key;
    val.textContent = state.weights[key];
    label.appendChild(val);
    const input = document.createElement("input");
    input.type = "range";
    input.min = 0;
    input.max = 30;
    input.step = 1;
    input.value = state.weights[key];
    input.addEventListener("input", () => {
      state.weights[key] = Number(input.value);
      val.textContent = state.weights[key];
      save();
    });
    item.appendChild(label);
    item.appendChild(input);
    el.appendChild(item);
  }
}

function renderPeople() {
  const el = document.getElementById("peoplePanel");
  el.innerHTML = "";
  const r = state.lastResult;

  state.people.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "person-card";

    const head = document.createElement("h3");
    head.textContent = p.name;
    const score = document.createElement("span");
    score.className = "score";
    const personal = r ? r.personal[i] : 0;
    const sat = Math.max(0, Math.round(100 - personal));
    score.textContent = `satisfaction ${sat}/100`;
    head.appendChild(score);
    card.appendChild(head);

    // locks
    const lockRow = document.createElement("div");
    lockRow.className = "lock-row";
    lockRow.appendChild(lockCheckbox("Lock start", p, "lockedStart"));
    lockRow.appendChild(lockCheckbox("Lock days", p, "lockedDays"));
    card.appendChild(lockRow);

    // start hour
    card.appendChild(numberField("Start hour (0-23)", p.baseStart, v => { p.baseStart = v; save(); renderAll(); }, 0, 23));

    // days
    const dayField = document.createElement("div");
    dayField.className = "field";
    const dayLabel = document.createElement("label");
    dayLabel.textContent = "Working days (pick 5)";
    dayField.appendChild(dayLabel);
    const dayRow = document.createElement("div");
    dayRow.className = "day-row";
    for (let d = 0; d < 7; d++) {
      const chip = document.createElement("span");
      chip.className = "day-chip" + (p.days.includes(d) ? " on" : "");
      chip.textContent = DAYS[d];
chip.addEventListener("click", () => {
        if (p.lockedDays) return;
        if (p.days.includes(d)) {
          if (p.days.length > 1) p.days = p.days.filter(x => x !== d);
        } else {
          if (p.days.length < 5) { p.days.push(d); p.days.sort((a, b) => a - b); }
        }
        save(); renderAll();
      });
      dayRow.appendChild(chip);
    }
    dayField.appendChild(dayRow);
    card.appendChild(dayField);

    // prefs
    card.appendChild(prefControls(p));

    // unavailable
    card.appendChild(unavailableControls(p));

    // stats
    const stats = document.createElement("div");
    stats.className = "stats";
    const shifts = r ? r.personShifts[i] : p.days.map(d => ({ day: d, start: effectiveStart(p, d) }));
    const overnight = shifts.filter(s => isOvernight(s.start)).length;
    const weekend = shifts.filter(s => isWeekend(s.day)).length;
    stats.appendChild(stat("Hours", shifts.length * SHIFT_LEN));
    stats.appendChild(stat("Overnight", overnight));
    stats.appendChild(stat("Weekend", weekend));
    stats.appendChild(stat("Score", sat));
    card.appendChild(stats);

    // unmet prefs
    const unmet = unmetPrefs(p, shifts);
    if (unmet.length) {
      const u = document.createElement("div");
      u.className = "unmet";
      u.innerHTML = "<b>Preferences not met:</b><ul>" + unmet.map(x => `<li>${x}</li>`).join("") + "</ul>";
      card.appendChild(u);
    }

    el.appendChild(card);
  });
}

function lockCheckbox(label, p, key) {
  const lab = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = p[key];
  cb.addEventListener("change", () => { p[key] = cb.checked; save(); renderAll(); });
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode(label));
  return lab;
}

function numberField(label, value, onChange, min, max) {
  const field = document.createElement("div");
  field.className = "field";
  const l = document.createElement("label");
  l.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.min = min;
  input.max = max;
  input.value = value;
  input.addEventListener("change", () => {
    let v = Number(input.value);
    if (isNaN(v)) v = value;
    v = Math.max(min, Math.min(max, v));
    onChange(v);
  });
  field.appendChild(l);
  field.appendChild(input);
  return field;
}

function prefControls(p) {
  const wrap = document.createElement("div");
  const prefs = p.prefs;

  // preferred window
  const winField = document.createElement("div");
  winField.className = "field";
  const winLabel = document.createElement("label");
  winLabel.textContent = "Preferred start window (or 'no preference')";
  winField.appendChild(winLabel);
  const winRow = document.createElement("div");
  winRow.style.display = "flex";
  winRow.style.gap = "6px";
  const noPref = document.createElement("input");
  noPref.type = "checkbox";
  noPref.checked = !prefs.prefWindow;
  const noPrefLabel = document.createElement("label");
  noPrefLabel.style.fontSize = "11px";
  noPrefLabel.style.color = "var(--muted)";
  noPrefLabel.appendChild(noPref);
  noPrefLabel.appendChild(document.createTextNode(" no preference"));
  const sIn = document.createElement("input");
  sIn.type = "number"; sIn.min = 0; sIn.max = 23; sIn.value = prefs.prefWindow ? prefs.prefWindow.start : 6;
  const eIn = document.createElement("input");
  eIn.type = "number"; eIn.min = 0; eIn.max = 23; eIn.value = prefs.prefWindow ? prefs.prefWindow.end : 10;
  sIn.style.width = "60px"; eIn.style.width = "60px";
  const applyWin = () => {
    if (noPref.checked) prefs.prefWindow = null;
    else prefs.prefWindow = { start: Number(sIn.value), end: Number(eIn.value) };
    save(); renderAll();
  };
  noPref.addEventListener("change", () => { sIn.disabled = noPref.checked; eIn.disabled = noPref.checked; applyWin(); });
  sIn.addEventListener("change", applyWin);
  eIn.addEventListener("change", applyWin);
  sIn.disabled = noPref.checked; eIn.disabled = noPref.checked;
  winRow.appendChild(noPrefLabel);
  winRow.appendChild(sIn);
  winRow.appendChild(document.createTextNode(" to "));
  winRow.appendChild(eIn);
  winField.appendChild(winRow);
  wrap.appendChild(winField);

  // earliest / latest
  const boundsRow = document.createElement("div");
  boundsRow.style.display = "flex";
  boundsRow.style.gap = "6px";
  const eField = numberField("Earliest start", prefs.earliest == null ? 0 : prefs.earliest, v => { prefs.earliest = v; save(); renderAll(); }, 0, 23);
  const lField = numberField("Latest start", prefs.latest == null ? 23 : prefs.latest, v => { prefs.latest = v; save(); renderAll(); }, 0, 23);
  eField.style.flex = "1"; lField.style.flex = "1";
  boundsRow.appendChild(eField);
  boundsRow.appendChild(lField);
  wrap.appendChild(boundsRow);

  // preferred days off
  const offField = document.createElement("div");
  offField.className = "field";
  const offLabel = document.createElement("label");
  offLabel.textContent = "Preferred days off";
  offField.appendChild(offLabel);
  const offRow = document.createElement("div");
  offRow.className = "day-row";
  for (let d = 0; d < 7; d++) {
    const chip = document.createElement("span");
    chip.className = "day-chip" + (prefs.prefDaysOff.includes(d) ? " on" : "");
    chip.textContent = DAYS[d];
    chip.addEventListener("click", () => {
      if (prefs.prefDaysOff.includes(d)) prefs.prefDaysOff = prefs.prefDaysOff.filter(x => x !== d);
      else prefs.prefDaysOff.push(d);
      save(); renderAll();
    });
    offRow.appendChild(chip);
  }
  offField.appendChild(offRow);
  wrap.appendChild(offField);

  // consecutive off
  const cons = document.createElement("label");
  cons.style.display = "flex";
  cons.style.alignItems = "center";
  cons.style.gap = "6px";
  cons.style.fontSize = "12px";
  cons.style.color = "var(--muted)";
  const consCb = document.createElement("input");
  consCb.type = "checkbox";
  consCb.checked = prefs.wantConsecutiveOff;
  consCb.addEventListener("change", () => { prefs.wantConsecutiveOff = consCb.checked; save(); renderAll(); });
  cons.appendChild(consCb);
  cons.appendChild(document.createTextNode("Wants consecutive days off"));
  wrap.appendChild(cons);

  // max overnight / weekend
  const maxRow = document.createElement("div");
  maxRow.style.display = "flex";
  maxRow.style.gap = "6px";
  const mo = numberField("Max overnight", prefs.maxOvernight, v => { prefs.maxOvernight = v; save(); renderAll(); }, 0, 5);
  const mw = numberField("Max weekend", prefs.maxWeekend, v => { prefs.maxWeekend = v; save(); renderAll(); }, 0, 2);
  mo.style.flex = "1"; mw.style.flex = "1";
  maxRow.appendChild(mo);
  maxRow.appendChild(mw);
  wrap.appendChild(maxRow);

  return wrap;
}

function unavailableControls(p) {
  const wrap = document.createElement("div");
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = "Unavailable days";
  field.appendChild(label);
  const row = document.createElement("div");
  row.className = "day-row";
  for (let d = 0; d < 7; d++) {
    const chip = document.createElement("span");
    chip.className = "day-chip" + (p.unavailableDays.includes(d) ? " on" : "");
    chip.textContent = DAYS[d];
    chip.addEventListener("click", () => {
      if (p.unavailableDays.includes(d)) p.unavailableDays = p.unavailableDays.filter(x => x !== d);
      else p.unavailableDays.push(d);
      save(); renderAll();
    });
    row.appendChild(chip);
  }
  field.appendChild(row);
  wrap.appendChild(field);
  return wrap;
}

function stat(label, value) {
  const s = document.createElement("div");
  s.className = "stat";
  s.innerHTML = `${label}: <b>${value}</b>`;
  return s;
}

function unmetPrefs(p, shifts) {
  const out = [];
  const base = p.baseStart;
  if (p.prefs.prefWindow) {
    const { start, end } = p.prefs.prefWindow;
    if (base < start) out.push(`start ${base}:00 is before preferred window (${start}:00-${end}:00)`);
    else if (base > end) out.push(`start ${base}:00 is after preferred window (${start}:00-${end}:00)`);
  }
  if (p.prefs.earliest != null && base < p.prefs.earliest) out.push(`start ${base}:00 is before earliest acceptable (${p.prefs.earliest}:00)`);
  if (p.prefs.latest != null && base > p.prefs.latest) out.push(`start ${base}:00 is after latest acceptable (${p.prefs.latest}:00)`);
  for (const d of p.prefs.prefDaysOff) if (p.days.includes(d)) out.push(`working on preferred day off (${DAYS[d]})`);
  if (p.prefs.wantConsecutiveOff) {
    const offDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !p.days.includes(d));
    if (!hasConsecutiveOff(offDays)) out.push("off days are not consecutive");
  }
  const overnight = shifts.filter(s => isOvernight(s.start)).length;
  if (overnight > p.prefs.maxOvernight) out.push(`${overnight} overnight shifts (max ${p.prefs.maxOvernight})`);
  const weekend = shifts.filter(s => isWeekend(s.day)).length;
  if (weekend > p.prefs.maxWeekend) out.push(`${weekend} weekend shifts (max ${p.prefs.maxWeekend})`);
  return out;
}

// ---------------------------------------------------------------------------
// Export CSV
// ---------------------------------------------------------------------------
function exportCSV() {
  const { codes } = generateCodes(state.people);
  const duty = buildDutyGrid();
  const rows = [];

  // header row 0: day names
  const h0 = [""];
  for (let d = 0; d < 7; d++) {
    h0.push(DAYS[d]);
    for (let i = 0; i < state.people.length; i++) h0.push("");
  }
  rows.push(h0);

  // header row 1: "#" + person codes
  const h1 = [""];
  for (let d = 0; d < 7; d++) {
    h1.push("#");
    for (let i = 0; i < state.people.length; i++) h1.push(codes[state.people[i].id]);
  }
  rows.push(h1);

  // 24 hour rows
  for (let h = 0; h < 24; h++) {
    const row = [hourLabel(h)];
    for (let d = 0; d < 7; d++) {
      row.push(duty[d][h].length);
      for (let i = 0; i < state.people.length; i++) {
        row.push(duty[d][h].includes(i) ? codes[state.people[i].id] : "");
      }
    }
    rows.push(row);
  }

  const csv = rows.map(r2 => r2.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "shift-schedule.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function init() {
  load();
  document.getElementById("solveBtn").addEventListener("click", solve);
  document.getElementById("exportBtn").addEventListener("click", exportCSV);
  document.getElementById("resetBtn").addEventListener("click", resetToDemo);
  document.getElementById("variationToggle").addEventListener("change", e => {
    state.variationOn = e.target.checked;
    save();
    renderAll();
  });
  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
