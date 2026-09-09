// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  resolveAccessToken: vi.fn<() => Promise<string | undefined>>(),
  buildProxyHeaders: vi.fn((token: string) => ({ Authorization: `Bearer ${token}` })),
}))
vi.mock('@/lib/auth', () => auth)
vi.mock('@/lib/runtime-config', () => ({
  getRuntimeConfig: async () => ({ apiServerUrl: 'https://api.example', customToken: null }),
}))
import { GET, PATCH, POST, PUT } from './route'

const route = { params: Promise.resolve({ path: ['sessions', 'session-a', 'workspace', 'proof #1.bin'] }) }
const requestURL = 'https://ui.example/api/ambient/v1/sessions/session-a/workspace/proof%20%231.bin?download=true'
const fileBytes = Uint8Array.from([0, 255, 128, 10, 13, 195, 40, 65])
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(() => {
  auth.resolveAccessToken.mockResolvedValue('verified-user-token')
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('authenticated API proxy file bodies', () => {
  it.each([['POST', POST], ['PUT', PUT], ['PATCH', PATCH]] as const)(
    'preserves binary %s bytes and the authenticated identity', async (method, handle) => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
      const request = new Request(requestURL, {
        method, body: fileBytes, headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: 'Bearer caller-header', Cookie: 'private-cookie',
        },
      })
      const response = await handle(request, route)
      expect(response.status).toBe(204)
      const [url, options] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.example/api/ambient/v1/sessions/session-a/workspace/proof%20%231.bin?download=true')
      expect(options?.method).toBe(method)
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer verified-user-token')
      expect(new Headers(options?.headers).has('Cookie')).toBe(false)
      expect(new Headers(options?.headers).get('Content-Type')).toBe('application/octet-stream')
      expect(new Uint8Array(await new Response(options?.body).arrayBuffer())).toEqual(fileBytes)
    },
  )

  it('preserves binary download bytes and content type', async () => {
    fetchMock.mockResolvedValue(new Response(fileBytes, { headers: { 'Content-Type': 'application/octet-stream' } }))
    const response = await GET(new Request(requestURL), route)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fileBytes)
  })

  it('keeps JSON request and response bodies unchanged', async () => {
    const body = JSON.stringify({ content: 'café 日本語', encoding: 'utf-8' })
    fetchMock.mockResolvedValue(new Response('{"message":"ok"}', { headers: { 'Content-Type': 'application/json' } }))
    const response = await PUT(new Request(requestURL, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } }), route)
    expect(await new Response(fetchMock.mock.calls[0][1]?.body).text()).toBe(body)
    expect(await response.json()).toEqual({ message: 'ok' })
  })

  it('does not contact the API without a user token', async () => {
    auth.resolveAccessToken.mockResolvedValue(undefined)
    const response = await PUT(new Request(requestURL, { method: 'PUT', body: fileBytes }), route)
    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves permission error status and body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockResolvedValue(Response.json({ reason: 'Access denied' }, { status: 403 }))
    const response = await PUT(new Request(requestURL, { method: 'PUT', body: fileBytes }), route)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ reason: 'Access denied' })
  })

  it('returns an explicit error when the API is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockRejectedValue(new Error('connection failed'))
    const response = await GET(new Request(requestURL), route)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Failed to reach ambient API' })
  })

  it('rejects path traversal before contacting the API', async () => {
    const response = await GET(new Request(requestURL), { params: Promise.resolve({ path: ['sessions', '..', 'credentials'] }) })
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps SSE events available before the upstream stream completes', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const source = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    fetchMock.mockResolvedValue(new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }))
    const response = await GET(new Request(requestURL, { headers: { Accept: 'text/event-stream' } }), route)
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Accept-Encoding')).toBe('identity')
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    const next = reader.read()
    controller!.enqueue(new TextEncoder().encode('data: {"event":"first"}\n\n'))
    expect(new TextDecoder().decode((await next).value)).toBe('data: {"event":"first"}\n\n')
    controller!.close()
    expect((await reader.read()).done).toBe(true)
  })
})
