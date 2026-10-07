import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const shim = fileURLToPath(new URL('./src/upstream-state.js', import.meta.url))

// Vitest resolves modules itself, so the node resolve hook in src/hooks.js does not apply here;
// this plugin is the same single redirect.
const upstreamState = {
  name: 'upstream-state',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './state.js' && importer && importer.includes('/vendor/opengym/mcp/src/')) return shim
    return null
  }
}

export default defineConfig({
  plugins: [upstreamState],
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 15000
  }
})
