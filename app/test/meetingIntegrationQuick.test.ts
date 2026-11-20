import { describe, expect, it, vi } from 'vitest'
import { createScheduledMeetingRunner, scheduledTarget, type ScheduledMeeting } from '../src/main/dsh/scheduledMeeting'
import type { DetectedMeeting } from '../src/main/meetingAutowatch'

const base: ScheduledMeeting = { id: 'test-run', title: 'Synthetic meeting', platform: 'tencent' }
const quickMeeting = { ...base, mode: 'quick' as const }
const invite = 'https://meeting.tencent.com/dm/test-invite'
const room: DetectedMeeting = {
  app: '\u817e\u8baf\u4f1a\u8bae', processName: 'wemeetapp', windowTitle: 'Mock active room',
  windowId: 'new-room', meetingCode: '123456789', primary: true,
}

function harness() {
  let active: string | undefined
  let time = 0
  const scan = vi.fn(async (_app: string): Promise<DetectedMeeting[] | undefined> => [])
  const open = vi.fn(async (_uri: string) => {})
  const joinTencentNumber = vi.fn(async (_code: string) => {})
  const quick = vi.fn(async (_platform: 'tencent' | 'chinamobile'): Promise<boolean> => true)
  const start = vi.fn((_item: ScheduledMeeting, _detected: DetectedMeeting) => (active = 'test-recording'))
  const notify = vi.fn()
  const runner = createScheduledMeetingRunner({
    scan, open, joinTencentNumber, quick, start, notify, stop: vi.fn(),
    active: () => active, automaticDetection: true, now: () => time,
  })
  return { ...runner, scan, open, joinTencentNumber, quick, start, notify, expire: () => { time = 91_000 } }
}

describe('meeting integration: target selection', () => {
  it('requires an explicit quick mode instead of interpreting a blank join as a new meeting', () => {
    const emptyJoin = { ...base, mode: 'join' as const, meetingCode: '  ', meetingUrl: '  ' }
    expect(() => scheduledTarget(base)).toThrow()
    expect(() => scheduledTarget(emptyJoin)).toThrow()
    expect(scheduledTarget(quickMeeting)).toMatchObject({ quick: true, uri: 'wemeet://page/home' })
  })

  const invalidQuickTargets: [string, Partial<ScheduledMeeting>][] = [
    ['unsupported platform', { platform: 'zoom' }],
    ['meeting number', { meetingCode: '123456789' }],
    ['invite link', { meetingUrl: invite }],
  ]
  it.each(invalidQuickTargets)('rejects quick mode with %s before dispatch', async (_reason, fields) => {
    const item = { ...quickMeeting, ...fields }
    const h = harness()
    expect(() => scheduledTarget(item)).toThrow()
    expect((await h.join(item)).ok).toBe(false)
    expect(h.open).not.toHaveBeenCalled()
    expect(h.joinTencentNumber).not.toHaveBeenCalled()
    expect(h.quick).not.toHaveBeenCalled()
  })
})

describe('meeting integration: quick meeting confirmation', () => {
  it('uses one quick request and waits for two consistent observations before recording', async () => {
    const h = harness()
    const first = h.join(quickMeeting)
    expect((await h.join(quickMeeting)).ok).toBe(false)
    expect((await first).ok).toBe(true)
    expect((await h.join(quickMeeting)).ok).toBe(false)
    expect(h.open).toHaveBeenCalledExactlyOnceWith('wemeet://page/home')
    expect(h.quick).toHaveBeenCalledExactlyOnceWith('tencent')
    expect(h.joinTencentNumber).not.toHaveBeenCalled()

    await h.tick()
    h.scan.mockResolvedValue([room])
    await h.tick()
    h.scan.mockResolvedValue([{ ...room, windowId: 'other-room' }])
    await h.tick()
    expect(h.start).not.toHaveBeenCalled()

    h.scan.mockResolvedValue([room])
    await h.tick()
    expect(h.start).not.toHaveBeenCalled()
    await h.tick()
    await h.tick()
    expect(h.start).toHaveBeenCalledExactlyOnceWith(quickMeeting, room)
    expect(h.notify).toHaveBeenCalledWith('recording', quickMeeting)
    expect(h.quick).toHaveBeenCalledTimes(1)
  })

  it('continues watching for manual entry when the quick action returns false', async () => {
    const h = harness()
    h.quick.mockResolvedValue(false)
    const { ok, result } = await h.join(quickMeeting)
    expect(ok).toBe(true)
    expect(result).toContain('\u8bf7\u5728\u5ba2\u6237\u7aef')
    expect(h.quick).toHaveBeenCalledExactlyOnceWith('tencent')
    await h.tick()
    await h.tick()
    expect(h.start).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalledWith('joined', quickMeeting)
    expect(h.notify).not.toHaveBeenCalledWith('recording', quickMeeting)

    h.scan.mockResolvedValue([room])
    await h.tick()
    await h.tick()
    expect(h.start).toHaveBeenCalledExactlyOnceWith(quickMeeting, room)
    expect(h.quick).toHaveBeenCalledTimes(1)
  })

  it('confirms a new quick meeting with auto-record off and never starts capture', async () => {
    const h = harness()
    const item = { ...quickMeeting, autoRecord: false }
    expect((await h.join(item)).ok).toBe(true)
    expect((await h.join(item)).ok).toBe(false)

    h.scan.mockResolvedValue([room])
    await h.tick()
    expect((await h.join(item)).ok).toBe(false)
    expect(h.notify).not.toHaveBeenCalledWith('joined', item)
    await h.tick()
    expect(h.scan).toHaveBeenCalledTimes(3)
    expect(h.notify).toHaveBeenCalledExactlyOnceWith('joined', item)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalledWith('recording', item)
    expect(h.quick).toHaveBeenCalledTimes(1)

    h.expire()
    await h.tick()
    expect(h.notify).not.toHaveBeenCalledWith('unconfirmed', item)
  })

  it('reports timeout without capture when quick creation never reaches an in-call window', async () => {
    const h = harness()
    expect((await h.join(quickMeeting)).ok).toBe(true)
    await h.tick()
    h.expire()
    await h.tick()
    await h.tick()
    expect(h.notify).toHaveBeenCalledExactlyOnceWith('quick-click-unconfirmed', quickMeeting)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.quick).toHaveBeenCalledTimes(1)
  })

  it('does not create another meeting when the baseline already contains an active call', async () => {
    const h = harness()
    h.scan.mockResolvedValue([room])
    expect((await h.join(quickMeeting)).ok).toBe(false)
    await h.tick()
    expect(h.open).not.toHaveBeenCalled()
    expect(h.quick).not.toHaveBeenCalled()
    expect(h.start).not.toHaveBeenCalled()
  })

  it('does not record an active window without a successful baseline', async () => {
    const h = harness()
    h.scan.mockResolvedValue(undefined)
    await h.join(quickMeeting)
    expect(h.quick).not.toHaveBeenCalled()
    h.scan.mockResolvedValue([room])
    await h.tick()
    await h.tick()
    expect(h.start).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalledWith('joined', quickMeeting)
  })
})

describe('meeting integration: existing meeting joins', () => {
  it('still opens the official online invite without attempting a quick meeting', async () => {
    const h = harness()
    const item = { ...base, mode: 'join' as const, meetingUrl: invite }
    expect((await h.join(item)).ok).toBe(true)
    expect(h.open).toHaveBeenCalledExactlyOnceWith(invite)
    expect(h.quick).not.toHaveBeenCalled()
    expect(h.joinTencentNumber).not.toHaveBeenCalled()
  })

  it('still sends a normalized meeting number to the native join dependency', async () => {
    const h = harness()
    expect((await h.join({ ...base, meetingCode: '123-456-789' })).ok).toBe(true)
    expect(h.joinTencentNumber).toHaveBeenCalledExactlyOnceWith('123456789')
    expect(h.open).not.toHaveBeenCalled()
    expect(h.quick).not.toHaveBeenCalled()
  })

  it('still uses the official invite when native number entry fails', async () => {
    const h = harness()
    h.joinTencentNumber.mockRejectedValue(new Error('mock native dialog unavailable'))
    expect((await h.join({ ...base, meetingCode: '123-456-789', meetingUrl: invite })).ok).toBe(true)
    expect(h.joinTencentNumber).toHaveBeenCalledExactlyOnceWith('123456789')
    expect(h.open).toHaveBeenCalledExactlyOnceWith(invite)
    expect(h.quick).not.toHaveBeenCalled()
  })
})
