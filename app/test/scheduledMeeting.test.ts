import { describe, expect, it, vi } from 'vitest'
import { createScheduledMeetingRunner, MeetingClientHandoff, MeetingClientPending, scheduledTarget, type ScheduledMeeting } from '../src/main/dsh/scheduledMeeting'
import { isScheduledCallTitle, type DetectedMeeting } from '../src/main/meetingAutowatch'

const item: ScheduledMeeting = { id: 's1', title: 'Standup', platform: 'tencent', meetingCode: '123-456-789', autoRecord: true }
const room: DetectedMeeting = { app: '腾讯会议', processName: 'wemeetapp', windowTitle: '会议中', windowId: '1', meetingCode: '123456789' }

function harness(joinTencentNumber?: (code: string) => Promise<void>, extra: Partial<Parameters<typeof createScheduledMeetingRunner>[0]> = {}) {
  let active: string | undefined
  let time = 0
  const scan = vi.fn(async (_app: string): Promise<DetectedMeeting[] | undefined> => [])
  const open = vi.fn(async (_uri: string) => {})
  const start = vi.fn(() => (active = 'local-recording'))
  const stop = vi.fn(() => { active = undefined })
  const notify = vi.fn()
  const runner = createScheduledMeetingRunner({ open, joinTencentNumber, quick: async () => true, scan, active: () => active, start,
    stop, notify, automaticDetection: true, now: () => time, ...extra })
  return { ...runner, scan, open, start, stop, notify, setActive: (id: string) => { active = id }, advance: () => { time = 91_000 } }
}

describe('scheduled meetings', () => {
  it('does not submit quick meeting on a startup handoff and still detects a manual meeting', async () => {
    const openQuick = vi.fn(async () => { throw new MeetingClientHandoff('Main window not ready') })
    const submit = vi.fn(async () => true)
    const h = harness(undefined, { openQuick, quick: submit })
    const quick = { ...item, mode: 'quick' as const, meetingCode: undefined }
    expect(await h.join(quick)).toMatchObject({ ok: true, result: expect.stringContaining('Main window not ready') })
    expect(openQuick).toHaveBeenCalledExactlyOnceWith('tencent', 'wemeet://page/home', undefined)
    expect(h.open).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    h.scan.mockResolvedValue([room])
    await h.tick()
    await h.tick()
    expect(h.start).toHaveBeenCalledExactlyOnceWith(quick, room)
  })
  it('uses the DSH-verified room only when the matching desktop window is present', async () => {
    const h = harness(undefined, { quick: async () => ({ windowId: '42' }) })
    const quick = { ...item, mode: 'quick' as const, meetingCode: undefined }
    await h.join(quick)
    h.scan.mockResolvedValue([{ ...room, windowId: '41' }])
    await h.tick()
    expect(h.start).not.toHaveBeenCalled()
    const verified = { ...room, windowId: '42', evidence: 'dsh-window' as const }
    h.scan.mockResolvedValue([verified])
    await h.tick()
    expect(h.scan).toHaveBeenLastCalledWith(verified.app, '42')
    expect(h.start).toHaveBeenCalledExactlyOnceWith(quick, verified)
    await h.tick()
    expect(h.start).toHaveBeenCalledTimes(1)
  })
  it('traces client submission and timeout separately from recording', async () => {
    const trace = vi.fn()
    const h = harness(undefined, { newTrace: () => trace })
    const quick = { ...item, mode: 'quick' as const, meetingCode: undefined }
    await h.join(quick)
    expect(trace).toHaveBeenCalledWith('等待确认会中窗口')
    h.advance()
    await h.tick()
    expect(trace).toHaveBeenCalledWith('入会确认超时', '等待 90 秒后仍未确认目标会议')
    expect(h.start).not.toHaveBeenCalled()
  })

  it('prefers a valid Tencent meeting number, preserves the official invite, and rejects arbitrary URLs', () => {
    const url = 'https://meeting.qq.com/dm/x?pwd=test'
    expect(scheduledTarget({ ...item, meetingUrl: url }).fallbackUri).toBe(url)
    expect(scheduledTarget({ ...item, meetingUrl: url }, true).uri).toBe(url)
    expect(scheduledTarget(item).uri).toBe('wemeet://page/inmeeting?meeting_code=123456789')
    for (const url of ['file:///C:/test.exe', 'https://meeting.tencent.com.example.org', 'https://x@meeting.tencent.com/a']) {
      expect(() => scheduledTarget({ ...item, meetingUrl: url })).toThrow()
    }
    expect(scheduledTarget({ ...item, platform: 'zoom', meetingUrl: 'https://example.zoom.us/j/123' }).app).toBe('Zoom')
  })

  it('uses the native number entry and falls back to the invite only if entry could not be completed', async () => {
    const native = vi.fn(async (_code: string) => {})
    const url = 'https://meeting.tencent.com/dm/example'
    const h = harness(native)
    expect((await h.join({ ...item, meetingCode: '１２３–４５６–７８９', meetingUrl: url })).ok).toBe(true)
    expect(native).toHaveBeenCalledExactlyOnceWith('123456789')
    expect(h.open).not.toHaveBeenCalled()
    expect((await h.join({ ...item, meetingUrl: url }, true)).ok).toBe(true)
    expect(h.open).toHaveBeenCalledExactlyOnceWith(url)

    const failedNative = harness(async () => { throw new Error('client dialog unavailable') })
    expect((await failedNative.join({ ...item, meetingUrl: url })).ok).toBe(true)
    expect(failedNative.open).toHaveBeenCalledExactlyOnceWith(url)
  })

  it('distinguishes lobby, home and meeting windows', () => {
    expect(isScheduledCallTitle('腾讯会议')).toBe(false)
    expect(isScheduledCallTitle('等候室：123 456 789', 'MeetingMainWindow')).toBe(false)
    expect(isScheduledCallTitle('加入会议', 'ParticipantWnd')).toBe(false)
    expect(isScheduledCallTitle('项目例会', 'VideoCellWnd')).toBe(true)
    expect(isScheduledCallTitle('会议中')).toBe(true)
    expect(isScheduledCallTitle('项目例会', 'BaseDialog', true)).toBe(true)
    expect(isScheduledCallTitle('等待主持人', 'BaseDialog', true)).toBe(false)
  })

  it('recognizes Tencent quick rooms by the audio grid, not the title alone', () => {
    expect(isScheduledCallTitle('用户的快速会议', 'BaseDialog')).toBe(false)
    expect(isScheduledCallTitle('用户的快速会议', 'BaseDialog', false, true)).toBe(true)
    expect(isScheduledCallTitle('腾讯会议', 'BaseDialog', false, true)).toBe(false)
    expect(isScheduledCallTitle('等待主持人', 'BaseDialog', false, true)).toBe(false)
    expect(isScheduledCallTitle('用户的快速会议', 'JoinMeetingDialog', false, true)).toBe(false)
  })

  it('hands off a Tencent quick room detected after DSH returned unconfirmed', async () => {
    const trace = vi.fn()
    const h = harness(undefined, { quick: async () => false, newTrace: () => trace })
    const quick = { ...item, mode: 'quick' as const, meetingCode: undefined }
    const quickRoom = { ...room, windowTitle: '用户的快速会议', meetingCode: undefined, evidence: 'tencent-audio-grid' as const }
    expect((await h.join(quick)).ok).toBe(true)
    expect(h.start).not.toHaveBeenCalled()
    h.scan.mockResolvedValue([quickRoom])
    await h.tick()
    expect(h.start).not.toHaveBeenCalled()
    await h.tick()
    expect(h.start).toHaveBeenCalledExactlyOnceWith(quick, quickRoom, trace)
    expect(trace).toHaveBeenCalledWith('已确认会中窗口', '腾讯会议 AudioGridWidget')
  })

  it('can confirm the main meeting window when a participant window is also open', async () => {
    const h = harness()
    await h.join(item)
    const main = { ...room, primary: true }
    h.scan.mockResolvedValue([{ ...room, meetingCode: undefined, windowId: '2' }, main])
    await h.tick(); await h.tick()
    expect(h.start).toHaveBeenCalledExactlyOnceWith(item, main)
  })

  it('uses one dispatch and waits for two observations of the intended room', async () => {
    const h = harness()
    const inFlight = h.join(item)
    expect((await h.join(item)).result).toContain('无需重复提交')
    expect((await inFlight).ok).toBe(true)
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(h.start).not.toHaveBeenCalled()
    h.scan.mockResolvedValue([{ ...room, meetingCode: '987654321' }])
    await h.tick(); await h.tick()
    expect(h.start).not.toHaveBeenCalled()
    h.scan.mockResolvedValue([room])
    await h.tick()
    expect(h.start).not.toHaveBeenCalled()
    await h.tick(); await h.tick()
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('does not infer an end from failed scans and stops only its own recording', async () => {
    const h = harness()
    await h.join(item)
    h.scan.mockResolvedValue([room])
    await h.tick(); await h.tick()
    h.scan.mockResolvedValue(undefined)
    for (let i = 0; i < 7; i++) await h.tick()
    expect(h.stop).not.toHaveBeenCalled()
    h.scan.mockResolvedValue([])
    for (let i = 0; i < 5; i++) await h.tick()
    expect(h.stop).toHaveBeenCalledExactlyOnceWith('local-recording')

    await h.join(item)
    h.scan.mockResolvedValue([room])
    await h.tick(); await h.tick()
    h.setActive('manual-recording')
    h.scan.mockResolvedValue([])
    for (let i = 0; i < 6; i++) await h.tick()
    expect(h.stop).toHaveBeenCalledTimes(1)
  })

  it('respects opt-out and reports a deadline without opening the microphone', async () => {
    const h = harness()
    expect((await h.join({ ...item, autoRecord: false })).ok).toBe(true)
    expect(h.scan).not.toHaveBeenCalled()
    await h.join(item)
    h.advance()
    await h.tick()
    expect(h.notify).toHaveBeenCalledWith('unconfirmed', item)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('does not auto-record without a baseline or when an existing room was detected', async () => {
    const h = harness()
    h.scan.mockResolvedValue([{ ...room, meetingCode: '987654321' }])
    expect((await h.join(item)).ok).toBe(false)
    expect(h.open).not.toHaveBeenCalled()
    h.scan.mockResolvedValue(undefined)
    expect((await h.join(item)).ok).toBe(true)
    h.scan.mockResolvedValue([room])
    await h.tick(); await h.tick()
    expect(h.start).not.toHaveBeenCalled()
  })

  it('waits for window confirmation after an uncertain DSH response without relaunching', async () => {
    const joinNumber = vi.fn(async () => { throw new MeetingClientPending() })
    const h = harness(undefined, { joinNumber })
    const withLink = { ...item, meetingUrl: 'https://meeting.tencent.com/dm/example' }
    expect((await h.join(withLink)).ok).toBe(true)
    expect(joinNumber).toHaveBeenCalledExactlyOnceWith('tencent', '123456789')
    expect(h.open).not.toHaveBeenCalled()
    expect(h.start).not.toHaveBeenCalled()
    h.scan.mockResolvedValue([room])
    await h.tick(); await h.tick()
    expect(h.start).toHaveBeenCalledExactlyOnceWith(withLink, room)
  })

  it('opens a note for the matching already joined room without touching the mic when opted out', async () => {
    const showNote = vi.fn()
    const h = harness(undefined, { showNote })
    h.scan.mockResolvedValue([room])
    const noRecording = { ...item, autoRecord: false }
    expect((await h.join(noRecording)).ok).toBe(true)
    expect(showNote).toHaveBeenCalledExactlyOnceWith(noRecording, room)
    expect(h.open).not.toHaveBeenCalled()
    expect(h.start).not.toHaveBeenCalled()
  })
})
