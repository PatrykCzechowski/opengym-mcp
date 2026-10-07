// Stand-in for vendor/opengym/mcp/src/state.js. The upstream read tools call getState() and
// getUser() synchronously and expect a file on disk; here both come from the request context,
// which the gateway fills from GET /api/data with the caller's own token before the tool runs.
// The redirect is done by src/hooks.js (node) and the alias in vitest.config.js (tests).
import { current } from './context.js'

export function init() {}

export function getState() {
  return current().state
}

export function getUser() {
  const { user } = current()
  return { id: user.id, name: user.name, created: null }
}

export const dataDir = () => null
