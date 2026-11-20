import { describe, expect, it, vi } from 'vitest'
import type { DetectedMeetingMode } from '../src/shared/types'
import { detectedMeetingModeOf } from '../src/main/settings'
import { createAmbientMeetingWatcher } from '../src/main/dsh/ambientMeeting'
import { classifyMeetingWindows, type DetectedMeeting } from '../src/main/meetingAutowatch'

const room: DetectedMeeting = { app: 'Tencent Meeting', processName: 'wemeetapp', windowTitle: 'Active meeting', windowId: '42', primary: true }

function harness() {
  const state = { mode: 'auto' as DetectedMeetingMode, autoStop: true, blocked: false, active: undefined as string | undefined, rooms: [room] as DetectedMeeting[] | undefined }
  const start = vi.fn(() => (state.active = 'capture'))
  const stop = vi.fn((id: string) => { state.active = undefined; watcher.recordingStopped(id) })
  const onCode = vi.fn()
  const confirm = vi.fn<(room: DetectedMeeting, signal: AbortSignal) => Promise<boolean>>(async () => false)
  const watcher = createAmbientMeetingWatcher({
    mode: () => state.mode, confirm, autoStop: () => state.autoStop, blocked: () => state.blocked,
    active: () => state.active, scan: async () => state.rooms, start, stop, onCode,
  })
  const tick = async (count = 1) => { for (let i = 0; i < count; i++) await watcher.tick() }
  return { state, start, stop, onCode, confirm, watcher, tick }
}

describe('recording a detected meeting', () => {
  it('starts once for a meeting already in progress after two confirmations', async () => {
    const h = harness()
    await h.tick()
    expect(h.start).not.toHaveBeenCalled()
    await h.tick(3)
    expect(h.start).toHaveBeenCalledExactlyOnceWith(room)
  })

  it.each([
    { process: 'wemeetapp', app: '腾讯会议', grid: true, leave: false },
    { process: 'cloudmeeting', app: '移动云会议', grid: false, leave: true },
  ])('starts only from a locally confirmed $process call, without a DSH session', async ({ process, app, grid, leave }) => {
    const h = harness()
    const row = { ProcessName: process, windowId: '43', windowClass: 'BaseDialog' }
    h.state.rooms = classifyMeetingWindows([{ ...row, MainWindowTitle: app }], undefined, undefined, true)
    await h.tick(3)
    expect(h.start).not.toHaveBeenCalled()
    h.state.rooms = classifyMeetingWindows([{ ...row, MainWindowTitle: 'Waiting room', hasInCallControl: true }], undefined, undefined, true)
    await h.tick(3)
    expect(h.start).not.toHaveBeenCalled()
    h.state.rooms = classifyMeetingWindows([{
      ...row, MainWindowTitle: 'Daily sync', hasAudioGrid: grid, hasInCallControl: leave, MeetingCode: '123456789',
    }], undefined, undefined, true)
    await h.tick(2)
    expect(h.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ app, windowId: '43', meetingCode: '123-456-789' }))
  })

  it('adds a meeting code discovered late to the existing recording exactly once', async () => {
    const h = harness()
    await h.tick(2)
    const identified = { ...room, meetingCode: '123-456-789' }
    h.state.rooms = [identified]
    await h.tick(3)
    expect(h.start).toHaveBeenCalledExactlyOnceWith(room)
    expect(h.onCode).toHaveBeenCalledExactlyOnceWith('capture', identified)
  })

  it('does not record from a floating speaker window alone', async () => {
    const h = harness()
    h.state.rooms = [{ ...room, primary: false, auxiliary: true }]
    await h.tick(3)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('keeps the same recording when a window is recreated with the same verified code', async () => {
    const h = harness()
    const identified = { ...room, meetingCode: '123-456-789' }
    h.state.rooms = [identified]
    await h.tick(2)
    h.state.rooms = [{ ...identified, windowId: '99' }]
    await h.tick(7)
    expect(h.start).toHaveBeenCalledExactlyOnceWith(identified)
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('does not start when disabled, when the schedule is busy, or when two primary rooms exist', async () => {
    const h = harness()
    h.state.mode = 'off'
    await h.tick(2)
    h.state.mode = 'auto'
    h.state.blocked = true
    await h.tick(2)
    h.state.blocked = false
    h.state.rooms = [room, { ...room, windowId: '43' }]
    await h.tick(2)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('does not override a scheduled meeting opt-out or restart a manually stopped meeting', async () => {
    const h = harness()
    h.watcher.suppress(room)
    await h.tick(3)
    expect(h.start).not.toHaveBeenCalled()
    h.state.rooms = []
    await h.tick(5)
    h.state.rooms = [room]
    await h.tick(2)
    h.state.active = undefined
    h.watcher.recordingStopped('capture')
    await h.tick(3)
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('keeps recording on failed scans and only auto-stops its own capture after confirmed absence', async () => {
    const h = harness()
    await h.tick(2)
    h.state.rooms = undefined
    await h.tick(8)
    expect(h.stop).not.toHaveBeenCalled()
    h.state.rooms = []
    h.state.autoStop = false
    await h.tick(5)
    expect(h.stop).not.toHaveBeenCalled()
    h.state.autoStop = true
    await h.tick(2)
    expect(h.stop).toHaveBeenCalledExactlyOnceWith('capture')
  })
})

function confirmation(h: ReturnType<typeof harness>) {
  let reply!: (allow: boolean) => void
  h.confirm.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
  return async (allow: boolean) => { reply(allow); await Promise.resolve(); await Promise.resolve() }
}

it('keeps scanning after startup and ignores a stopped room even with a recreated window', async () => {
  const h = harness()
  const first = { ...room, meetingCode: '123-456-789' }
  const other = { ...first, meetingCode: '987-654-321', windowId: '44' }
  h.state.rooms = []
  await h.tick(8)
  h.state.rooms = [first]
  await h.tick(2)
  h.stop('capture')
  h.state.rooms = []
  await h.tick(8)
  h.state.rooms = [{ ...first, windowId: '99' }]
  await h.tick(4)
  expect(h.start).toHaveBeenCalledExactlyOnceWith(first)
  h.state.rooms.push(other)
  await h.tick(2)
  expect(h.start.mock.calls).toEqual([[first], [other]])
})

it('permits a different verified meeting even if its client reuses the same window', async () => {
  const h = harness()
  h.state.rooms = [{ ...room, meetingCode: '123-456-789' }]
  await h.tick(2)
  h.stop('capture')
  const next = { ...room, meetingCode: '987-654-321' }
  h.state.rooms = [next]
  await h.tick(2)
  expect(h.start).toHaveBeenCalledTimes(2)
  expect(h.start).toHaveBeenLastCalledWith(next)
})

it('prompts only once per room and starts only after acceptance and a fresh matching scan', async () => {
  const h = harness()
  h.state.mode = 'confirm'
  const reply = confirmation(h)
  await h.tick(7)
  expect(h.confirm).toHaveBeenCalledTimes(1)
  expect(h.start).not.toHaveBeenCalled()
  await reply(false)
  await h.tick(4)
  expect(h.confirm).toHaveBeenCalledTimes(1)
  const next = { ...room, windowId: '44' }
  h.state.rooms = [room, next]
  const accept = confirmation(h)
  await h.tick(2)
  expect(h.confirm).toHaveBeenCalledTimes(2)
  await accept(true)
  expect(h.start).not.toHaveBeenCalled()
  h.state.rooms = undefined
  await h.tick(3)
  expect(h.start).not.toHaveBeenCalled()
  h.state.rooms = [next]
  await h.tick()
  expect(h.start).toHaveBeenCalledExactlyOnceWith(next)
})

it('cancels an outstanding prompt when its room disappears or the mode is turned off', async () => {
  const h = harness()
  h.state.mode = 'confirm'
  const reply = confirmation(h)
  await h.tick(2)
  const firstSignal = h.confirm.mock.calls[0][1]
  h.state.rooms = []
  await h.tick()
  expect(firstSignal.aborted).toBe(true)
  await reply(true)
  const next = { ...room, windowId: '44' }
  h.state.rooms = [next]
  const secondReply = confirmation(h)
  await h.tick(2)
  const secondSignal = h.confirm.mock.calls[1][1]
  h.state.mode = 'off'
  await h.tick(5)
  expect(secondSignal.aborted).toBe(true)
  await secondReply(true)
  expect(h.start).not.toHaveBeenCalled()
  h.state.mode = 'auto'
  await h.tick(2)
  expect(h.start).toHaveBeenCalledExactlyOnceWith(next)
})

it('retains legacy enabled and disabled preferences until a mode is explicitly chosen', () => {
  expect(detectedMeetingModeOf({})).toBe('auto')
  expect(detectedMeetingModeOf({ autoRecordDetectedMeetings: true })).toBe('auto')
  expect(detectedMeetingModeOf({ autoRecordDetectedMeetings: false })).toBe('off')
  expect(detectedMeetingModeOf({ autoRecordDetectedMeetings: false, detectedMeetingMode: 'confirm' })).toBe('confirm')
})
