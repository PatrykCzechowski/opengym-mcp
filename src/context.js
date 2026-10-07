// Per-request context. One gateway process serves every profile that presents a token, so the
// state a tool reads must never live in a module global: it rides in AsyncLocalStorage for the
// duration of one tool call.
import { AsyncLocalStorage } from 'node:async_hooks'

const als = new AsyncLocalStorage()

export const runWith = (ctx, fn) => als.run(ctx, fn)

export function current() {
  const ctx = als.getStore()
  if (!ctx) throw new Error('no request context: a tool ran outside runWith()')
  return ctx
}

// The same defaults the app overlays on a stored document (frontend/src/store/useStore.js DEF,
// the subset upstream mcp/src/state.js uses), so a field the app added since the profile was
// last saved reads as empty instead of undefined.
export function withDefaults(S) {
  return Object.assign({
    unit: 'kg', restSec: 90, sound: true, lang: 'en',
    theme: 'dark', accent: 'lime', body: 'male', targetW: null,
    bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, workouts: [], customEx: [], exNotes: {}, gifSize: 'full',
    reminder: { on: false, time: '08:00', tz: null }
  }, S)
}
