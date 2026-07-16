/**
 * plan-generator.js
 * Core algorithmic engine for the fitness PWA.
 *
 * Entry point: generateWeeklyPlan(userProfile, exerciseDB, trainingHistory)
 * Returns a fully specified 1-week microcycle + nutrition dashboard targets.
 *
 * Design notes:
 * - No equipment fallbacks exist anywhere. Exercise selection ranks ONLY by
 *   biomechanical suitability score for the slot being filled.
 * - Mode 1 (hypertrophy) and Mode 2 (sprint) share the scheduler shell but use
 *   completely separate physiological rule sets (volume-driven vs CNS-budget-driven).
 */

// ---------------------------------------------------------------------------
// 1. CONSTANTS — the evidence-based guardrails
// ---------------------------------------------------------------------------

const HYPERTROPHY = {
  FREQ_PER_MUSCLE: { min: 2, max: 3 },          // sessions per muscle per week
  WEEKLY_SETS:     { min: 12, default: 16, max: 28 },
  SETS_PER_EXERCISE: { min: 3, max: 4 },         // consolidated: fewer exercises, solid sets each
  DAY_EXERCISE_CAP: { min: 4, max: 6 },          // hard ceiling — never dump every muscle into one session
  CUT_VOLUME_MULTIPLIER: 0.75,                   // -25% (middle of the 20–30% band)
  REST_SEC: 60,                                  // metabolic-stress default
  TEMPO: "2-0-1-0",                              // controlled 2s eccentric
  MESOCYCLE_WEEKS: 5,                            // accumulation length before deload
  DELOAD_WEEKS: { min: 1, max: 3 },
  PLATEAU_WINDOW_WEEKS: 3,
  // DUP zones rotated across the week for every muscle group.
  // All zones are taken to volitional failure (RIR 0-1), so hypertrophic
  // stimulus is load-independent across the 30–100% 1RM spectrum.
  DUP_ZONES: [
    { name: "heavy",     repRange: "6-8",   pctLoad: [0.78, 0.85], restSec: 90,  targetRIR: 1 },
    { name: "moderate",  repRange: "8-12",  pctLoad: [0.65, 0.75], restSec: 60,  targetRIR: 0 },
    { name: "metabolic", repRange: "20-30", pctLoad: [0.30, 0.50], restSec: 45,  targetRIR: 0 },
  ],
  PLATEAU_TECHNIQUES: ["drop_set", "superset_antagonist", "cluster_set", "accentuated_eccentric", "bfr"],
};

const SPRINT = {
  TARGET_RIR: { min: 2, max: 3 },               // NEVER to failure
  REST_SEC: { min: 180, max: 300 },
  MAX_STRENGTH_REPS: "1-5",
  CNS_BUDGET_PER_SESSION: 14,                    // sum of cnsCost across a session
  SESSION_TEMPLATES: [
    // Ordered by priority; the scheduler fills as many as frequency allows.
    { name: "Max Strength (Lower)",  slots: ["squat:maxStrength", "hinge:maxStrength", "calf_raise:maxStrength"] },
    { name: "Power / Plyometrics",   slots: ["depth_drop:rfdPower", "jump_vertical:rfdPower", "bound:rfdPower", "sprint_drill:rfdPower"] },
    { name: "Unilateral + Eccentric Durability", slots: ["lunge_split:sprintTransfer", "knee_flexion_iso:eccentric", "knee_extension_iso:eccentric", "hip_adduction:sprintTransfer", "trunk_antirotation:sprintTransfer"] },
    { name: "Max Strength (Upper) + Reactive",   slots: ["horizontal_push:maxStrength", "horizontal_pull:maxStrength", "jump_horizontal:rfdPower"] },
  ],
};

const NUTRITION = {
  PROTEIN_G_PER_KG: { min: 1.6, max: 2.2 },
  MEALS: { min: 3, max: 4 },
  PROTEIN_PER_MEAL_G: { min: 20, max: 40 },
  PRE_BED_PROTEIN_G: 35, // slow-digesting (casein) recommendation
};

const MUSCLES_UPPER = ["chest", "front_delts", "side_delts", "rear_delts", "lats", "upper_back", "traps", "biceps", "triceps"];
const MUSCLES_LOWER = ["quadriceps", "hamstrings", "glutes", "adductors", "calves"];
const MUSCLES_PUSH  = ["chest", "front_delts", "side_delts", "triceps"];
const MUSCLES_PULL  = ["lats", "upper_back", "rear_delts", "traps", "biceps"];

// Large, multi-joint muscle groups that anchor a session — always claim a slot first.
// Small/isolation groups are accessories: they get folded into leftover slots via
// indirect (secondary-muscle) credit, or deferred to another day in the split.
const PRIMARY_MUSCLES = new Set(["quadriceps", "hamstrings", "glutes", "chest", "lats", "upper_back", "front_delts"]);
const ACCESSORY_MUSCLES = new Set(["side_delts", "rear_delts", "traps", "biceps", "triceps", "calves", "adductors", "forearms", "abs", "obliques", "hip_flexors"]);

// ---------------------------------------------------------------------------
// 2. SPLIT SELECTION (hypertrophy) — guarantees 2–3x weekly frequency/muscle
// ---------------------------------------------------------------------------

const HYPERTROPHY_SPLITS = {
  2: ["FULL", "FULL"],
  3: ["FULL", "FULL", "FULL"],
  4: ["UPPER", "LOWER", "UPPER", "LOWER"],
  5: ["UPPER", "LOWER", "PUSH", "PULL", "LEGS"],
  6: ["PUSH", "PULL", "LEGS", "PUSH", "PULL", "LEGS"],
};

const DAY_MUSCLE_MAP = {
  FULL:  [...MUSCLES_UPPER, ...MUSCLES_LOWER],
  UPPER: MUSCLES_UPPER,
  LOWER: MUSCLES_LOWER,
  PUSH:  MUSCLES_PUSH,
  PULL:  MUSCLES_PULL,
  LEGS:  MUSCLES_LOWER,
};

// ---------------------------------------------------------------------------
// 3. MAIN ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * @param {Object} user            { bodyWeightKg, daysPerWeek (2-6), mode: 'hypertrophy'|'sprint', phase: 'bulk'|'cut', weeksIntoMeso }
 * @param {Array}  exerciseDB      Array of exercise objects matching exercise-database.schema.json
 * @param {Object} trainingHistory { [exerciseId]: [{date, bestE1RM}] , lastWeekZonesByMuscle: {...} }
 */
export function generateWeeklyPlan(user, exerciseDB, trainingHistory = {}) {
  const nutrition = buildNutritionTargets(user);

  // Strategic deload: after a full mesocycle, output a deload microcycle instead.
  if (user.mode === "hypertrophy" && user.weeksIntoMeso >= HYPERTROPHY.MESOCYCLE_WEEKS) {
    return {
      type: "deload",
      note: "1–3 week strategic deload. Muscle thickness and strength are preserved during short detraining; resume the next mesocycle re-sensitized to volume.",
      week: buildDeloadWeek(user, exerciseDB),
      nutrition,
    };
  }

  const week = user.mode === "hypertrophy"
    ? buildHypertrophyWeek(user, exerciseDB, trainingHistory)
    : buildSprintWeek(user, exerciseDB, trainingHistory);

  return { type: "training", week, nutrition };
}

// ---------------------------------------------------------------------------
// 4. MODE 1 — HYPERTROPHY ENGINE (volume-driven, DUP, failure-based)
// ---------------------------------------------------------------------------

function buildHypertrophyWeek(user, exerciseDB, history) {
  const splitDays = HYPERTROPHY_SPLITS[clamp(user.daysPerWeek, 2, 6)];

  // --- 4a. Weekly volume landmarks per muscle ---------------------------------
  const weeklySetTargets = {};
  const allMuscles = [...MUSCLES_UPPER, ...MUSCLES_LOWER];
  // Low-frequency trainees get the low end of the 12–28 band so sessions stay feasible.
  const baseByFrequency = { 2: 12, 3: 14, 4: 16, 5: 16, 6: 16 };
  for (const muscle of allMuscles) {
    let sets = baseByFrequency[splitDays.length] ?? HYPERTROPHY.WEEKLY_SETS.default;
    // Cutting: recovery is impaired → cut volume 20–30%, KEEP intensity (load stays heavy).
    if (user.phase === "cut") sets = Math.round(sets * HYPERTROPHY.CUT_VOLUME_MULTIPLIER);
    weeklySetTargets[muscle] = clamp(sets, HYPERTROPHY.WEEKLY_SETS.min, HYPERTROPHY.WEEKLY_SETS.max);
  }

  // --- 4b. Distribute weekly sets across the days that train each muscle ------
  const daySessions = splitDays.map((dayType, i) => ({
    dayIndex: i + 1,
    label: dayType,
    muscleSetBudget: {},
    exercises: [],
  }));

  for (const muscle of allMuscles) {
    const hitDays = daySessions.filter(d => DAY_MUSCLE_MAP[d.label].includes(muscle));
    // Frequency guardrail: 2–3 direct sessions per muscle per week.
    const activeDays = hitDays.slice(0, HYPERTROPHY.FREQ_PER_MUSCLE.max);
    const perDay = Math.round(weeklySetTargets[muscle] / activeDays.length);
    activeDays.forEach(d => { d.muscleSetBudget[muscle] = perDay; });
  }

  // --- 4c. DUP: rotate rep/load zones per muscle across its weekly sessions ---
  // Each successive session hitting a muscle uses the next zone, offset weekly
  // so week-to-week the pattern shifts (variable stimulus, no adaptation plateau).
  const weekOffset = (user.weeksIntoMeso || 0) % HYPERTROPHY.DUP_ZONES.length;
  const muscleSessionCounter = {};

  const dbById = Object.fromEntries(exerciseDB.map(e => [e.id, e]));
  // Process big compound targets first so smaller muscles can be credited
  // with the indirect volume those compounds already provide.
  const MUSCLE_PRIORITY = ["quadriceps", "hamstrings", "glutes", "chest", "lats", "upper_back", "front_delts", "adductors", "calves", "side_delts", "rear_delts", "traps", "triceps", "biceps"];

  // Primary muscles always outrank accessories, regardless of split-day ordering.
  // Ties within a tier fall back to the general size/impact priority above.
  const muscleRank = m => (PRIMARY_MUSCLES.has(m) ? 0 : 1000) + MUSCLE_PRIORITY.indexOf(m);

  for (const session of daySessions) {
    const orderedMuscles = Object.entries(session.muscleSetBudget)
      .sort((a, b) => muscleRank(a[0]) - muscleRank(b[0]));

    // The full list of muscles this day is supposed to touch — used to score
    // exercises that cover more than one of today's targets at once (consolidation).
    const dayMuscleSet = new Set(orderedMuscles.map(([m]) => m));

    for (const [muscle, rawBudget] of orderedMuscles) {
      // HARD CEILING: once the session hits its max exercise count, stop.
      // Remaining (always lower-priority/accessory) muscles are dropped for
      // today — they still get their weekly volume on their other 2-3 sessions,
      // or indirectly whenever a compound already lists them as secondary.
      const slotsLeft = HYPERTROPHY.DAY_EXERCISE_CAP.max - session.exercises.length;
      if (slotsLeft <= 0) break;

      // Indirect-volume credit: each set of an already-slotted exercise that lists
      // this muscle as secondary counts as half a direct set.
      const indirect = session.exercises.reduce((acc, e) =>
        acc + ((dbById[e.exerciseId]?.muscles.secondary ?? []).includes(muscle) ? e.sets * 0.5 : 0), 0);
      const setBudget = Math.max(0, rawBudget - Math.round(indirect));
      if (setBudget < HYPERTROPHY.SETS_PER_EXERCISE.min) continue; // fully covered indirectly today

      const nth = (muscleSessionCounter[muscle] = (muscleSessionCounter[muscle] ?? -1) + 1);
      const zone = HYPERTROPHY.DUP_ZONES[(nth + weekOffset) % HYPERTROPHY.DUP_ZONES.length];

      // 3–4 sets per exercise → derive how many exercises this muscle needs today,
      // but never request more than the slots actually remaining in the session.
      const idealExercises = Math.max(1, Math.ceil(setBudget / HYPERTROPHY.SETS_PER_EXERCISE.max));
      const exercisesNeeded = Math.min(idealExercises, slotsLeft);
      // Folding the same set budget into fewer exercises means each one carries
      // more sets — clamp with a slightly wider ceiling so volume isn't silently lost.
      const setsPerExercise = clamp(
        Math.round(setBudget / exercisesNeeded),
        HYPERTROPHY.SETS_PER_EXERCISE.min,
        HYPERTROPHY.SETS_PER_EXERCISE.max + 1
      );

      const picks = selectHypertrophyExercises({
        exerciseDB, muscle, zone, count: exercisesNeeded,
        // DUP exercise rotation: exclude what was used for this muscle last week.
        excludeIds: history.lastWeekExerciseIdsByMuscle?.[muscle] ?? [],
        alreadyPickedToday: session.exercises.map(e => e.exerciseId),
        // Smart consolidation: favor compounds whose secondary muscles also
        // belong to today's target list, so one exercise pre-credits another
        // muscle's budget instead of needing a separate accessory slot.
        otherDayMuscles: dayMuscleSet,
      });

      for (const ex of picks) {
        const prescription = {
          exerciseId: ex.id,
          name: ex.name,
          muscle,
          sets: setsPerExercise,
          repRange: zone.repRange,
          pctLoad: zone.pctLoad,
          restSec: zone.name === "moderate" ? HYPERTROPHY.REST_SEC : zone.restSec,
          tempo: ex.programming.defaultTempo || HYPERTROPHY.TEMPO,
          intent: "volitional muscular failure",
          targetRIR: zone.targetRIR,
        };
        // Plateau busting: 3 weeks with no e1RM progress → attach advanced technique.
        const technique = resolvePlateauTechnique(ex, history);
        if (technique) prescription.advancedTechnique = technique;
        session.exercises.push(prescription);
      }
    }
  }

  // --- 4d. Frequency backfill ------------------------------------------------
  // The cap can drop a muscle from one of its assigned days entirely. Before
  // finalizing, top up any muscle that fell below its 2x/week minimum by
  // slotting one exercise into another of its assigned days that still has
  // spare slots under the cap — keeping weekly frequency intact without ever
  // breaking the per-day ceiling.
  for (const muscle of allMuscles) {
    const assignedDays = daySessions.filter(d => muscle in d.muscleSetBudget);
    if (!assignedDays.length) continue;

    const hitDays = assignedDays.filter(d => d.exercises.some(e => e.muscle === muscle));
    if (hitDays.length >= HYPERTROPHY.FREQ_PER_MUSCLE.min) continue;

    for (const day of assignedDays) {
      if (hitDays.includes(day)) continue;
      if (day.exercises.length >= HYPERTROPHY.DAY_EXERCISE_CAP.max) continue;

      const zone = HYPERTROPHY.DUP_ZONES[(muscleSessionCounter[muscle] ?? 0) % HYPERTROPHY.DUP_ZONES.length];
      muscleSessionCounter[muscle] = (muscleSessionCounter[muscle] ?? 0) + 1;

      const [pick] = selectHypertrophyExercises({
        exerciseDB, muscle, zone, count: 1,
        excludeIds: history.lastWeekExerciseIdsByMuscle?.[muscle] ?? [],
        alreadyPickedToday: day.exercises.map(e => e.exerciseId),
        otherDayMuscles: new Set(Object.keys(day.muscleSetBudget)),
      });
      if (!pick) continue;

      day.exercises.push({
        exerciseId: pick.id,
        name: pick.name,
        muscle,
        sets: HYPERTROPHY.SETS_PER_EXERCISE.min,
        repRange: zone.repRange,
        pctLoad: zone.pctLoad,
        restSec: zone.name === "moderate" ? HYPERTROPHY.REST_SEC : zone.restSec,
        tempo: pick.programming.defaultTempo || HYPERTROPHY.TEMPO,
        intent: "volitional muscular failure (frequency top-up)",
        targetRIR: zone.targetRIR,
      });
      hitDays.push(day);
      if (hitDays.length >= HYPERTROPHY.FREQ_PER_MUSCLE.min) break;
    }
  }

  // Final ordering: high axial/CNS cost compounds first, stable machine work last.
  for (const session of daySessions) {
    session.exercises.sort((a, b) => exerciseCost(exerciseDB, b.exerciseId) - exerciseCost(exerciseDB, a.exerciseId));
  }

  return daySessions;
}

function selectHypertrophyExercises({ exerciseDB, muscle, zone, count, excludeIds, alreadyPickedToday, otherDayMuscles }) {
  const candidates = exerciseDB.filter(ex =>
    ex.muscles.primary.includes(muscle) &&
    ex.programming.repRangeCompatibility.includes(zone.repRange) &&
    // Weekly DUP exercise rotation applies to ISOLATION work only. Core
    // compounds persist across weeks: progressive overload and the 3-week
    // plateau detector both require a stable lift to accumulate e1RM history.
    !(excludeIds.includes(ex.id) && ex.movement.mechanics === "isolation") &&
    !alreadyPickedToday.includes(ex.id)
  );

  const score = ex => {
    // Consolidation bonus: exercises whose secondary muscles overlap with
    // other muscles the day still needs to hit reduce how many separate
    // accessory slots we'll need later.
    const overlap = (ex.muscles.secondary ?? []).filter(m => otherDayMuscles?.has(m)).length;
    return ex.suitability.hypertrophy * 10 + overlap * 2 + Number(ex.movement.loadedAtLongMuscleLength);
  };

  // Greedy selection: pick the best exercise first, then require each further
  // pick to hit this muscle from a DIFFERENT angle (movement pattern or
  // resistance profile) than what's already chosen. Two "Pendulum Squat +
  // Hack Squat"-style picks (same pattern, same joint angle) are redundant
  // stimulus, not complementary coverage — this prevents that. Equipment
  // class is a fallback diversity axis for muscles (e.g. upper back) whose
  // exercise pool is dominated by a single movement pattern.
  const picked = [];
  const remaining = [...candidates];

  while (picked.length < count && remaining.length) {
    const usedPatterns = new Set(picked.map(p => p.movement.pattern));
    const usedProfiles = new Set(picked.map(p => p.movement.resistanceProfile));
    const usedEquip = new Set(picked.map(p => p.equipmentClass));

    const diversePool = remaining.filter(ex =>
      !usedPatterns.has(ex.movement.pattern) ||
      !usedProfiles.has(ex.movement.resistanceProfile) ||
      !usedEquip.has(ex.equipmentClass)
    );
    const pool = (picked.length === 0 || diversePool.length === 0) ? remaining : diversePool;

    pool.sort((a, b) => score(b) - score(a));
    const next = pool[0];
    picked.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }

  return picked;
}

/** Stalled for PLATEAU_WINDOW_WEEKS → deterministically rotate through techniques. */
function resolvePlateauTechnique(exercise, history) {
  const log = history[exercise.id];
  if (!log || log.length < HYPERTROPHY.PLATEAU_WINDOW_WEEKS) return null;

  const recent = log.slice(-HYPERTROPHY.PLATEAU_WINDOW_WEEKS);
  const stalled = recent.every(entry => entry.bestE1RM <= recent[0].bestE1RM);
  if (!stalled) return null;

  const compatible = HYPERTROPHY.PLATEAU_TECHNIQUES.filter(t =>
    (exercise.advancedTechniqueCompatibility ?? []).includes(t)
  );
  if (!compatible.length) return null;
  // Rotate technique by how long the stall has persisted.
  return compatible[(log.length - HYPERTROPHY.PLATEAU_WINDOW_WEEKS) % compatible.length];
}

function buildDeloadWeek(user, exerciseDB) {
  // Halve frequency and volume; keep movement patterns greased with sub-maximal loads.
  const days = Math.max(2, Math.floor(user.daysPerWeek / 2));
  return Array.from({ length: days }, (_, i) => ({
    dayIndex: i + 1,
    label: "FULL (deload)",
    note: "≤50% of normal weekly sets, loads ~60–70% of working weights, RIR 4+.",
    exercises: [],
  }));
}

// ---------------------------------------------------------------------------
// 5. MODE 2 — SPRINT / POWER ENGINE (CNS-budget-driven, never to failure)
// ---------------------------------------------------------------------------

function buildSprintWeek(user, exerciseDB, history) {
  const days = clamp(user.daysPerWeek, 2, 4); // >4 CNS-intensive days is counterproductive
  const templates = SPRINT.SESSION_TEMPLATES.slice(0, days);

  return templates.map((template, i) => {
    const session = { dayIndex: i + 1, label: template.name, exercises: [], cnsCostUsed: 0 };

    for (const slot of template.slots) {
      const [pattern, quality] = slot.split(":");
      const pick = selectSprintExercise(exerciseDB, pattern, quality, session);
      if (!pick) continue;

      // Hard CNS ceiling: reject this pick if it would exceed the budget,
      // but keep scanning later (cheaper) slots.
      if (session.cnsCostUsed + pick.programming.cnsCost > SPRINT.CNS_BUDGET_PER_SESSION) continue;
      session.cnsCostUsed += pick.programming.cnsCost;

      session.exercises.push({
        exerciseId: pick.id,
        name: pick.name,
        sets: quality === "maxStrength" ? 4 : 3,
        repRange: quality === "maxStrength" ? SPRINT.MAX_STRENGTH_REPS : "3-5",
        pctLoad: quality === "maxStrength" ? [0.85, 0.95] : null, // plyos are bodyweight/ballistic
        restSec: SPRINT.REST_SEC.max, // full ATP-PC + neural recovery, always 180–300s
        tempo: quality === "eccentric" ? "4-0-X-0" : "X-0-X-0",   // explosive concentric intent
        targetRIR: SPRINT.TARGET_RIR.min, // 2–3 RIR — failure is never programmed
        intent: quality === "eccentric"
          ? "slow eccentric overload → fascicle lengthening for sprint durability"
          : "maximal bar/body speed, terminate set on velocity drop",
      });
    }
    return session;
  });
}

function selectSprintExercise(exerciseDB, pattern, quality, session) {
  const scoreKey = quality === "eccentric" ? "sprintTransfer" : quality;
  const remainingBudget = SPRINT.CNS_BUDGET_PER_SESSION - session.cnsCostUsed;
  return exerciseDB
    .filter(ex =>
      ex.movement.pattern === pattern &&
      ex.programming.cnsCost <= remainingBudget &&
      !session.exercises.some(e => e.exerciseId === ex.id) &&
      (quality !== "eccentric" || ex.movement.contractionEmphasis === "eccentric_overload")
    )
    .sort((a, b) =>
      (b.suitability[scoreKey] - a.suitability[scoreKey]) ||
      // Prefer unilateral where scores tie (sprinting is a unilateral activity).
      (Number(b.movement.laterality === "unilateral") - Number(a.movement.laterality === "unilateral"))
    )[0] ?? null;
}

// ---------------------------------------------------------------------------
// 6. NUTRITION DASHBOARD
// ---------------------------------------------------------------------------

function buildNutritionTargets(user) {
  const kg = user.bodyWeightKg;
  // Cutting biases protein to the top of the range (muscle retention in a deficit).
  const gPerKg = user.phase === "cut" ? NUTRITION.PROTEIN_G_PER_KG.max : 1.8;
  const dailyProteinG = Math.round(kg * gPerKg);

  // Distribute across 3–4 meals of 20–40g each.
  let meals = NUTRITION.MEALS.max;
  if (dailyProteinG / meals < NUTRITION.PROTEIN_PER_MEAL_G.min) meals = NUTRITION.MEALS.min;
  const perMeal = clamp(Math.round(dailyProteinG / meals), NUTRITION.PROTEIN_PER_MEAL_G.min, NUTRITION.PROTEIN_PER_MEAL_G.max);

  return {
    dailyProteinG,
    proteinRangeG: [Math.round(kg * NUTRITION.PROTEIN_G_PER_KG.min), Math.round(kg * NUTRITION.PROTEIN_G_PER_KG.max)],
    mealPlan: { meals, proteinPerMealG: perMeal },
    preBed: { proteinG: NUTRITION.PRE_BED_PROTEIN_G, source: "slow-digesting (casein) protein" },
    note: user.phase === "cut"
      ? "Caloric deficit active: protein set to 2.2 g/kg; training volume already reduced 20–30% by the plan generator."
      : "Caloric surplus: prioritize hitting per-meal protein doses around training.",
  };
}

// ---------------------------------------------------------------------------
// 7. UTILITIES
// ---------------------------------------------------------------------------

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

// ---------------------------------------------------------------------------
// 8. WEEKLY SCHEDULING — rest-day placement science per frequency
// ---------------------------------------------------------------------------
// assignment: array of 7 entries (index 0 = Monday … 6 = Sunday);
// each entry is a session index into plan.week, or null for a rest day.

const SCHEDULE_TEMPLATES = {
  hypertrophy: {
    2: { days: [0, 3],             order: [0, 1],          guidance: "Full body 2×/week: keep 2–3 rest days between sessions (Mon/Thu) so every muscle gets ~72h recovery between its two weekly hits." },
    3: { days: [0, 2, 4],          order: [0, 1, 2],       guidance: "Full body every other day (Mon/Wed/Fri): 48h between sessions is sufficient because per-session volume per muscle is moderate." },
    4: { days: [0, 1, 3, 4],       order: [0, 1, 2, 3],    guidance: "Upper/Lower 2-on-1-off (Mon/Tue, rest Wed, Thu/Fri): the same muscles never train on consecutive days, and the weekend stays free for recovery." },
    5: { days: [0, 1, 2, 4, 5],    order: [0, 1, 2, 3, 4], guidance: "Hybrid split: heaviest sessions early in the week, rest Thursday before the Push/Pull/Legs block, full rest Sunday." },
    6: { days: [0, 1, 2, 3, 4, 5], order: [0, 1, 2, 3, 4, 5], guidance: "PPL ×2 with one full rest day (Sun): each muscle still gets ~72h between its two weekly sessions because the split never repeats a muscle on consecutive days." },
  },
  sprint: {
    2: { days: [0, 3],             order: [0, 1],          guidance: "Two CNS-heavy sessions need 48–72h between them (Mon/Thu). More rest here is a feature, not laziness — RFD adaptations consolidate during recovery." },
    3: { days: [0, 2, 5],          order: [0, 2, 1],       guidance: "High/low alternation (Mon/Wed/Sat): never stack two high-CNS days back to back. The eccentric/unilateral day sits between the max-strength and plyometric days." },
    4: { days: [0, 1, 3, 5],       order: [0, 2, 1, 3],    guidance: "High/low wave (Mon/Tue/Thu/Sat): Max Strength → low-CNS Eccentric/Unilateral → Plyometrics → Upper+Reactive. Heavy CNS days are always separated by 48h+." },
  },
  deload: {
    2: { days: [0, 3],             order: [0, 1],          guidance: "Deload: two easy sessions, spread evenly. The point is staying in motion while fatigue dissipates." },
    3: { days: [0, 2, 4],          order: [0, 1, 2],       guidance: "Deload: three easy sessions on alternating days at ≤50% volume." },
  },
};

/**
 * Returns { assignment: (sessionIndex|null)[7], guidance } for a plan.
 * @param {string} mode 'hypertrophy' | 'sprint' | 'deload'
 * @param {number} sessionCount number of sessions in plan.week
 */
export function defaultSchedule(mode, sessionCount) {
  const table = SCHEDULE_TEMPLATES[mode] ?? SCHEDULE_TEMPLATES.hypertrophy;
  const tpl = table[sessionCount] ?? table[Math.max(...Object.keys(table).map(Number).filter(k => k <= sessionCount))] ?? Object.values(table)[0];
  const assignment = Array(7).fill(null);
  tpl.days.forEach((weekday, i) => { assignment[weekday] = tpl.order[i] ?? i; });
  return { assignment, guidance: tpl.guidance };
}

function exerciseCost(exerciseDB, id) {
  const ex = exerciseDB.find(e => e.id === id);
  return ex ? ex.programming.axialLoadCost + ex.programming.cnsCost : 0;
}

// ---------------------------------------------------------------------------
// Example invocation
// ---------------------------------------------------------------------------
// import db from './exercise-database.seed.json';
// const plan = generateWeeklyPlan(
//   { bodyWeightKg: 82, daysPerWeek: 5, mode: 'hypertrophy', phase: 'cut', weeksIntoMeso: 2 },
//   db,
//   { bench_press: [{ date: '...', bestE1RM: 120 }, { date: '...', bestE1RM: 120 }, { date: '...', bestE1RM: 119 }] }
// );