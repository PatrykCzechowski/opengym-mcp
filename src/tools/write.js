// Write tools. Each `edit(S, params)` changes the profile document in place and returns what the
// caller should hear back; the gateway runs it inside mutate(), so it may be replayed on a newer
// document after a conflict and must derive everything from S. Validation throws before any
// change is made, so a bad call never half-applies.
import { z } from 'zod'
import { uid } from '../../vendor/opengym/frontend/src/lib/format.js'
import { copyRoutine, deleteRoutine } from '../../vendor/opengym/frontend/src/lib/routines.js'
import { buildCompletedWorkout } from '../../vendor/opengym/frontend/src/lib/finish-workout.js'
import { backfillStart, backfillEnd, completeBackfill } from '../../vendor/opengym/frontend/src/lib/backfill.js'
import { editCompletedSession, saveWorkoutEdit, deleteEditedWorkout } from '../../vendor/opengym/frontend/src/lib/session-edit.js'
import { rebuildPrHistory } from '../../vendor/opengym/frontend/src/lib/workout-date.js'
import { stampWorkout } from '../../vendor/opengym/frontend/src/lib/sync-merge.js'
import { workoutVolume, bestWeightForEntry } from '../../vendor/opengym/frontend/src/lib/history.js'
import { refillAfter } from '../../vendor/opengym/frontend/src/lib/rotation.js'
import { exerciseMuscleSnapshot, inMuscleOrder } from '../../vendor/opengym/frontend/src/lib/muscles.js'
import { parsePlan, mergePlan } from '../../vendor/opengym/frontend/src/lib/plan-share.js'
import {
  fail, isoDate, todayIso, weekday, dayIndex, muscle, PROGRESSIONS,
  routineExerciseSchema, routineExercise, requireRoutine, requireExercise, exerciseOf
} from './shared.js'

const summary = r => ({ id: r.id, name: r.name, emoji: r.emoji || null, exercise_count: (r.ex || []).length })

/* ---------- routines ---------- */

const createRoutine = {
  name: 'create_routine',
  description: 'Create a new routine (a named list of exercises with set/rep targets), exactly as the routine editor would. It is not scheduled on any day until you call set_weekday_routines. Exercise ids come from search_exercises.',
  schema: {
    name: z.string().min(1).max(80),
    emoji: z.string().max(40).optional().describe("the app's icon key, e.g. barbell, legs, pullup, figureStrength"),
    progression: z.enum(PROGRESSIONS).optional().describe('default rule for exercises that do not set their own'),
    exercises: z.array(routineExerciseSchema).max(40).default([])
  },
  edit: (S, p) => {
    const routine = { id: uid(), name: p.name.trim(), ...(p.emoji ? { emoji: p.emoji } : {}), ...(p.progression ? { prog: p.progression } : {}), ex: p.exercises.map(e => routineExercise(e, S)) }
    S.routines.push(routine)
    return { created: summary(routine) }
  }
}

const updateRoutine = {
  name: 'update_routine',
  description: "Rename a routine or change its icon, default progression rule, or whether its sessions count for progression. To change its exercises use set_routine_exercises or the per-exercise tools.",
  schema: {
    routine_id: z.string().min(1),
    name: z.string().min(1).max(80).optional(),
    emoji: z.string().max(40).optional(),
    progression: z.enum(PROGRESSIONS).nullable().optional().describe('null removes the routine default'),
    exclude_from_progression: z.boolean().optional()
  },
  edit: (S, p) => {
    const r = requireRoutine(S, p.routine_id)
    if (p.name != null) r.name = p.name.trim()
    if (p.emoji != null) r.emoji = p.emoji
    if (p.progression === null) delete r.prog
    else if (p.progression) r.prog = p.progression
    if (p.exclude_from_progression === true) r.excludeFromProgression = true
    else if (p.exclude_from_progression === false) delete r.excludeFromProgression
    return { updated: summary(r) }
  }
}

const deleteRoutineTool = {
  name: 'delete_routine',
  description: 'Delete a routine and every pointer to it: its weekdays and any per-date reschedule that names it. Logged workouts done from it stay in the history.',
  schema: { routine_id: z.string().min(1) },
  edit: (S, p) => {
    const r = requireRoutine(S, p.routine_id)
    const dropped = deleteRoutine(S, r.id)
    return { deleted: summary(r), reschedules_removed: Object.keys(dropped) }
  }
}

const duplicateRoutine = {
  name: 'duplicate_routine',
  description: 'Copy a routine under a new id, named "<name> (Copy)" unless a name is given. The copy is not scheduled.',
  schema: { routine_id: z.string().min(1), name: z.string().min(1).max(80).optional() },
  edit: (S, p) => {
    const copy = copyRoutine(requireRoutine(S, p.routine_id))
    if (p.name) copy.name = p.name.trim()
    S.routines.push(copy)
    return { created: summary(copy) }
  }
}

const setRoutineExercises = {
  name: 'set_routine_exercises',
  description: "Replace a routine's whole exercise list, in order. Neighbouring exercises with the same superset tag are done as a superset. Use get_routine first if you only mean to change part of it.",
  schema: { routine_id: z.string().min(1), exercises: z.array(routineExerciseSchema).max(40) },
  edit: (S, p) => {
    const r = requireRoutine(S, p.routine_id)
    r.ex = p.exercises.map(e => routineExercise(e, S))
    return { updated: summary(r) }
  }
}

const position = () => z.number().int().min(1).describe('1-based position, as get_routine numbers them')

const addRoutineExercise = {
  name: 'add_routine_exercise',
  description: 'Add one exercise to a routine, at the end or at a 1-based position.',
  schema: { routine_id: z.string().min(1), exercise: routineExerciseSchema, position: position().optional() },
  edit: (S, p) => {
    const r = requireRoutine(S, p.routine_id)
    const cfg = routineExercise(p.exercise, S)
    const at = p.position == null ? r.ex.length : Math.min(p.position - 1, r.ex.length)
    r.ex.splice(at, 0, cfg)
    return { updated: summary(r), position: at + 1 }
  }
}

function slot(r, pos) {
  if (pos > (r.ex || []).length) throw fail('EINVAL', `routine ${JSON.stringify(r.name)} has ${(r.ex || []).length} exercises; there is no position ${pos}`)
  return pos - 1
}

const updateRoutineExercise = {
  name: 'update_routine_exercise',
  description: 'Replace the exercise at a 1-based position of a routine with a new prescription (it may be the same exercise with new sets/reps/weight, or a swap to another exercise).',
  schema: { routine_id: z.string().min(1), position: position(), exercise: routineExerciseSchema },
  edit: (S, p) => {
    const r = requireRoutine(S, p.routine_id)
    r.ex[slot(r, p.position)] = routineExercise(p.exercise, S)
    return { updated: summary(r) }
  }
}

const removeRoutineExercise = {
  name: 'remove_routine_exercise',
  description: 'Remove the exercise at a 1-based position of a routine.',
  schema: { routine_id: z.string().min(1), position: position() },
  edit: (S, p) => {
    const r = requireRoutine(S, p.routine_id)
    const [gone] = r.ex.splice(slot(r, p.position), 1)
    return { updated: summary(r), removed: { id: gone.id, name: exerciseOf(gone.id, S)?.n || gone.id } }
  }
}

/* ---------- schedule ---------- */

const setWeekdayRoutines = {
  name: 'set_weekday_routines',
  description: 'Set which routines are planned on a weekday of the weekly plan. Several routines on one day are merged into one session; an empty list makes it a rest day.',
  schema: { day: weekday(), routine_ids: z.array(z.string().min(1)).max(6) },
  edit: (S, p) => {
    const d = dayIndex(p.day)
    p.routine_ids.forEach(id => requireRoutine(S, id))
    if (p.routine_ids.length) S.week[d] = [...p.routine_ids]
    else delete S.week[d]
    return { day: d, routines: p.routine_ids.map(id => summary(requireRoutine(S, id))) }
  }
}

const setDayOverride = {
  name: 'set_day_override',
  description: "Reschedule one calendar date without touching the weekly plan: train a given routine that day, make it a rest day, or clear the override so the weekly plan applies again.",
  schema: {
    date: isoDate(),
    routine_id: z.string().min(1).optional(),
    rest: z.boolean().optional().describe('true makes the date a rest day'),
    clear: z.boolean().optional().describe('true removes the override')
  },
  edit: (S, p) => {
    const picks = [p.routine_id != null, p.rest === true, p.clear === true].filter(Boolean).length
    if (picks !== 1) throw fail('EINVAL', 'give exactly one of routine_id, rest: true or clear: true')
    if (p.clear) { delete S.dayPlan[p.date]; return { date: p.date, override: null } }
    if (p.rest) { S.dayPlan[p.date] = 'rest'; return { date: p.date, override: 'rest' } }
    const r = requireRoutine(S, p.routine_id)
    S.dayPlan[p.date] = r.id
    return { date: p.date, override: summary(r) }
  }
}

/* ---------- workouts ---------- */

const loggedSet = z.object({
  weight: z.number().min(0).optional(),
  reps: z.number().int().min(0).max(1000).optional(),
  seconds: z.number().int().min(0).max(36000).optional(),
  minutes: z.number().min(0).max(1440).optional(),
  speed: z.number().min(0).max(50).optional(),
  rir: z.number().min(0).max(10).optional(),
  rpe: z.number().min(1).max(10).optional(),
  warmup: z.boolean().optional(),
  done: z.boolean().default(true).describe('false keeps the row as planned but not done')
})

const loggedExercise = z.object({
  exercise_id: z.string().min(1),
  sets: z.array(loggedSet).min(1).max(50),
  superset: z.string().min(1).max(20).optional(),
  note: z.string().max(500).optional()
})

// A logged exercise in the shape a finished session entry has (finish-workout.js).
function entryOf(input, S, rid) {
  const ex = requireExercise(input.exercise_id, S)
  const sets = input.sets.map(s => {
    const row = { done: s.done !== false }
    if (ex.bp === 'cardio') {
      row.min = s.minutes ?? 0
      if (s.speed != null) row.speed = s.speed
    } else if (s.seconds != null) {
      row.sec = s.seconds
      row.w = s.weight ?? 0
    } else {
      row.w = s.weight ?? 0
      row.r = s.reps ?? 0
    }
    if (s.rir != null) row.rir = s.rir
    else if (s.rpe != null) row.rpe = s.rpe
    if (s.warmup) row.warmup = true
    return row
  })
  const work = input.sets.filter(s => !s.warmup)
  const target = ex.bp === 'cardio'
    ? { sets: work.length, min: work[0]?.minutes ?? 0, ...(work[0]?.speed != null ? { speed: work[0].speed } : {}) }
    : work.some(s => s.seconds != null)
      ? { mode: 'time', sets: work.length, sec: work[0]?.seconds ?? 0 }
      : { sets: work.length, reps: work[0]?.reps ?? 0 }
  const entry = { id: input.exercise_id, sets, target, ...(rid ? { rid } : {}), ...(input.superset ? { sg: input.superset } : {}), ...(input.note ? { note: input.note } : {}) }
  entry.topW = bestWeightForEntry(entry) || null
  return entry
}

const lastWeighIn = S => [...(S.bodyweight || [])].sort((a, b) => (a.d < b.d ? -1 : 1)).pop()?.w

const logWorkout = {
  name: 'log_workout',
  description: "Log a workout into the history, the way the app's \"Log a past workout\" does: filed in date order, PR badges recalculated against the sessions before and after it. Weights are in the profile's unit (see get_settings). Sets default to done.",
  schema: {
    date: isoDate().optional().describe('defaults to today'),
    start_time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('HH:MM, defaults to 18:00'),
    duration_min: z.number().int().min(1).max(600).optional().describe('defaults to 60'),
    name: z.string().min(1).max(80).optional().describe("defaults to the routine's name, else \"Workout\""),
    routine_id: z.string().min(1).optional().describe('the routine this session was done from'),
    note: z.string().max(2000).optional(),
    bodyweight: z.number().positive().optional().describe('defaults to the latest weigh-in'),
    exercises: z.array(loggedExercise).min(1).max(40)
  },
  edit: (S, p) => {
    const routine = p.routine_id ? requireRoutine(S, p.routine_id) : null
    const d = p.date || todayIso()
    const active = {
      id: uid(),
      d,
      start: backfillStart(d, p.start_time),
      routineIds: routine ? [routine.id] : [],
      name: p.name || routine?.name || 'Workout',
      bw: p.bodyweight ?? lastWeighIn(S) ?? null,
      entries: p.exercises.map(e => entryOf(e, S, routine?.id)),
      note: p.note || '',
      backfill: { durationMin: p.duration_min || 60 }
    }
    // The app's log sheet refuses a session that would end after now (sheets.jsx endsInFuture).
    if (backfillEnd(active) > Date.now()) throw fail('EINVAL', 'that session would end in the future — give an earlier date, start_time or duration_min')
    const w = buildCompletedWorkout(active, {
      end: backfillEnd(active),
      prs: [],
      snapshotFor: e => {
        const custom = (S.customEx || []).find(c => c.id === e.id)
        return custom ? exerciseMuscleSnapshot(custom) : null
      }
    })
    if (!w.entries.length) throw fail('EINVAL', 'no set is marked done, so there is nothing to log')
    w.vol = workoutVolume(w)
    stampWorkout(w)
    const touched = [...new Set(w.entries.map(e => e.id))]
    S.workouts = rebuildPrHistory(completeBackfill(S.workouts, active, w), touched, w)
    refillAfter(S, w)
    const saved = S.workouts.find(x => x.id === w.id) || w
    return { logged: { workout_id: saved.id, date: saved.d, name: saved.name, exercises: saved.entries.length, volume: saved.vol, prs: saved.prs || [] } }
  }
}

const editWorkout = {
  name: 'edit_workout',
  description: "Correct a logged workout, the way the history's editor does: rename it, change its note, or replace its exercises and sets (a full list — read it with get_workout first). PR badges and kept working weights are recalculated.",
  schema: {
    workout_id: z.string().min(1),
    name: z.string().min(1).max(80).optional(),
    note: z.string().max(2000).optional(),
    exercises: z.array(loggedExercise).min(1).max(40).optional()
  },
  edit: (S, p) => {
    if (!(S.workouts || []).some(w => w.id === p.workout_id)) throw fail('ENOENT', `no workout with id ${JSON.stringify(p.workout_id)} — see list_workouts`)
    const active = editCompletedSession(S, p.workout_id)
    if (p.name != null) active.name = p.name
    if (p.note != null) active.note = p.note
    if (p.exercises) {
      const rid = active.routineIds?.[0]
      active.entries = p.exercises.map(e => entryOf(e, S, rid))
    }
    let saved
    try { saved = saveWorkoutEdit(S) } catch (e) { S.active = null; throw fail('EINVAL', e.message) }
    return { updated: { workout_id: saved.id, date: saved.d, name: saved.name, exercises: saved.entries.length, volume: saved.vol, prs: saved.prs || [] } }
  }
}

const deleteWorkout = {
  name: 'delete_workout',
  description: 'Delete a logged workout from the history. A kept working weight that came from it is lowered the way the app does.',
  schema: { workout_id: z.string().min(1) },
  edit: (S, p) => {
    const w = (S.workouts || []).find(x => x.id === p.workout_id)
    if (!w) throw fail('ENOENT', `no workout with id ${JSON.stringify(p.workout_id)} — see list_workouts`)
    editCompletedSession(S, w.id)
    deleteEditedWorkout(S)
    return { deleted: { workout_id: w.id, date: w.d, name: w.name } }
  }
}

/* ---------- body weight ---------- */

const logBodyweight = {
  name: 'log_bodyweight',
  description: "Record a weigh-in (one per date; a second one the same day replaces it), in the profile's unit.",
  schema: { weight: z.number().positive().max(700), date: isoDate().optional().describe('defaults to today') },
  edit: (S, p) => {
    const d = p.date || todayIso()
    const hit = S.bodyweight.find(b => b.d === d)
    if (hit) { hit.w = p.weight; hit.t = Date.now() } else S.bodyweight.push({ d, w: p.weight, t: Date.now() })
    return { date: d, weight: p.weight, unit: S.unit || 'kg', replaced: !!hit }
  }
}

const deleteBodyweight = {
  name: 'delete_bodyweight',
  description: 'Delete the weigh-in of a date.',
  schema: { date: isoDate() },
  edit: (S, p) => {
    const before = S.bodyweight.length
    S.bodyweight = S.bodyweight.filter(b => b.d !== p.date)
    if (S.bodyweight.length === before) throw fail('ENOENT', `no weigh-in on ${p.date}`)
    return { deleted: p.date }
  }
}

const setGoalWeight = {
  name: 'set_goal_weight',
  description: 'Set the goal body weight the weight chart draws its goal line at, or null to remove it.',
  schema: { weight: z.number().positive().max(700).nullable() },
  edit: (S, p) => {
    S.targetW = p.weight
    return { goal_weight: p.weight, unit: S.unit || 'kg' }
  }
}

/* ---------- custom exercises ---------- */

const customFields = {
  name: z.string().min(1).max(80),
  body_part: z.enum(['back', 'cardio', 'chest', 'lower arms', 'lower legs', 'neck', 'shoulders', 'upper arms', 'upper legs', 'waist']),
  equipment: z.string().min(1).max(40).optional().describe('e.g. barbell, dumbbell, cable, body weight'),
  primary_muscles: z.array(muscle()).max(6).optional(),
  secondary_muscles: z.array(muscle()).max(10).optional(),
  description: z.string().max(2000).optional(),
  url: z.string().url().max(500).optional().describe('link to a demo video or guide')
}

// The shape CustomExForm writes (and plan-share's cleanCustom keeps).
function customRecord(id, p, prev = {}) {
  const prim = inMuscleOrder([...new Set(p.primary_muscles ?? prev.primaries ?? [])])
  const sec = inMuscleOrder([...new Set(p.secondary_muscles ?? prev.secondaries ?? [])]).filter(m => !prim.includes(m))
  const o = { id, n: (p.name ?? prev.n).trim(), bp: p.body_part ?? prev.bp, custom: true }
  const eq = p.equipment ?? prev.eq
  if (eq) o.eq = eq
  const desc = p.description ?? prev.desc
  if (desc) o.desc = desc
  const url = p.url ?? prev.url
  if (url) o.url = url
  if (prim[0]) o.tg = prim[0]
  if (prim.length) o.primaries = prim
  if (sec.length) { o.secondaries = sec; o.sm = sec }
  if (prim.length || sec.length) o.muscleGroups = [...prim, ...sec]
  if (prev.media) o.media = prev.media
  return o
}

const requireCustom = (S, id) => {
  const c = (S.customEx || []).find(x => x.id === id)
  if (!c) throw fail('ENOENT', `no custom exercise with id ${JSON.stringify(id)} — built-in exercises cannot be changed`)
  return c
}

const createCustomExercise = {
  name: 'create_custom_exercise',
  description: 'Create your own exercise for movements the 1,324-exercise library does not have. It can then be used in routines and logged workouts by its returned id.',
  schema: customFields,
  edit: (S, p) => {
    const dup = S.customEx.find(c => c.n.toLowerCase() === p.name.trim().toLowerCase() && c.bp === p.body_part)
    if (dup) throw fail('EEXIST', `a custom exercise ${JSON.stringify(dup.n)} (${dup.bp}) already exists with id ${dup.id}`)
    const rec = customRecord(uid(), p)
    S.customEx.push(rec)
    return { created: { id: rec.id, name: rec.n, body_part: rec.bp } }
  }
}

const updateCustomExercise = {
  name: 'update_custom_exercise',
  description: 'Change a custom exercise. Only the fields given change.',
  schema: { exercise_id: z.string().min(1), ...Object.fromEntries(Object.entries(customFields).map(([k, v]) => [k, v.optional()])) },
  edit: (S, p) => {
    const c = requireCustom(S, p.exercise_id)
    const i = S.customEx.indexOf(c)
    S.customEx[i] = customRecord(c.id, p, c)
    return { updated: { id: c.id, name: S.customEx[i].n, body_part: S.customEx[i].bp } }
  }
}

const deleteCustomExercise = {
  name: 'delete_custom_exercise',
  description: 'Delete a custom exercise. Refused while a routine or a logged workout still uses it, and the reply says where.',
  schema: { exercise_id: z.string().min(1) },
  edit: (S, p) => {
    const c = requireCustom(S, p.exercise_id)
    const routines = S.routines.filter(r => (r.ex || []).some(e => e.id === c.id)).map(r => r.name)
    const workouts = S.workouts.filter(w => (w.entries || []).some(e => e.id === c.id)).length
    if (routines.length || workouts) throw fail('EBUSY', `still used by ${routines.length} routine(s) [${routines.join(', ')}] and ${workouts} logged workout(s)`)
    S.customEx = S.customEx.filter(x => x.id !== c.id)
    return { deleted: { id: c.id, name: c.n } }
  }
}

const setExerciseNote = {
  name: 'set_exercise_note',
  description: 'Set the standing note of an exercise, shown every time it comes up ("seat 4, pin 7"), or an empty string to remove it.',
  schema: { exercise_id: z.string().min(1), note: z.string().max(500) },
  edit: (S, p) => {
    requireExercise(p.exercise_id, S)
    S.exNotes = S.exNotes || {}
    if (p.note.trim()) S.exNotes[p.exercise_id] = p.note.trim()
    else delete S.exNotes[p.exercise_id]
    return { exercise_id: p.exercise_id, note: p.note.trim() || null }
  }
}

/* ---------- settings ---------- */

const LANGS = ['en', 'ar', 'de', 'de-CH', 'es', 'fr', 'hi', 'hu', 'it', 'ko', 'pl', 'pt', 'pt-BR', 'ru', 'th', 'tr', 'uk', 'zh', 'zh-TW']

const updateSettings = {
  name: 'update_settings',
  description: "Change training settings. Only the fields given change. The weight unit is deliberately not here: switching it in the app converts every stored weight, which must happen there.",
  schema: {
    rest_sec: z.number().int().min(10).max(900).optional().describe('default rest timer between sets'),
    rest_pause_sec: z.number().int().min(5).max(120).optional(),
    effort_scale: z.enum(['none', 'rir', 'rpe']).optional().describe('per-set effort column'),
    week_start: z.enum(['monday', 'sunday']).optional(),
    language: z.enum(LANGS).optional(),
    workout_view: z.enum(['cards', 'list', 'compact']).optional(),
    sound: z.boolean().optional(),
    keep_awake: z.boolean().optional(),
    reminder_on: z.boolean().optional().describe('workout-day reminder push'),
    reminder_time: z.string().regex(/^\d{2}:\d{2}$/).optional()
  },
  edit: (S, p) => {
    if (p.rest_sec != null) S.restSec = p.rest_sec
    if (p.rest_pause_sec != null) S.restPauseSec = p.rest_pause_sec
    // The legacy boolean this setting replaced goes with it, as in Settings.jsx.
    if (p.effort_scale) { S.effort = p.effort_scale; delete S.showRir }
    if (p.week_start) S.weekStart = p.week_start === 'sunday' ? 0 : 1
    if (p.language) S.lang = p.language
    if (p.workout_view) S.workoutView = p.workout_view
    if (p.sound != null) S.sound = p.sound
    if (p.keep_awake != null) S.keepAwake = p.keep_awake
    if (p.reminder_on != null || p.reminder_time) {
      S.reminder = { ...(S.reminder || {}), ...(p.reminder_on != null ? { on: p.reminder_on } : {}), ...(p.reminder_time ? { time: p.reminder_time } : {}) }
    }
    return { changed: Object.keys(p) }
  }
}

/* ---------- plans ---------- */

const importPlan = {
  name: 'import_plan',
  description: "Import an openGym plan file (the JSON \"Share plan\" writes, see export_plan): its routines are added as new ones next to yours, its custom exercises reused by name or added. With replace_week the plan's weekly schedule replaces yours.",
  schema: {
    plan: z.union([z.string(), z.record(z.any())]).describe('the plan file, as JSON text or an object'),
    replace_week: z.boolean().default(false)
  },
  edit: (S, p) => {
    let bundle
    try { bundle = parsePlan(p.plan, S.unit || 'kg') } catch (e) { throw fail('EINVAL', e.message) }
    if (!bundle.routineCount) throw fail('EINVAL', 'the plan holds no routines')
    mergePlan(S, bundle, { schedule: p.replace_week })
    return { imported: { name: bundle.name, routines: bundle.routineCount, exercises: bundle.exerciseCount, dropped_unknown_exercises: bundle.dropped, week_replaced: p.replace_week } }
  }
}

export const WRITE_TOOLS = [
  createRoutine, updateRoutine, deleteRoutineTool, duplicateRoutine,
  setRoutineExercises, addRoutineExercise, updateRoutineExercise, removeRoutineExercise,
  setWeekdayRoutines, setDayOverride,
  logWorkout, editWorkout, deleteWorkout,
  logBodyweight, deleteBodyweight, setGoalWeight,
  createCustomExercise, updateCustomExercise, deleteCustomExercise, setExerciseNote,
  updateSettings, importPlan
]
