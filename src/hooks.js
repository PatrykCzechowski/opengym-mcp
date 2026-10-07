// Module resolve hook: the upstream read tools import their file-backed state module as
// './state.js'. That one import is pointed at src/upstream-state.js so the same tool code
// answers from the caller's profile over the API. Nothing else is redirected.
const UPSTREAM_TOOLS = '/vendor/opengym/mcp/src/'
const SHIM = new URL('./upstream-state.js', import.meta.url).href

export async function resolve(specifier, context, next) {
  if (specifier === './state.js' && context.parentURL && context.parentURL.includes(UPSTREAM_TOOLS)) {
    return { url: SHIM, shortCircuit: true }
  }
  return next(specifier, context)
}
