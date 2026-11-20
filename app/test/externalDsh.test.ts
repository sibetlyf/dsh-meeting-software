import { afterEach, expect, it, vi } from 'vitest'
import { parseExternalDshEndpoint } from '../src/main/dsh/externalEndpoint.mjs'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../src/main/dsh/embeddedProcess', () => ({ spawnEmbeddedDsh: spawn }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('uses only an explicitly selected loopback endpoint', () => {
  expect(parseExternalDshEndpoint('http://127.0.0.1:3900/?token=test-token')).toEqual({
    baseUrl: 'http://127.0.0.1:3900', webUrl: 'http://127.0.0.1:3900/?token=test-token', token: 'test-token',
  })
  for (const url of ['http://example.org/?token=t', 'http://127.0.0.1:3900/', 'http://127.0.0.1:3900/?token=a&token=b']) {
    expect(() => parseExternalDshEndpoint(url)).toThrow()
  }
})

it('reuses the selected DSH and does not spawn a replacement if it becomes unavailable', async () => {
  vi.stubEnv('YOGURT_DSH_EXTERNAL_URL', 'http://127.0.0.1:3900/?token=test-token')
  vi.stubEnv('DSH_EMBEDDED_MANAGED', '1')
  vi.stubEnv('DSH_MEETING_PORT', '3090')
  const request = vi.fn().mockImplementation(async () => Response.json({ ok: true, plugin: 'dsh-meeting-host', desktopScheduler: true }))
  vi.stubGlobal('fetch', request)
  const bridge = await import('../src/main/dsh/dshBridge')
  expect((await bridge.ensureDshProfileRunning()).ok).toBe(true)
  expect(await bridge.joinWithDshComputerUse('tencent', '123456789')).toBe('submitted')
  expect(request).toHaveBeenCalledWith('http://127.0.0.1:3900/api/soulmirror/join', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }))
  request.mockImplementation(async () => Response.json({ ok: true, plugin: 'dsh-meeting-host', desktopScheduler: false }))
  expect((await bridge.ensureDshProfileRunning()).ok).toBe(false)
  request.mockRejectedValue(new Error('offline'))
  expect((await bridge.ensureDshProfileRunning()).ok).toBe(false)
  expect(spawn).not.toHaveBeenCalled()
})
