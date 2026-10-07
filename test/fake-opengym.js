// An in-memory openGym API with the contract the gateway depends on (api/server.js):
// GET /api/me, GET /api/data, and PUT /api/data's conditional write — a baseRev or baseWid that
// is not the stored one is a 409 carrying the current document. Tokens map to profiles.
import http from 'node:http'
import crypto from 'node:crypto'

export function fakeOpenGym(profiles) {
  const users = new Map()   // token -> { user, doc }
  for (const [token, { user, state }] of Object.entries(profiles)) {
    users.set(token, { user, doc: state ? { ...structuredClone(state), _rev: 1, _wid: 'w0' } : null })
  }
  const log = []
  let beforePut = null      // test hook: runs once before the next PUT is judged

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const token = (req.headers.authorization || '').replace(/^Bearer /, '')
    const who = users.get(token)
    if (!who) return send(401, { error: 'not signed in' })
    const route = req.method + ' ' + new URL(req.url, 'http://x').pathname
    log.push(route)
    if (route === 'GET /api/me') return send(200, { user: who.user })
    if (route === 'GET /api/data') return send(200, { state: who.doc, rev: who.doc?._rev || 0 })
    if (route === 'PUT /api/data') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (beforePut) { const hook = beforePut; beforePut = null; hook(who) }
      const cur = who.doc
      const curRev = cur?._rev || 0
      if ((body.baseRev != null && body.baseRev !== curRev) || (typeof body.baseWid === 'string' && cur?._wid && body.baseWid !== cur._wid)) {
        return send(409, { error: 'conflict', rev: curRev, state: cur })
      }
      delete body.state.active
      who.doc = { ...body.state, _rev: curRev + 1, _wid: crypto.randomBytes(4).toString('hex') }
      return send(200, { ok: true, rev: curRev + 1, wid: who.doc._wid })
    }
    send(404, { error: 'not found' })
  })

  return {
    server,
    log,
    doc: token => users.get(token).doc,
    // Simulates another device writing between the gateway's read and its write.
    onceBeforePut: fn => { beforePut = fn },
    concurrentWrite: (token, change) => {
      const who = users.get(token)
      const next = structuredClone(who.doc)
      change(next)
      who.doc = { ...next, _rev: who.doc._rev + 1, _wid: crypto.randomBytes(4).toString('hex') }
    }
  }
}

export const listen = server => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})
