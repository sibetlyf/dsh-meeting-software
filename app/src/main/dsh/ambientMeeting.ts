import type { DetectedMeetingMode } from '../../shared/types'
import type { DetectedMeeting } from '../meetingAutowatch'

export function meetingWindowKey(room: DetectedMeeting) {
  return `${room.processName}:${room.windowId || room.meetingCode || room.windowTitle}`
}

function sameRoom(a: DetectedMeeting, b: DetectedMeeting, allowWindowMatch = true) {
  if (a.app !== b.app) return false
  if (a.meetingCode && b.meetingCode) return a.meetingCode === b.meetingCode
  return allowWindowMatch && meetingWindowKey(a) === meetingWindowKey(b)
}

function currentRoom(previous: DetectedMeeting, current: DetectedMeeting): DetectedMeeting {
  return { ...current, meetingCode: current.meetingCode || previous.meetingCode }
}

const ABSENCE_SAMPLES = 5

export function createAmbientMeetingWatcher(deps: {
  mode: () => DetectedMeetingMode
  confirm: (room: DetectedMeeting, signal: AbortSignal) => Promise<boolean>
  autoStop: () => boolean
  scan: () => Promise<DetectedMeeting[] | undefined>
  onScan?: (rooms: DetectedMeeting[] | undefined) => void
  blocked: () => boolean
  active: () => string | undefined
  start: (room: DetectedMeeting) => string
  onCode?: (id: string, room: DetectedMeeting) => void
  stop: (id: string) => void
  diagnose?: (message: string) => void
}) {
  type Suppression = { room: DetectedMeeting; misses: number; rememberCode: boolean }
  const suppressed: Suppression[] = []
  let sample: DetectedMeeting | undefined
  let owned: { id: string; room: DetectedMeeting; misses: number } | undefined
  let prompt: { room: DetectedMeeting; controller: AbortController; accepted: boolean } | undefined
  let disposed = false
  let scanning = false
  let lastMode: DetectedMeetingMode | undefined
  let lastDiagnostic = ''
  function diagnose(message: string) {
    if (message !== lastDiagnostic) { lastDiagnostic = message; deps.diagnose?.(message) }
  }

  function suppress(room: DetectedMeeting, rememberCode = false) {
    const existing = suppressed.find(entry => sameRoom(entry.room, room, entry.misses < ABSENCE_SAMPLES))
    if (existing) {
      existing.room = currentRoom(existing.room, room)
      existing.misses = 0
      existing.rememberCode ||= rememberCode
    } else suppressed.push({ room, misses: 0, rememberCode })
  }
  function recordingStopped(id: string) {
    if (owned?.id !== id) return
    suppress(owned.room, true)
    owned = undefined
    sample = undefined
  }

  function cancelPrompt() {
    const old = prompt
    prompt = undefined
    old?.controller.abort()
  }

  function requestConfirmation(room: DetectedMeeting) {
    const pending = { room, controller: new AbortController(), accepted: false }
    prompt = pending
    void Promise.resolve().then(() => {
      if (prompt === pending) return deps.confirm(room, pending.controller.signal)
    }).then(accepted => {
      if (prompt !== pending) return
      if (deps.mode() !== 'confirm' || deps.active() || deps.blocked()) { cancelPrompt(); return }
      if (accepted) pending.accepted = true // Wait for a fresh matching scan before recording.
      else { suppress(pending.room, true); cancelPrompt() }
    }).catch(error => {
      if (prompt !== pending) return
      suppress(pending.room)
      cancelPrompt()
      diagnose(`confirmation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  function mode() {
    const next = deps.mode()
    if (next !== lastMode) { lastMode = next; sample = undefined; cancelPrompt() }
    return next
  }

  async function tick() {
    if (disposed || scanning) return
    const before = mode()
    if (deps.blocked()) { diagnose('blocked by scheduled meeting, finishing, or resume'); sample = undefined; cancelPrompt(); return }
    if (!owned && before === 'off' && !suppressed.length && !deps.onScan) { diagnose('disabled'); return }
    scanning = true
    try {
      const rooms = await deps.scan()
      const action = mode()
      if (disposed || deps.blocked() || !rooms) {
        if (!disposed && !deps.blocked() && !rooms && (!deps.active() || owned)) deps.onScan?.(undefined)
        if (owned) owned.misses = 0
        diagnose(rooms ? 'blocked after scan' : 'scan returned no result')
        sample = undefined
        if (disposed || deps.blocked()) cancelPrompt()
        return
      }
      // Auxiliary speaking windows must not be mistaken for an active room.
      const eligible = rooms.filter(room => !room.auxiliary)
      const available = eligible.filter(room => !suppressed.some(entry => sameRoom(entry.room, room, entry.misses < ABSENCE_SAMPLES)))
      // 已被日程入会抑制（suppressed）或外部已接管录音（deps.active() && !owned）的会议不再上报为“新检测到的会议”
      if (!deps.active() || owned) deps.onScan?.(available)
      for (let i = suppressed.length - 1; i >= 0; i--) {
        const entry = suppressed[i]
        const found = eligible.find(room => sameRoom(entry.room, room, entry.misses < ABSENCE_SAMPLES))
        if (found) { entry.room = currentRoom(entry.room, found); entry.misses = 0 }
        else if (entry.misses < ABSENCE_SAMPLES && ++entry.misses >= ABSENCE_SAMPLES && !(entry.rememberCode && entry.room.meetingCode)) suppressed.splice(i, 1)
      }
      if (owned) {
        if (deps.active() !== owned.id) { recordingStopped(owned.id); return }
        const tracked = owned
        const current = eligible.find(room => sameRoom(tracked.room, room))
        if (current) {
          if (current.meetingCode && !tracked.room.meetingCode) deps.onCode?.(tracked.id, current)
          tracked.room = currentRoom(tracked.room, current)
        }
        tracked.misses = current ? 0 : tracked.misses + 1
        if (tracked.misses >= ABSENCE_SAMPLES && deps.autoStop()) { owned = undefined; deps.stop(tracked.id) }
        return
      }
      if (deps.active() || action === 'off') { sample = undefined; cancelPrompt(); return }
      const primary = available.filter(room => room.primary)
      const room = primary.length === 1 ? primary[0] : primary.length === 0 && available.length === 1 ? available[0] : undefined
      diagnose(`scan found ${rooms.length} candidate window(s), selectable=${room ? 'yes' : 'no'}`)
      if (prompt && (!room || !sameRoom(prompt.room, room))) cancelPrompt()
      if (!room) { sample = undefined; return }
      let confirmed: DetectedMeeting
      if (prompt) {
        prompt.room = currentRoom(prompt.room, room)
        if (!prompt.accepted) return
        confirmed = prompt.room
        cancelPrompt()
      } else {
        if (!sample || !sameRoom(sample, room)) { sample = room; return }
        confirmed = currentRoom(sample, room)
        sample = undefined
        if (action === 'confirm') { requestConfirmation(confirmed); return }
      }
      owned = { id: deps.start(confirmed), room: confirmed, misses: 0 }
      diagnose(`started recording for ${meetingWindowKey(room)}`)
    } finally { scanning = false }
  }

  return { tick, suppress, recordingStopped, dispose: () => { disposed = true; cancelPrompt() } }
}
