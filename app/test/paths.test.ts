import { join } from 'node:path'
import { homedir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => { const app = { getPath: (name: string) => `/fake/${name}` }; return { app, default: { app } } })
const { userDataDir, isFake } = await import('../src/main/paths')

afterEach(() => { delete process.env.YOGURT_USER_DATA; delete process.env.YOGURT_FAKE })

describe('userDataDir', () => {
  it('is the separate profile when one is set (tests)', () => {
    process.env.YOGURT_USER_DATA = '/tmp/profile'
    expect(userDataDir()).toBe('/tmp/profile')
  })
  it('uses the DSH meeting profile data directory otherwise', () => {
    expect(userDataDir()).toBe(join(homedir(), '.dsh', 'meeting-software-data'))
  })
})

describe('isFake', () => {
  it('is on only with YOGURT_FAKE=1', () => {
    expect(isFake()).toBe(false)
    process.env.YOGURT_FAKE = '1'
    expect(isFake()).toBe(true)
  })
})
