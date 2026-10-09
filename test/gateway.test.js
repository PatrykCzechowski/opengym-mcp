// End to end: an MCP client over Streamable HTTP → the gateway → a fake openGym API.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createGateway } from '../src/server.js'
import { fakeOpenGym, listen } from './fake-opengym.js'
import { EXIDX } from '../vendor/opengym/frontend/src/lib/exercises.js'

const ANA = 'token-ana'
const BEN = 'token-ben'
const PLAN = JSON.parse(readFileSync(new URL('./fixtures/strength-cut.plan.json', import.meta.url), 'utf8'))

let api, gateway, mcpUrl

// Logged sessions must lie in the past, so test dates are counted back from today.
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
const D1 = daysAgo(4), D2 = daysAgo(2)

beforeAll(async () => {
  api = fakeOpenGym({
    [ANA]: { user: { id: 'u-ana', name: 'Ana' }, state: { unit: 'kg', routines: [], workouts: [], bodyweight: [], week: {}, dayPlan: {} } },
    [BEN]: { user: { id: 'u-ben', name: 'Ben' }, state: null }
  })
  const apiBase = await listen(api.server)
  gateway = createGateway({ apiBase })
  mcpUrl = (await listen(gateway)) + '/mcp'
})

afterAll(() => { gateway.close(); api.server.close() })

async function connect(token) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: 'Bearer ' + token } }
  }))
  return client
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content[0].text
  if (res.isError) return { error: text }
  return JSON.parse(text)
}

describe('auth', () => {
  it('refuses a request without a token with a Bearer challenge', async () => {
    const res = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/)
  })

  it('refuses a token openGym does not know', async () => {
    const res = await fetch(mcpUrl, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(401)
  })
})

describe('tools', () => {
  it('lists the read and write tools with hints', async () => {
    const c = await connect(ANA)
    const { tools } = await c.listTools()
    const names = tools.map(t => t.name)
    for (const n of ['list_routines', 'preview_session', 'muscle_balance', 'search_exercises', 'export_plan',
      'create_routine', 'log_workout', 'edit_workout', 'delete_workout', 'log_bodyweight', 'import_plan', 'update_settings']) {
      expect(names).toContain(n)
    }
    expect(tools.length).toBe(35)
    expect(tools.find(t => t.name === 'list_routines').annotations.readOnlyHint).toBe(true)
    expect(tools.find(t => t.name === 'delete_workout').annotations.destructiveHint).toBe(true)
    await c.close()
  })

  it('finds exercise ids in the library', async () => {
    const c = await connect(ANA)
    const r = await call(c, 'search_exercises', { query: 'barbell full squat', limit: 3 })
    expect(r.exercises[0]).toMatchObject({ id: '0043', name: 'barbell full squat' })
    await c.close()
  })
})

describe('routines and schedule', () => {
  it('creates a routine, schedules it, and the upstream read tools see it', async () => {
    const c = await connect(ANA)
    const created = await call(c, 'create_routine', {
      name: 'Lower A',
      emoji: 'legs',
      exercises: [
        { exercise_id: '0043', sets: 4, reps: 5, progression: 'linear', increment: 2.5, rest_sec: 180, warmup_sets: 4 },
        { exercise_id: '0417', sets: 3, reps: 15, reps_min: 12, progression: 'double', superset: 'a' },
        { exercise_id: '0175', sets: 3, reps: 15, reps_min: 12, superset: 'a' }
      ]
    })
    const id = created.created.id
    expect(created.created.exercise_count).toBe(3)

    await call(c, 'set_weekday_routines', { day: 'monday', routine_ids: [id] })
    expect(api.doc(ANA).week[1]).toEqual([id])

    const routine = await call(c, 'get_routine', { routine_id: id })
    expect(routine.exercises[0]).toMatchObject({ position: 1 })
    expect(api.doc(ANA).routines[0].ex[0]).toMatchObject({ id: '0043', sets: 4, reps: 5, weight: 0, prog: 'linear', inc: 2.5, restSec: 180, warmupSets: 4 })
    expect(api.doc(ANA).routines[0].ex[1]).toMatchObject({ reps: 15, repsMin: 12, sg: 'a' })

    await call(c, 'update_routine_exercise', { routine_id: id, position: 2, exercise: { exercise_id: '0409', sets: 3, reps: 12 } })
    await call(c, 'remove_routine_exercise', { routine_id: id, position: 3 })
    expect(api.doc(ANA).routines[0].ex.map(e => e.id)).toEqual(['0043', '0409'])
    await c.close()
  })

  it('rejects an unknown exercise without writing anything', async () => {
    const c = await connect(ANA)
    const rev = api.doc(ANA)._rev
    const r = await call(c, 'create_routine', { name: 'Bad', exercises: [{ exercise_id: 'nope', sets: 3, reps: 8 }] })
    expect(r.error).toMatch(/^ENOENT/)
    expect(api.doc(ANA)._rev).toBe(rev)
    await c.close()
  })

  it('reschedules a date and deleting the routine clears it', async () => {
    const c = await connect(ANA)
    const { created } = await call(c, 'create_routine', { name: 'Temp', exercises: [] })
    await call(c, 'set_day_override', { date: '2026-10-10', routine_id: created.id })
    expect(api.doc(ANA).dayPlan['2026-10-10']).toBe(created.id)
    const del = await call(c, 'delete_routine', { routine_id: created.id })
    expect(del.reschedules_removed).toEqual(['2026-10-10'])
    expect(api.doc(ANA).dayPlan['2026-10-10']).toBeUndefined()
    await c.close()
  })
})

describe('workouts', () => {
  it('logs, edits and deletes a workout through the app helpers', async () => {
    const c = await connect(ANA)
    const first = await call(c, 'log_workout', {
      date: D1, name: 'Lower A', duration_min: 70,
      exercises: [{ exercise_id: '0043', sets: [{ weight: 60, reps: 10, warmup: true }, { weight: 100, reps: 5, rir: 2 }, { weight: 100, reps: 5 }] }]
    })
    const second = await call(c, 'log_workout', {
      date: D2,
      exercises: [{ exercise_id: '0043', sets: [{ weight: 105, reps: 5 }] }]
    })
    // Filed in date order, and the heavier later session earns the PR badge.
    const ws = api.doc(ANA).workouts
    expect(ws.map(w => w.d)).toEqual([D1, D2])
    expect(second.logged.prs).toContain('0043')
    expect(ws[0].end - ws[0].start).toBe(70 * 60000)
    expect(ws[0].entries[0].sets[0]).toMatchObject({ warmup: true, w: 60, r: 10, done: true })
    expect(ws[0].entries[0].sets[1]).toMatchObject({ rir: 2 })

    const list = await call(c, 'list_workouts', {})
    expect(list.workouts.length).toBe(2)

    await call(c, 'edit_workout', { workout_id: first.logged.workout_id, name: 'Lower A (heavy)', exercises: [{ exercise_id: '0043', sets: [{ weight: 110, reps: 5 }] }] })
    const edited = api.doc(ANA).workouts.find(w => w.id === first.logged.workout_id)
    expect(edited.name).toBe('Lower A (heavy)')
    expect(edited.entries[0].sets).toEqual([expect.objectContaining({ w: 110, r: 5 })])

    await call(c, 'delete_workout', { workout_id: second.logged.workout_id })
    expect(api.doc(ANA).workouts.map(w => w.id)).toEqual([first.logged.workout_id])
    expect(api.doc(ANA).active).toBeUndefined()
    await c.close()
  })

  it('refuses a workout with nothing done', async () => {
    const c = await connect(ANA)
    const r = await call(c, 'log_workout', { date: D1, exercises: [{ exercise_id: '0043', sets: [{ weight: 100, reps: 5, done: false }] }] })
    expect(r.error).toMatch(/nothing to log/)
    await c.close()
  })
})

describe('body weight, custom exercises, settings', () => {
  it('records weigh-ins and the goal', async () => {
    const c = await connect(ANA)
    await call(c, 'log_bodyweight', { date: '2026-10-06', weight: 118.2 })
    const again = await call(c, 'log_bodyweight', { date: '2026-10-06', weight: 117.9 })
    expect(again.replaced).toBe(true)
    await call(c, 'set_goal_weight', { weight: 100 })
    const bw = await call(c, 'get_bodyweight', {})
    expect(JSON.stringify(bw)).toContain('117.9')
    expect(api.doc(ANA).targetW).toBe(100)
    await c.close()
  })

  it('creates a custom exercise, refuses to delete it while used', async () => {
    const c = await connect(ANA)
    const { created } = await call(c, 'create_custom_exercise', { name: 'Stability ball leg curl', body_part: 'upper legs', equipment: 'stability ball', primary_muscles: ['hamstring'], secondary_muscles: ['gluteal', 'hamstring'] })
    const rec = api.doc(ANA).customEx.find(x => x.id === created.id)
    expect(rec).toMatchObject({ custom: true, tg: 'hamstring', primaries: ['hamstring'], secondaries: ['gluteal'] })
    const dup = await call(c, 'create_custom_exercise', { name: 'stability ball leg curl', body_part: 'upper legs' })
    expect(dup.error).toMatch(/^EEXIST/)
    const { created: r } = await call(c, 'create_routine', { name: 'Ham', exercises: [{ exercise_id: created.id, sets: 3, reps: 12 }] })
    expect((await call(c, 'delete_custom_exercise', { exercise_id: created.id })).error).toMatch(/^EBUSY/)
    await call(c, 'delete_routine', { routine_id: r.id })
    expect((await call(c, 'delete_custom_exercise', { exercise_id: created.id })).deleted.id).toBe(created.id)
    await c.close()
  })

  it('plans a custom cardio exercise by time and speed, like a built-in one', async () => {
    const c = await connect(ANA)
    const { created: rower } = await call(c, 'create_custom_exercise', { name: 'Rowing machine', body_part: 'cardio', equipment: 'rowing machine' })
    const { created: r } = await call(c, 'create_routine', { name: 'Erg', exercises: [{ exercise_id: rower.id, sets: 1, minutes: 8, speed: 14 }] })
    expect(api.doc(ANA).routines.find(x => x.id === r.id).ex[0]).toMatchObject({ id: rower.id, min: 8, speed: 14 })

    const got = await call(c, 'get_routine', { routine_id: r.id })
    expect(got.exercises[0]).toMatchObject({ mode: 'cardio' })
    const pv = await call(c, 'preview_session', { routine_id: r.id })
    expect(pv.exercises[0]).toMatchObject({ mode: 'cardio', planned: { sets: 1, min: 8 } })
    expect(pv.exercises[0].opening_sets[0]).toMatchObject({ min: 8, speed: 14 })
    const plan = await call(c, 'export_plan', {})
    expect(plan.routines.find(x => x.id === r.id).ex[0]).toMatchObject({ min: 8, speed: 14 })
    // Registered for the call only: one profile's customs never linger in the shared index.
    expect(EXIDX[rower.id]).toBeUndefined()

    await call(c, 'delete_routine', { routine_id: r.id })
    await call(c, 'delete_custom_exercise', { exercise_id: rower.id })
    await c.close()
  })

  it('updates settings and reads them back', async () => {
    const c = await connect(ANA)
    await call(c, 'update_settings', { rest_sec: 120, effort_scale: 'rir', week_start: 'monday', language: 'pl' })
    const s = await call(c, 'get_settings')
    expect(s).toMatchObject({ unit: 'kg', rest_sec: 120, effort_scale: 'rir', week_start: 'monday', language: 'pl' })
    await c.close()
  })
})

describe('plans', () => {
  it('imports a plan file with its schedule and exports it again', async () => {
    const c = await connect(BEN)   // a profile that never synced
    const imp = await call(c, 'import_plan', { plan: PLAN, replace_week: true })
    expect(imp.imported).toMatchObject({ routines: 4, dropped_unknown_exercises: 0, week_replaced: true })
    const doc = api.doc(BEN)
    expect(doc.routines.map(r => r.name)).toEqual(PLAN.routines.map(r => r.name))
    expect(Object.keys(doc.week).sort()).toEqual(['1', '2', '4', '5'])
    expect(doc.customEx.map(x => x.n).sort()).toEqual(['Przysiad z pauzą 2 s', 'Uginanie nóg na piłce fitness'])
    const out = await call(c, 'export_plan', { name: 'roundtrip' })
    expect(out.opengym_plan).toBe(1)
    expect(out.routines.length).toBe(4)
    const week = await call(c, 'get_week_plan', {})
    expect(JSON.stringify(week)).toContain('Dzień 1: Dół, siła')
    await c.close()
  })
})

describe('concurrency and isolation', () => {
  it('replays the edit on the newer document when another device wrote first', async () => {
    const c = await connect(ANA)
    api.onceBeforePut(() => api.concurrentWrite(ANA, s => { s.bodyweight.push({ d: '2026-10-01', w: 119, t: 1 }) }))
    const r = await call(c, 'log_bodyweight', { date: '2026-10-02', weight: 118.6 })
    expect(r.error).toBeUndefined()
    const days = api.doc(ANA).bodyweight.map(b => b.d)
    expect(days).toContain('2026-10-01')   // the other device's write survived
    expect(days).toContain('2026-10-02')   // and so did ours
    await c.close()
  })

  it('never shows one profile another profile\'s data', async () => {
    const c = await connect(BEN)
    const r = await call(c, 'list_workouts', {})
    expect(JSON.stringify(r)).not.toContain('Lower A')
    expect(api.doc(BEN).bodyweight || []).toEqual([])
    await c.close()
  })
})

describe('dates', () => {
  it('refuses to log a session that ends in the future', async () => {
    const c = await connect(ANA)
    const r = await call(c, 'log_workout', { date: '2099-01-01', exercises: [{ exercise_id: '0043', sets: [{ weight: 100, reps: 5 }] }] })
    expect(r.error).toMatch(/future/)
    await c.close()
  })
})
