/* app.js — Overload controller
 * Wires the DOM to the rule-based engine (plan-generator.js),
 * persists everything to localStorage, and runs the rest timer.
 */
import { generateWeeklyPlan, defaultSchedule } from "./plan-generator.js";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};
const K = {
  PROFILE: "ov_profile",          // { bodyWeightKg, daysPerWeek, mode, phase }
  MESO_START: "ov_meso_start",    // ISO date the current mesocycle began
  PLAN: "ov_plan",                // { weekKey, plan }
  HISTORY: "ov_history",          // { [exerciseId]: [{week, bestE1RM}] }
  LAST_ROTATION: "ov_rotation",   // { current: {weekKey, byMuscle}, previous: {weekKey, byMuscle} }
  SET_LOGS: "ov_setlogs",         // flat array of every logged set
  DONE: "ov_done",                // { [weekKey:day:exerciseId]: setsCompleted }
  SCHEDULE: "ov_schedule",        // { key: mode:sessionCount, assignment: (sessionIdx|null)[7] }
};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let EXDB = [];
let currentPlan = null;
let activeDay = 0;
const $ = sel => document.querySelector(sel);

const ZONE = {
  "6-8":   { cls: "p-heavy",  css: "var(--zone-heavy)",  label: "Heavy" },
  "8-12":  { cls: "p-mod",    css: "var(--zone-mod)",    label: "Moderate" },
  "12-20": { cls: "p-mod",    css: "var(--zone-mod)",    label: "Moderate" },
  "20-30": { cls: "p-meta",   css: "var(--zone-meta)",   label: "Metabolic" },
  "1-5":   { cls: "p-sprint", css: "var(--zone-sprint)", label: "Max / Power" },
  "3-5":   { cls: "p-sprint", css: "var(--zone-sprint)", label: "Power" },
};
const zoneOf = (rx, mode) => mode === "sprint"
  ? (ZONE[rx.repRange] ?? ZONE["3-5"])
  : (ZONE[rx.repRange] ?? ZONE["8-12"]);

const isoWeek = (d = new Date()) => {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return dt.getUTCFullYear() + "-W" + String(Math.ceil((((dt - yearStart) / 864e5) + 1) / 7)).padStart(2, "0");
};
const weeksIntoMeso = () => {
  const start = store.get(K.MESO_START);
  if (!start) return 0;
  return Math.floor((Date.now() - new Date(start).getTime()) / (7 * 864e5));
};
const epleyE1RM = (kg, reps) => Math.round(kg * (1 + reps / 30) * 10) / 10;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  EXDB = await fetch("./exercises.json").then(r => r.json());

  const profile = store.get(K.PROFILE);
  if (!profile) return showSetup();

  const saved = store.get(K.PLAN);
  if (saved && saved.weekKey === isoWeek()) {
    currentPlan = saved.plan;
    ensureSchedule();
    activeDay = todaysSessionOrNext();
    showDashboard();
  } else {
    regenerate(); // a new calendar week began → fresh microcycle, DUP rotates
  }
}

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------
function showSetup() {
  $("#dashboard").hidden = true;
  $("#setup").hidden = false;
  const p = store.get(K.PROFILE);
  if (p) {
    $("#bodyweight").value = p.bodyWeightKg;
    pickSeg("#days-seg", "days", String(p.daysPerWeek));
    pickSeg("#phase-seg", "phase", p.phase);
    [...$("#mode-cards").children].forEach(b => b.classList.toggle("active", b.dataset.mode === p.mode));
    $("#phase-field").hidden = p.mode === "sprint";
  }
}
function pickSeg(segSel, dataKey, value) {
  [...$(segSel).children].forEach(b => b.classList.toggle("active", b.dataset[dataKey] === value));
}
function segValue(segSel, dataKey) {
  return $(segSel).querySelector(".active")?.dataset[dataKey];
}

document.addEventListener("click", e => {
  const seg = e.target.closest(".seg button");
  if (seg) { [...seg.parentElement.children].forEach(b => b.classList.toggle("active", b === seg)); return; }
  const mode = e.target.closest(".mode-card");
  if (mode) {
    [...mode.parentElement.children].forEach(b => b.classList.toggle("active", b === mode));
    // Bulk/cut volume logic only applies to the hypertrophy pathway.
    $("#phase-field").hidden = mode.dataset.mode === "sprint";
  }
});

$("#setup-form").addEventListener("submit", e => {
  e.preventDefault();
  const profile = {
    bodyWeightKg: parseFloat($("#bodyweight").value),
    daysPerWeek: parseInt(segValue("#days-seg", "days"), 10),
    mode: $("#mode-cards .active").dataset.mode,
    phase: segValue("#phase-seg", "phase") ?? "bulk",
  };
  store.set(K.PROFILE, profile);
  if (!store.get(K.MESO_START)) store.set(K.MESO_START, new Date().toISOString());
  regenerate();
});

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------
function regenerate() {
  const profile = store.get(K.PROFILE);
  const wk = isoWeek();

  // Week-aware rotation memory: exclusions must come from LAST week's plan.
  // Regenerating within the same week reuses the same exclusions instead of
  // treating the plan we just made as "last week" (which churned everything).
  const rot = store.get(K.LAST_ROTATION, { current: null, previous: null });
  const exclusionSource = rot.current?.weekKey === wk ? rot.previous : rot.current;

  const history = {
    ...store.get(K.HISTORY, {}),
    lastWeekExerciseIdsByMuscle: exclusionSource?.byMuscle ?? {},
  };
  currentPlan = generateWeeklyPlan(
    { ...profile, weeksIntoMeso: weeksIntoMeso() },
    EXDB,
    history
  );
  store.set(K.PLAN, { weekKey: wk, plan: currentPlan });

  // Remember what was programmed per muscle → next week's DUP exercise rotation.
  if (currentPlan.type === "training") {
    const byMuscle = {};
    for (const day of currentPlan.week) {
      for (const ex of day.exercises) {
        if (!ex.muscle) continue;
        (byMuscle[ex.muscle] ??= []).includes(ex.exerciseId) || byMuscle[ex.muscle].push(ex.exerciseId);
      }
    }
    store.set(K.LAST_ROTATION, {
      current: { weekKey: wk, byMuscle },
      previous: rot.current?.weekKey === wk ? rot.previous : rot.current,
    });
  }
  ensureSchedule();
  activeDay = todaysSessionOrNext();
  showDashboard();
}

// ---------------------------------------------------------------------------
// Weekly schedule (calendar)
// ---------------------------------------------------------------------------
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
let scheduleEditing = false;
let scheduleSelectedCell = null;

function scheduleMode() {
  return currentPlan.type === "deload" ? "deload" : store.get(K.PROFILE).mode;
}

/** Load the saved schedule if it matches the current plan shape, else reset to the default. */
function ensureSchedule() {
  const key = scheduleMode() + ":" + currentPlan.week.length;
  const saved = store.get(K.SCHEDULE);
  if (saved?.key === key) return saved.assignment;
  const { assignment } = defaultSchedule(scheduleMode(), currentPlan.week.length);
  store.set(K.SCHEDULE, { key, assignment });
  return assignment;
}

function getAssignment() { return store.get(K.SCHEDULE).assignment; }

function todaysSessionOrNext() {
  const assignment = ensureSchedule();
  const today = (new Date().getDay() + 6) % 7; // 0 = Monday
  for (let offset = 0; offset < 7; offset++) {
    const s = assignment[(today + offset) % 7];
    if (s != null && currentPlan.week[s]) return s;
  }
  return 0;
}

function renderCalendar() {
  const cal = $("#week-cal");
  cal.innerHTML = "";
  const assignment = getAssignment();
  const today = (new Date().getDay() + 6) % 7;
  const profile = store.get(K.PROFILE);

  assignment.forEach((sessionIdx, weekday) => {
    const cell = document.createElement("button");
    cell.type = "button";
    const session = sessionIdx != null ? currentPlan.week[sessionIdx] : null;
    cell.className = "cal-cell"
      + (session ? " training" : " rest")
      + (weekday === today ? " today" : "")
      + (session && sessionIdx === activeDay && !scheduleEditing ? " active" : "")
      + (scheduleEditing && scheduleSelectedCell === weekday ? " selected" : "");
    cell.innerHTML = `
      <span class="cal-dow">${WEEKDAYS[weekday]}</span>
      <span class="cal-label">${session ? esc(shortLabel(session.label)) : "Rest"}</span>`;
    cell.addEventListener("click", () => onCalendarTap(weekday));
    cal.appendChild(cell);
  });

  const { guidance } = defaultSchedule(scheduleMode(), currentPlan.week.length);
  $("#cal-guidance").textContent = guidance;
  $("#cal-hint").hidden = !scheduleEditing;
  $("#edit-schedule").textContent = scheduleEditing ? "Done" : "Move days";
  renderScheduleWarnings(assignment, profile.mode);
}

function shortLabel(label) {
  return label.replace("Max Strength", "Max Str.").replace(" + Eccentric Durability", "/Ecc").replace(" / Plyometrics", "/Plyo").replace(" + Reactive", "");
}

function onCalendarTap(weekday) {
  const assignment = getAssignment();
  if (!scheduleEditing) {
    if (assignment[weekday] != null) { activeDay = assignment[weekday]; renderCalendar(); renderDay(); }
    return;
  }
  // Edit mode: first tap selects a workout day, second tap swaps it with the target day.
  if (scheduleSelectedCell == null) {
    if (assignment[weekday] != null) { scheduleSelectedCell = weekday; renderCalendar(); }
    return;
  }
  [assignment[scheduleSelectedCell], assignment[weekday]] = [assignment[weekday], assignment[scheduleSelectedCell]];
  store.set(K.SCHEDULE, { ...store.get(K.SCHEDULE), assignment });
  scheduleSelectedCell = null;
  renderCalendar();
}

/** Soft recovery warnings — never blocks the user's choice, just informs it. */
function renderScheduleWarnings(assignment, mode) {
  const warnings = [];
  const labels = assignment.map(s => (s != null ? currentPlan.week[s]?.label : null));

  // Overlapping muscle groups on consecutive days (<48h recovery).
  const OVERLAP = { UPPER: ["UPPER", "PUSH", "PULL"], LOWER: ["LOWER", "LEGS"], LEGS: ["LEGS", "LOWER"], PUSH: ["PUSH", "UPPER"], PULL: ["PULL", "UPPER"], FULL: ["FULL", "UPPER", "LOWER", "PUSH", "PULL", "LEGS"] };
  for (let d = 0; d < 6; d++) {
    const a = labels[d], b = labels[d + 1];
    if (a && b && (OVERLAP[a]?.includes(b) || a === b)) {
      warnings.push(`${WEEKDAYS[d]}→${WEEKDAYS[d + 1]}: ${a} and ${b} overlap — the same muscles get <48h recovery.`);
    }
  }

  // Sprint: two high-CNS sessions back to back.
  if (mode === "sprint") {
    const HIGH_CNS = ["Max Strength (Lower)", "Power / Plyometrics"];
    for (let d = 0; d < 6; d++) {
      const a = assignment[d] != null ? currentPlan.week[assignment[d]]?.label : null;
      const b = assignment[d + 1] != null ? currentPlan.week[assignment[d + 1]]?.label : null;
      if (HIGH_CNS.includes(a) && HIGH_CNS.includes(b)) {
        warnings.push(`${WEEKDAYS[d]}→${WEEKDAYS[d + 1]}: two high-CNS sessions back to back — give the nervous system 48h.`);
      }
    }
  }

  // Long unbroken training runs.
  let run = 0, maxRun = 0;
  for (const s of assignment) { run = s != null ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
  if (maxRun >= 5) warnings.push(`${maxRun} training days in a row — consider spacing in a rest day.`);

  $("#cal-warnings").innerHTML = warnings.map(w => `<p class="cal-warn">⚠ ${esc(w)}</p>`).join("");
}

// ---------------------------------------------------------------------------
// Dashboard rendering
// ---------------------------------------------------------------------------
function showDashboard() {
  $("#setup").hidden = true;
  $("#dashboard").hidden = false;
  const profile = store.get(K.PROFILE);

  $("#meso-status").textContent =
    (profile.mode === "sprint" ? "Sprint · " : profile.phase === "cut" ? "Cut · " : "Bulk · ")
    + "meso week " + (weeksIntoMeso() + 1);

  const isDeload = currentPlan.type === "deload";
  $("#deload-banner").hidden = !isDeload;
  if (isDeload) $("#deload-note").textContent = currentPlan.note;

  ensureSchedule();
  renderCalendar();
  renderDay();
  renderNutrition();
}

function renderDay() {
  const list = $("#workout-list");
  list.innerHTML = "";
  const day = currentPlan.week[activeDay];
  const profile = store.get(K.PROFILE);

  if (!day.exercises.length) {
    list.innerHTML = `<div class="ex-card"><p class="intent">${esc(day.note ?? "Rest / active recovery.")}</p></div>`;
    return;
  }

  const totalSets = day.exercises.reduce((a, e) => a + e.sets, 0);
  const summary = document.createElement("p");
  summary.className = "day-summary";
  summary.textContent = `${day.label} — ${day.exercises.length} exercises · ${totalSets} working sets`;
  list.appendChild(summary);

  for (const rx of day.exercises) {
    const zone = zoneOf(rx, profile.mode);
    const doneKey = [isoWeek(), day.dayIndex, rx.exerciseId].join(":");
    const done = store.get(K.DONE, {})[doneKey] ?? 0;
    const loadTxt = rx.pctLoad ? Math.round(rx.pctLoad[0] * 100) + "–" + Math.round(rx.pctLoad[1] * 100) + "%" : "BW / ballistic";
    const best = latestE1RM(rx.exerciseId);
    const last = lastPerformance(rx.exerciseId);

    const card = document.createElement("article");
    card.className = "ex-card" + (done >= rx.sets ? " complete" : "");
    card.style.setProperty("--zone", zone.css);
    card.innerHTML = `
      <div class="ex-top">
        <i class="plate ${zone.cls}"></i>
        <div>
          <div class="ex-name">${esc(rx.name)}</div>
          <div class="ex-muscle">${esc(rx.muscle ?? "athletic quality")}</div>
        </div>
        <span class="ex-zone">${zone.label}</span>
      </div>
      ${rx.advancedTechnique ? `<span class="technique">Plateau breaker · ${esc(rx.advancedTechnique.replace(/_/g, " "))}</span>` : ""}
      <div class="ex-rx">
        <span class="rx"><b>${rx.sets}×${rx.repRange}</b><small>sets × reps</small></span>
        <span class="rx"><b>${loadTxt}</b><small>load · 1RM</small></span>
        <span class="rx"><b>${rx.tempo}</b><small>tempo</small></span>
        <span class="rx"><b>${rx.restSec}s</b><small>rest</small></span>
        ${rx.targetRIR != null ? `<span class="rx"><b>${rx.targetRIR === 0 ? "0 (failure)" : rx.targetRIR}</b><small>RIR</small></span>` : ""}
      </div>
      <p class="intent">${esc(rx.intent ?? "")}</p>
      ${last ? `<p class="last-time">Last time: <b>${last.kg}kg × ${last.reps}</b></p>` : ""}
      <div class="set-row">
        <span class="set-plates">${Array.from({ length: rx.sets }, (_, i) =>
          `<i class="plate ${zone.cls}${i < done ? " done" : ""}"></i>`).join("")}</span>
        <span class="set-inputs">
          <input type="number" inputmode="decimal" placeholder="kg" aria-label="Weight in kilograms" step="0.5" min="0" value="${last ? last.kg : ""}" />
          <input type="number" inputmode="numeric" placeholder="reps" aria-label="Repetitions" min="1" max="50" value="${last ? last.reps : ""}" />
        </span>
        <button class="log-btn" type="button">Log set</button>
      </div>
      ${best ? `<div class="e1rm-note">best e1RM this block: ${best} kg</div>` : ""}
    `;

    card.querySelector(".log-btn").addEventListener("click", () => {
      const [kgEl, repsEl] = card.querySelectorAll(".set-inputs input");
      const kg = parseFloat(kgEl.value), reps = parseInt(repsEl.value, 10);
      logSet(rx, day, doneKey, kg, reps);
      renderDay();
      startRest(rx.restSec, rx.name, zone.css);
    });

    list.appendChild(card);
  }
}

function latestE1RM(exerciseId) {
  const log = store.get(K.HISTORY, {})[exerciseId];
  return log?.length ? log[log.length - 1].bestE1RM : null;
}

/** Most recent logged set for this exercise, across any previous session. */
function lastPerformance(exerciseId) {
  const logs = store.get(K.SET_LOGS, []);
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].exerciseId === exerciseId) return logs[i];
  }
  return null;
}

function logSet(rx, day, doneKey, kg, reps) {
  const doneMap = store.get(K.DONE, {});
  doneMap[doneKey] = Math.min((doneMap[doneKey] ?? 0) + 1, rx.sets);
  store.set(K.DONE, doneMap);

  if (!kg || !reps) return; // set counted even without load data (e.g. plyometrics)

  const logs = store.get(K.SET_LOGS, []);
  logs.push({ t: Date.now(), exerciseId: rx.exerciseId, kg, reps });
  store.set(K.SET_LOGS, logs);

  // Weekly-best e1RM history — this is what the 3-week plateau detector reads.
  const e1rm = epleyE1RM(kg, reps);
  const history = store.get(K.HISTORY, {});
  const entries = (history[rx.exerciseId] ??= []);
  const wk = isoWeek();
  const last = entries[entries.length - 1];
  if (last && last.week === wk) last.bestE1RM = Math.max(last.bestE1RM, e1rm);
  else entries.push({ week: wk, date: new Date().toISOString(), bestE1RM: e1rm });
  store.set(K.HISTORY, history);
}

function renderNutrition() {
  const n = currentPlan.nutrition;
  $("#nutrition-body").innerHTML = `
    <div class="nut-grid">
      <span class="rx"><b>${n.dailyProteinG} g</b><small>protein / day</small></span>
      <span class="rx"><b>${n.mealPlan.meals} × ${n.mealPlan.proteinPerMealG} g</b><small>meals</small></span>
      <span class="rx"><b>${n.preBed.proteinG} g</b><small>pre-bed casein</small></span>
    </div>
    <p class="nut-note">${esc(n.note)}</p>`;
}

// ---------------------------------------------------------------------------
// Rest timer
// ---------------------------------------------------------------------------
let restTimer = null;
function startRest(seconds, nextLabel, zoneCss) {
  clearInterval(restTimer);
  const bar = $("#rest-bar"), fill = $("#rest-fill"), time = $("#rest-time");
  bar.hidden = false;
  bar.style.setProperty("--zone", zoneCss);
  $("#rest-next").textContent = nextLabel;
  let remaining = seconds;

  const tick = () => {
    time.textContent = Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0");
    fill.style.transform = `scaleX(${remaining / seconds})`;
    if (remaining-- <= 0) {
      clearInterval(restTimer);
      bar.hidden = true;
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]); // gym-friendly cue
    }
  };
  tick();
  restTimer = setInterval(tick, 1000);
}
$("#rest-skip").addEventListener("click", () => { clearInterval(restTimer); $("#rest-bar").hidden = true; });

// ---------------------------------------------------------------------------
// Dashboard actions
// ---------------------------------------------------------------------------
$("#edit-profile").addEventListener("click", showSetup);
$("#regen-week").addEventListener("click", regenerate);
$("#edit-schedule").addEventListener("click", () => {
  scheduleEditing = !scheduleEditing;
  scheduleSelectedCell = null;
  renderCalendar();
});
$("#new-meso").addEventListener("click", () => {
  store.set(K.MESO_START, new Date().toISOString());
  regenerate();
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

boot();