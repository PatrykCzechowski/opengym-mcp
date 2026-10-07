// openGym MCP gateway — Streamable HTTP.
//
// Stateless: every POST /mcp gets its own McpServer bound to the caller's token, so nothing of
// one profile can reach another and the process holds no session table. The token is openGym's
// own pairing token (Settings → Account → "Pair the mobile app", redeemed with `npm run pair`);
// it is forwarded to the openGym API on every call and never stored or logged.
import http from 'node:http'
import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { apiClient, ApiError } from './api-client.js'
import { runWith, withDefaults } from './context.js'
import { mutate } from './mutate.js'
import { READ_TOOLS } from './tools/read.js'
import { WRITE_TOOLS } from './tools/write.js'

const VERSION = '0.1.0'
const MAX_BODY = 2 * 1024 * 1024
const ME_TTL_MS = 60_000

const ok = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const toolError = err => ({ isError: true, content: [{ type: 'text', text: `${err.code || 'ERROR'}: ${err.message}` }] })

async function guarded(fn) {
  try { return ok(await fn()) } catch (err) { return toolError(err) }
}

export function buildServer(api, user) {
  const server = new McpServer({ name: 'opengym', version: VERSION })
  for (const t of READ_TOOLS) {
    server.registerTool(t.name, {
      description: t.description,
      inputSchema: t.schema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    }, params => guarded(async () => {
      const { state } = await api.getData()
      // Upstream tools tell "never synced" apart by a null state, so it stays null for them.
      const ctx = { state: state ? withDefaults(state) : null, user }
      return runWith(ctx, () => t.read(ctx.state || withDefaults({}), params || {}))
    }))
  }
  for (const t of WRITE_TOOLS) {
    server.registerTool(t.name, {
      description: t.description,
      inputSchema: t.schema,
      annotations: { readOnlyHint: false, destructiveHint: /^(delete|remove|set_routine_exercises|import_plan)/.test(t.name), openWorldHint: false }
    }, params => guarded(async () => {
      const { result, rev } = await mutate(api, S => runWith({ state: S, user }, () => t.edit(S, params || {})))
      return { ...result, revision: rev }
    }))
  }
  return server
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      if (!size) return resolve(undefined)
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

export function createGateway({ apiBase, fetchImpl } = {}) {
  // Who a token belongs to, kept a minute so a burst of tool calls costs one /api/me. Keyed by a
  // hash, so the map never holds a usable credential.
  const who = new Map()
  async function userFor(token) {
    const key = crypto.createHash('sha256').update(token).digest('hex')
    const hit = who.get(key)
    if (hit && hit.exp > Date.now()) return hit.user
    const { user } = await apiClient(apiBase, token, { fetchImpl }).me()
    if (who.size > 1000) who.clear()
    who.set(key, { user, exp: Date.now() + ME_TTL_MS })
    return user
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway')
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, version: VERSION })
    if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'not found' })
    // Stateless mode has no SSE stream to resume and no session to end.
    if (req.method !== 'POST') return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { allow: 'POST' })

    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const challenge = { 'www-authenticate': 'Bearer realm="openGym MCP"' }
    if (!token) return sendJson(res, 401, { error: 'missing bearer token: pair a device in openGym and pass its token' }, challenge)

    let user
    try { user = await userFor(token) } catch (e) {
      if (e instanceof ApiError && e.status === 401) return sendJson(res, 401, { error: 'openGym does not accept this token (expired, or signed out everywhere): pair again' }, challenge)
      console.error('[opengym-mcp] openGym API unreachable:', e.message)
      return sendJson(res, 502, { error: 'openGym API unreachable' })
    }

    let body
    try { body = await readBody(req) } catch (e) { return sendJson(res, e.status || 400, { error: e.message }) }

    const server = buildServer(apiClient(apiBase, token, { fetchImpl }), user)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      console.error('[opengym-mcp] request failed:', e)
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  })
}

const isMain = process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href
if (isMain) {
  const apiBase = process.env.OPENGYM_API || 'http://api:3000'
  const port = Number(process.env.PORT) || 3100
  const host = process.env.HOST || '0.0.0.0'
  createGateway({ apiBase }).listen(port, host, () => {
    console.error(`[opengym-mcp] ${VERSION} on http://${host}:${port}/mcp → ${apiBase}`)
  })
}
