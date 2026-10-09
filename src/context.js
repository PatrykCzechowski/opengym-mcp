// Per-request context. One gateway process serves every profile that presents a token, so the
// state a tool reads must never live in a module global: it rides in AsyncLocalStorage for the
// duration of one tool call.
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerCustom } from '../vendor/opengym/frontend/src/lib/exercises.js'

const als = new AsyncLocalStorage()

// The vendored app code finds an exercise through the EXIDX global (isCardio, modeOf, plan
// export), which only holds the profile's custom exercises once registerCustom has run, as the
// app does on load. Without it a custom cardio exercise reads as weight × reps. EXIDX is shared
// by every profile, so the caller's customs are registered for the one call and cleared after;
// tool bodies are synchronous, so no other request runs in between.
export function runWith(ctx, fn) {
  registerCustom(ctx.state?.customEx)
  try {
    return als.run(ctx, fn)
  } finally {
    registerCustom([])
  }
}

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
