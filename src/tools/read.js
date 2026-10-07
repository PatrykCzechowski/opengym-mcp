// Read tools: the nine upstream ones (vendor/opengym/mcp/src/tools.js, answering from the
// caller's profile through src/upstream-state.js) plus what a client needs before it can write —
// exercise ids, settings, a plan file.
import { z } from 'zod'
import { TOOLS as UPSTREAM } from '../../vendor/opengym/mcp/src/tools.js'
import { CATALOGUE, BODYPARTS, searchScore } from '../../vendor/opengym/frontend/src/lib/exercises.js'
import { buildPlanBundle } from '../../vendor/opengym/frontend/src/lib/plan-share.js'
import { fail, exerciseOf } from './shared.js'

const brief = (ex, custom) => ({
  id: ex.id,
  name: ex.n,
  body_part: ex.bp || null,
  equipment: ex.eq || null,
  target: ex.tg || null,
  ...(custom ? { custom: true } : {})
})

const searchExercises = {
  name: 'search_exercises',
  description: 'Search the exercise library (1,324 built-ins plus the profile\'s custom exercises) by name, muscle or equipment. Returns the ids every routine and logging tool takes. Names are English ("barbell full squat", "dumbbell lateral raise").',
  schema: {
    query: z.string().max(100).default('').describe('words in any order; empty lists by filter only'),
    body_part: z.enum(BODYPARTS).optional(),
    equipment: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(100).default(20)
  },
  read: (S, p) => {
    const pool = [...(S.customEx || []).map(c => [c, true]), ...CATALOGUE.map(c => [c, false])]
    const hits = pool
      .filter(([ex]) => (!p.body_part || ex.bp === p.body_part) && (!p.equipment || (ex.eq || '').toLowerCase() === p.equipment.toLowerCase()))
      .map(([ex, custom]) => ({ ex, custom, score: searchScore(ex, p.query) }))
      .filter(h => h.score > 0)
      .sort((a, b) => b.score - a.score || (a.custom === b.custom ? 0 : a.custom ? -1 : 1))
    return { total: hits.length, exercises: hits.slice(0, p.limit).map(h => brief(h.ex, h.custom)) }
  }
}

const getExercise = {
  name: 'get_exercise',
  description: 'Full description of one exercise: muscles, equipment, step-by-step instructions, and the standing note kept for it.',
  schema: { exercise_id: z.string().min(1) },
  read: (S, p) => {
    const ex = exerciseOf(p.exercise_id, S)
    if (!ex) throw fail('ENOENT', `no exercise with id ${JSON.stringify(p.exercise_id)}`)
    const custom = (S.customEx || []).includes(ex)
    return {
      ...brief(ex, custom),
      primary_muscles: ex.primaries || (ex.tg ? [ex.tg] : []),
      secondary_muscles: ex.secondaries || ex.sm || [],
      instructions: ex.st || [],
      description: ex.desc || null,
      url: ex.url || null,
      standing_note: S.exNotes?.[ex.id] || null
    }
  }
}

const getSettings = {
  name: 'get_settings',
  description: "The profile's training settings: weight unit (every weight the tools take or return is in it), rest timer, effort scale, week start, language, reminder, goal weight.",
  schema: {},
  read: S => ({
    unit: S.unit || 'kg',
    rest_sec: S.restSec ?? 90,
    rest_pause_sec: S.restPauseSec ?? 15,
    effort_scale: S.effort ?? (S.showRir ? 'rir' : 'none'),
    week_start: S.weekStart === 0 ? 'sunday' : 'monday',
    language: S.lang || 'en',
    workout_view: S.workoutView || 'cards',
    sound: S.sound !== false,
    keep_awake: S.keepAwake !== false,
    reminder: { on: !!S.reminder?.on, time: S.reminder?.time || '08:00' },
    goal_weight: S.targetW ?? null
  })
}

const exportPlan = {
  name: 'export_plan',
  description: 'The weekly plan as an openGym plan file: every routine, the weekday schedule and the custom exercises they use — no workouts, weigh-ins or settings. Another openGym imports it with "Import a plan file" or import_plan.',
  schema: { name: z.string().max(80).optional() },
  read: (S, p) => buildPlanBundle(S, p.name)
}

export const READ_TOOLS = [
  ...UPSTREAM.map(t => ({ name: t.name, description: t.description, schema: t.schema, read: (S, p) => t.handler(p) })),
  searchExercises, getExercise, getSettings, exportPlan
]
