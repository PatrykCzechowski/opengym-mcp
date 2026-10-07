// Read-modify-write against PUT /api/data, the same conditional write every device uses.
//
// The edit runs on a fresh copy of the stored document and is pushed with the revision it was
// read at. When another device wrote in between, the server refuses with 409 and sends the
// current document back; the edit is then replayed on that one. An edit is therefore a function
// of the document, never a precomputed result, so replaying it is always correct.
import { ApiError } from './api-client.js'
import { withDefaults } from './context.js'

const ATTEMPTS = 4
// Bookkeeping the server owns or strips; sending it back is harmless but pointless.
const SERVER_KEYS = ['_rev', '_wid', '_wids', '_unstamped', '_prior', 'active']

const clean = doc => {
  const out = structuredClone(doc)
  for (const k of SERVER_KEYS) delete out[k]
  return out
}

export async function mutate(api, edit) {
  let snap = await api.getData()
  for (let attempt = 1; ; attempt++) {
    const draft = withDefaults(clean(snap.state || {}))
    // A throw here (validation) aborts before anything is written.
    const result = edit(draft)
    delete draft.active
    try {
      const put = await api.putData(draft, snap.rev || 0, snap.state?._wid)
      return { result, rev: put.rev }
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409 || attempt >= ATTEMPTS) throw e
      snap = e.body?.state ? { state: e.body.state, rev: e.body.rev } : await api.getData()
    }
  }
}
