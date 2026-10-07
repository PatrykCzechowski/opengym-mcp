// The only place that talks to openGym. Every call carries the caller's own bearer token: the
// gateway holds no credentials of its own, so it can do exactly what that profile's paired
// phone can do and nothing more.

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message)
    this.status = status
    this.body = body
    this.code = status === 401 ? 'EAUTH' : status === 409 ? 'ECONFLICT' : 'EAPI'
  }
}

export function apiClient(baseUrl, token, { fetchImpl = fetch } = {}) {
  const root = baseUrl.replace(/\/+$/, '')

  async function call(method, path, body) {
    const res = await fetchImpl(root + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { error: text.slice(0, 200) } }
    if (!res.ok) throw new ApiError(res.status, data?.error || `openGym answered ${res.status}`, data)
    return data
  }

  return {
    me: () => call('GET', '/api/me'),
    getData: () => call('GET', '/api/data'),
    putData: (state, baseRev, baseWid) => call('PUT', '/api/data', {
      state,
      baseRev,
      ...(typeof baseWid === 'string' ? { baseWid } : {})
    })
  }
}
