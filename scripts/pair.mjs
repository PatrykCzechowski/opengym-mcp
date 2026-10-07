#!/usr/bin/env node
// Turns a one-time pairing code into a token for an MCP client.
//
//   1. openGym → Settings → Account → "Pair the mobile app" shows a code (valid 5 minutes)
//   2. npm run pair -- https://gym.example.com K7Q2MX9P
//
// The token is the same signed value a paired phone holds: it lasts SESSION_DAYS (90 by default)
// and "Sign out everywhere" revokes it. It is printed once and stored nowhere.
const [base, code] = process.argv.slice(2)
if (!base || !code) {
  console.error('usage: npm run pair -- <openGym URL, e.g. https://gym.example.com> <pairing code>')
  process.exit(2)
}

const root = base.replace(/\/+$/, '')
const res = await fetch(root + '/api/pair/redeem', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code })
})
const body = await res.json().catch(() => ({}))
if (!res.ok || !body.token) {
  console.error(`openGym refused the code (${res.status}): ${body.error || 'no token in the answer'}`)
  process.exit(1)
}

console.log(`Paired as ${body.user?.name || 'your profile'}.\n`)
console.log(`Token:\n${body.token}\n`)
console.log('Claude Code:')
console.log(`  claude mcp add --transport http opengym ${root}/mcp --header "Authorization: Bearer ${body.token}"`)
