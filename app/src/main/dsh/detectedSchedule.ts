import { randomUUID } from 'node:crypto'
import { formatScheduleTime, type ProjectedSchedule } from '../../shared/meetingLog'
import type { DetectedMeeting } from '../meetingAutowatch'
import { readableMeetingTitle } from '../titles'
import { meetingWindowKey } from './ambientMeeting'
import type { MeetingLogStore } from './meetingLogStore'

type Observation = { id: string; room: DetectedMeeting; at: Date }

/** Independent of whether the person chooses to start recording. */
export function trackDetectedSchedules(save: (observation: Observation) => Promise<void>, now = () => new Date()) {
  type Track = Observation & { samples: number; misses: number; requested?: string }
  let tracks: Track[] = []
  let queue = Promise.resolve()
  return (rooms: DetectedMeeting[] | undefined) => {
    if (!rooms) {
      tracks = tracks.filter(track => track.samples >= 2)
      return queue
    }
    const seen = new Set<Track>()
    for (const room of rooms.filter(room => !room.auxiliary)) {
      const matches = (track: Track) => track.room.app === room.app && (track.room.meetingCode && room.meetingCode
        ? track.room.meetingCode === room.meetingCode : meetingWindowKey(track.room) === meetingWindowKey(room))
      let track = tracks.find(matches)
      if (track && seen.has(track)) continue
      if (!track) {
        track = { id: `detected_${randomUUID()}`, room, at: now(), samples: 0, misses: 0 }
        tracks.push(track)
      }
      seen.add(track)
      track.room = { ...room, meetingCode: room.meetingCode || track.room.meetingCode }
      track.misses = 0
      const code = track.room.meetingCode ?? ''
      if (++track.samples < 2 || track.requested === code) continue
      const entry = track
      entry.requested = code
      const observation = { id: entry.id, room: entry.room, at: entry.at }
      queue = queue.then(() => save(observation)).catch(error => {
        if (entry.requested === code) entry.requested = undefined
        console.warn('[schedule] could not save locally detected meeting:', error)
      })
    }
    tracks = tracks.filter(track => seen.has(track) || (track.samples >= 2 && ++track.misses < 5))
    return queue
  }
}

const normalizedCode = (s: string) => s.normalize('NFKC').replace(/[^0-9]/g, '')
const canonicalPlatform = (s: string) => {
  if (/^(?:tencent|\u817e\u8baf\u4f1a\u8bae)$/i.test(s)) return 'tencent'
  if (/^(?:chinamobile|\u4e2d\u56fd\u79fb\u52a8\u4e91\u4f1a\u8bae|\u79fb\u52a8(?:\u4e91)?\u4f1a\u8bae)$/i.test(s)) return 'chinamobile'
  if (/^(?:feishu|\u98de\u4e66\u4f1a\u8bae)$/i.test(s)) return 'feishu'
  if (/^(?:dingtalk|\u9489\u9489\u4f1a\u8bae)$/i.test(s)) return 'dingtalk'
  return s.toLowerCase()
}

/** A detection is a local observation, not an actionable appointment. */
export async function saveDetectedSchedule(store: MeetingLogStore, legacyPaths: string[], { id, at, room }: Observation): Promise<boolean> {
  await store.ensureLegacySchedulesImported(legacyPaths)
  const schedules = await store.getProjectedSchedules()
  const own = schedules.find(item => item.id === id)
  const events = await store.readStream('schedule')
  if (!own && events.some(event => event.type === 'schedule/deleted' && event.data.id === id)) return false
  const code = normalizedCode(room.meetingCode || '')
  const platform = canonicalPlatform(room.app)
  const duplicate = (item: ProjectedSchedule) => item.id !== id && !!code && canonicalPlatform(item.platformRaw) === platform
    && normalizedCode(item.meetingCode) === code && formatScheduleTime(item.cron, item.runAt, at).isToday
  if (schedules.some(duplicate)) {
    if (!own) return false
    await store.append('schedule', 'schedule/deleted', { id })
  } else if (own) {
    if (!code || normalizedCode(own.meetingCode) === code) return false
    await store.append('schedule', 'schedule/edited', { id, meetingCode: room.meetingCode })
  } else {
    const rawTitle = room.windowTitle.trim()
    const title = rawTitle && rawTitle !== room.app ? rawTitle : `${room.app} \u00b7 \u68c0\u6d4b\u5230\u7684\u4f1a\u8bae`
    await store.append('schedule', 'schedule/detected', {
      id, title: readableMeetingTitle({ title, platform: room.app, startedAt: at.getTime() }),
      platform: ['zoom', 'teams'].includes(platform) ? room.app : platform,
      meetingCode: room.meetingCode || '', runAt: at.toISOString(),
    })
  }
  return true
}
