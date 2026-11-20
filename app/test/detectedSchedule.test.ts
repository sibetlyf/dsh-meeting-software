import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAmbientMeetingWatcher } from '../src/main/dsh/ambientMeeting'
import { saveDetectedSchedule, trackDetectedSchedules } from '../src/main/dsh/detectedSchedule'
import { MeetingLogStore } from '../src/main/dsh/meetingLogStore'
import type { DetectedMeeting } from '../src/main/meetingAutowatch'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const room: DetectedMeeting = { app: '\u817e\u8baf\u4f1a\u8bae', processName: 'wemeetapp', windowId: '42', windowTitle: 'Daily sync', primary: true }
const code = '123-456-789'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'yogurt-detected-schedule-'))
  dirs.push(root)
  const store = new MeetingLogStore(root)
  const at = new Date(); at.setHours(12, 0, 0, 0)
  const save = vi.fn(async (observation: Parameters<typeof saveDetectedSchedule>[2]) => { await saveDetectedSchedule(store, [], observation) })
  return { root, store, at, save, observe: trackDetectedSchedules(save, () => at) }
}

it('adds one local schedule after confirmation even with auto-enter off and backfills a late meeting code', async () => {
  const { store, root, observe, at, save } = await fixture()
  const confirm = vi.fn(async () => true)
  const start = vi.fn(() => 'capture')
  let rows: DetectedMeeting[] | undefined = []
  let pending = Promise.resolve()
  const watcher = createAmbientMeetingWatcher({
    mode: () => 'off', confirm, start, onScan: sample => { pending = observe(sample) },
    autoStop: () => true, blocked: () => false, active: () => undefined, scan: async () => rows, stop: vi.fn(),
  })
  const tick = async () => { await watcher.tick(); await pending }
  await tick()
  rows = [room]; await tick()
  rows = undefined; await tick()
  rows = [room]; await tick()
  expect(save).not.toHaveBeenCalled()
  await tick(); await tick()
  expect(save).toHaveBeenCalledTimes(1)
  const [entry] = await store.getProjectedSchedules()
  expect(entry).toMatchObject({ title: 'Daily sync', isToday: true, runAt: at.toISOString(), detected: true, enabled: false, autoRecord: false, meetingCode: '' })
  rows = [{ ...room, meetingCode: code }]; await tick(); await tick()
  expect(await new MeetingLogStore(root).getProjectedSchedules()).toEqual([expect.objectContaining({ id: entry.id, meetingCode: code })])
  // Even a stray resume in the event log cannot make a detected entry actionable.
  await store.append('schedule', 'schedule/resumed', { id: entry.id })
  expect((await store.getProjectedSchedules())[0].enabled).toBe(false)
  const snapshot = join(root, 'compat.json')
  await store.syncScheduleProjectionSnapshot([snapshot])
  expect(JSON.parse(await readFile(snapshot, 'utf8'))).toEqual([])
  expect(confirm).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
})

it('does not duplicate a same-day appointment; a late code can reconcile the provisional local entry', async () => {
  const { store, at, observe } = await fixture()
  const appointment = { id: 'existing', title: 'Booked sync', platform: 'tencent', meetingCode: '123456789', runAt: at.toISOString() }
  await store.append('schedule', 'schedule/created', appointment)
  await observe([room]); await observe([room])
  expect(await store.getProjectedSchedules()).toHaveLength(2)
  await observe([{ ...room, meetingCode: code }])
  expect(await store.getProjectedSchedules()).toEqual([expect.objectContaining({ id: appointment.id, title: appointment.title, platformRaw: appointment.platform, meetingCode: appointment.meetingCode, enabled: true })])
  expect(await saveDetectedSchedule(store, [], { room: { ...room, meetingCode: code, windowId: '99' }, at, id: 'new-probe' })).toBe(false)
})

it('ignores auxiliary windows, keeps a deleted active entry deleted, and saves another meeting', async () => {
  const { store, observe } = await fixture()
  const auxiliary = { ...room, auxiliary: true }
  await observe([auxiliary]); await observe([auxiliary])
  expect(await store.getProjectedSchedules()).toHaveLength(0)
  await observe([room]); await observe([room])
  const [entry] = await store.getProjectedSchedules()
  await store.append('schedule', 'schedule/deleted', { id: entry.id })
  await observe([{ ...room, meetingCode: code }])
  expect(await store.getProjectedSchedules()).toHaveLength(0)
  const other = { ...room, windowId: '99', meetingCode: '987-654-321' }
  await observe([other]); await observe([other])
  expect(await store.getProjectedSchedules()).toEqual([expect.objectContaining({ meetingCode: other.meetingCode })])
})

it('does not create a duplicate detected meeting for a room already confirmed/suppressed by scheduled join', async () => {
  const { store, observe, save } = await fixture()
  let rows: DetectedMeeting[] | undefined = [room]
  let pending = Promise.resolve()
  const watcher = createAmbientMeetingWatcher({
    mode: () => 'auto',
    confirm: async () => true,
    start: () => 'capture',
    onScan: sample => { pending = observe(sample) },
    autoStop: () => true,
    blocked: () => false,
    active: () => undefined,
    scan: async () => rows,
    stop: vi.fn(),
  })
  watcher.suppress(room, true)
  await watcher.tick(); await pending
  await watcher.tick(); await pending
  expect(save).not.toHaveBeenCalled()
  expect(await store.getProjectedSchedules()).toHaveLength(0)
})
