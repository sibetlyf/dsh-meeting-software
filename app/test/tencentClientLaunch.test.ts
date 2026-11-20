import { expect, it, vi } from 'vitest'
import { openTencentQuickClient } from '../src/main/dsh/clientLauncher'
import { MeetingClientHandoff } from '../src/main/dsh/scheduledMeeting'

const empty = { windows: 0, clients: 0, crashHandlers: 0 }
const headless = { windows: 0, clients: 2, crashHandlers: 1 }
const ready = { windows: 1, clients: 3, crashHandlers: 1 }
const exe = 'C:/Program Files/Tencent/WeMeet/wemeetapp.exe'

function harness() {
  return {
    scan: vi.fn<NonNullable<Parameters<typeof openTencentQuickClient>[0]['scan']>>().mockResolvedValue(empty),
    openPath: vi.fn(async (_path: string) => ''),
    openExternal: vi.fn(async (_uri: string) => {}),
    resolveExe: vi.fn(() => exe),
    wait: vi.fn(async () => {}),
  }
}

it('reuses a ready client even with a crash handler present', async () => {
  const deps = harness()
  deps.scan.mockResolvedValue(ready)
  await openTencentQuickClient(deps)
  expect(deps.scan).toHaveBeenCalledTimes(1)
  expect(deps.openPath).not.toHaveBeenCalled()
  expect(deps.openExternal).not.toHaveBeenCalled()
})

it('dispatches the exe once through the shell and waits for the main window', async () => {
  const deps = harness()
  deps.scan.mockResolvedValueOnce(headless).mockResolvedValueOnce(headless).mockResolvedValueOnce(ready)
  await openTencentQuickClient(deps)
  expect(deps.openPath).toHaveBeenCalledExactlyOnceWith(exe)
  expect(deps.openExternal).not.toHaveBeenCalled()
  expect(deps.wait).toHaveBeenCalledTimes(1)
})

it('falls back to the registered home URI if the shell cannot open the exe', async () => {
  const deps = harness()
  deps.openPath.mockResolvedValue('launch failed')
  deps.scan.mockResolvedValueOnce(empty).mockResolvedValueOnce(ready)
  await openTencentQuickClient(deps)
  expect(deps.openExternal).toHaveBeenCalledExactlyOnceWith('wemeet://page/home')
})

it('hands off to the user instead of repeatedly relaunching a headless client', async () => {
  const deps = harness()
  deps.scan.mockResolvedValue(headless)
  await expect(openTencentQuickClient(deps)).rejects.toBeInstanceOf(MeetingClientHandoff)
  expect(deps.openPath).toHaveBeenCalledExactlyOnceWith(exe)
  expect(deps.scan).toHaveBeenCalledTimes(7)
})
