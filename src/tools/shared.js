// Schemas and validators the read and write tools share. Tool parameters are snake_case, like the
// upstream read tools; the stored document keeps the app's own field names.
import { z } from 'zod'
import { EXIDX } from '../../vendor/opengym/frontend/src/lib/exercises.js'
import { MUSCLES } from '../../vendor/opengym/frontend/src/lib/muscles.js'

export function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
export const todayIso = () => localIso(new Date())

// A day the calendar has: 2026-02-30 passes a regex and rolls over to March in Date.
export const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine(
  v => { const d = new Date(v + 'T12:00:00'); return !Number.isNaN(d.getTime()) && localIso(d) === v },
  { message: 'not a date the calendar has (YYYY-MM-DD)' }
)

export const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
export const weekday = () => z.union([z.number().int().min(0).max(6), z.enum(DAY_NAMES)])
  .describe('0 = Sunday … 6 = Saturday, or the English day name')
export const dayIndex = d => (typeof d === 'number' ? d : DAY_NAMES.indexOf(d))

export const PROGRESSIONS = ['off', 'linear', 'greyskull', 'double', 'time']
export const muscle = () => z.enum(MUSCLES)

export const exerciseOf = (id, S) => (S.customEx || []).find(c => c.id === id) || EXIDX[id] || null

export function requireExercise(id, S) {
  const ex = exerciseOf(id, S)
  if (!ex) throw fail('ENOENT', `no exercise with id ${JSON.stringify(id)} — find ids with search_exercises`)
  return ex
}

export function requireRoutine(S, id) {
  const r = (S.routines || []).find(x => x.id === id)
  if (!r) throw fail('ENOENT', `no routine with id ${JSON.stringify(id)} — see list_routines`)
  return r
}

// One exercise slot of a routine, as the routine editor stores it.
export const routineExerciseSchema = z.object({
  exercise_id: z.string().min(1).describe('library or custom exercise id (search_exercises)'),
  sets: z.number().int().min(1).max(20),
  reps: z.number().int().min(1).max(100).optional().describe('target reps; the top of the range when reps_min is set'),
  reps_min: z.number().int().min(1).max(100).optional().describe('bottom of a rep range (double progression)'),
  weight: z.number().min(0).optional().describe("starting weight in the profile's unit; 0 = pick on the day"),
  seconds: z.number().int().min(1).max(3600).optional().describe('a timed hold (plank, hang) instead of reps'),
  minutes: z.number().min(1).max(600).optional().describe('cardio duration'),
  speed: z.number().min(0).max(50).optional().describe('cardio speed in km/h'),
  rest_sec: z.number().int().min(5).max(900).optional(),
  warmup_sets: z.number().int().min(0).max(5).optional(),
  superset: z.string().min(1).max(20).optional().describe('neighbouring exercises with the same tag form a superset'),
  note: z.string().max(500).optional(),
  progression: z.enum(PROGRESSIONS).optional(),
  increment: z.number().positive().max(50).optional().describe('load added when the progression moves'),
  per_side: z.boolean().optional().describe('reps counted per side (lunges, single-arm work)'),
  bodyweight: z.boolean().optional().describe('logged without load')
})

export function routineExercise(input, S) {
  const ex = requireExercise(input.exercise_id, S)
  const cfg = { id: input.exercise_id, sets: input.sets }
  if (ex.bp === 'cardio') {
    cfg.min = input.minutes ?? 20
    if (input.speed != null) cfg.speed = input.speed
  } else if (input.seconds != null) {
    cfg.mode = 'time'
    cfg.sec = input.seconds
    if (input.weight) cfg.weight = input.weight
  } else {
    cfg.reps = input.reps ?? 10
    cfg.weight = input.weight ?? 0
    if (input.reps_min != null) {
      if (input.reps_min > cfg.reps) throw fail('EINVAL', `reps_min ${input.reps_min} is above reps ${cfg.reps}`)
      cfg.repsMin = input.reps_min
    }
  }
  if (input.rest_sec != null) cfg.restSec = input.rest_sec
  if (input.warmup_sets) cfg.warmupSets = input.warmup_sets
  if (input.superset) cfg.sg = input.superset
  if (input.note) cfg.note = input.note
  if (input.progression) cfg.prog = input.progression
  if (input.increment) cfg.inc = input.increment
  if (input.per_side) cfg.side = true
  if (input.bodyweight != null) cfg.bodyweight = input.bodyweight
  return cfg
}
