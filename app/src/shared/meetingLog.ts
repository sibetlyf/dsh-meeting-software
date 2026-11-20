/**
 * 会议领域只追加事件日志（MeetingLog）与纯函数投影规范。
 *
 * 遵循 DSH「模型可见即已记录」准则：
 * 1. 先入日志，再可见：所有日程变更、会议生命周期、转写定稿、检索来源先成为事件；
 * 2. 只追加，不改写：删除与修正均以新事件（墓碑/补偿事件）表达；
 * 3. 纯函数折叠：fold(state, event) 无 IO、无副作用，任意时刻可从日志全量重建。
 */

export type MeetingLogSource = 'yogurt' | 'host' | 'agent' | 'user' | 'import'

export type MeetingLifecyclePhase =
  | 'scheduled'
  | 'joining'
  | 'active'
  | 'processing'
  | 'archived'
  | 'interrupted'

export interface MeetingLogEnvelope<T extends string = string, D = Record<string, unknown>> {
  /** 流内严格递增序号（从 1 开始） */
  seq: number
  /** ISO 时间戳 */
  at: string
  /** 所属流：'schedule' 或 'meeting:<meetingId>' */
  stream: string
  /** 写入方 */
  source: MeetingLogSource
  /** 因果关联 ID（触发该事件的命令或上级事件） */
  cause?: string
  /** 事件类型 */
  type: T
  /** 事件载荷（仅含事实，不含派生视图字段） */
  data: D
  /** 事件模式版本 */
  v: number
}

export interface ScheduleFact {
  mode?: 'join' | 'quick'
  id: string
  title: string
  platform: string
  meetingCode: string
  meetingUrl?: string
  cron?: string | null
  runAt?: string | null
  autoRecord?: boolean
}

export interface SchedulePatchFact {
  mode?: 'join' | 'quick'
  id: string
  title?: string
  platform?: string
  meetingCode?: string
  meetingUrl?: string
  cron?: string | null
  runAt?: string | null
  autoRecord?: boolean
}

export type ScheduleEvent =
  | MeetingLogEnvelope<'schedule/created', ScheduleFact>
  | MeetingLogEnvelope<'schedule/detected', ScheduleFact>
  | MeetingLogEnvelope<'schedule/imported', ScheduleFact & { rawTextHash?: string }>
  | MeetingLogEnvelope<'schedule/edited', SchedulePatchFact>
  | MeetingLogEnvelope<'schedule/paused', { id: string }>
  | MeetingLogEnvelope<'schedule/resumed', { id: string }>
  | MeetingLogEnvelope<'schedule/triggered', { id: string; triggeredAt: string }>
  | MeetingLogEnvelope<'schedule/status', { id: string; result: string }>
  | MeetingLogEnvelope<'schedule/deleted', { id: string }>

export type LifecycleEvent =
  | MeetingLogEnvelope<'meeting/start', { meetingId: string; title: string; platform: string; meetingCode?: string; scheduleId?: string }>
  | MeetingLogEnvelope<'meeting/detected', { meetingId: string; app: string; windowTitle: string; meetingCode?: string }>
  | MeetingLogEnvelope<'meeting/code-discovered', { meetingId: string; meetingCode: string }>
  | MeetingLogEnvelope<'meeting/titled', { meetingId: string; title: string }>
  | MeetingLogEnvelope<'meeting/end', { meetingId: string; reason?: string }>
  | MeetingLogEnvelope<'meeting/interrupted', { meetingId: string; reason: string }>
  | MeetingLogEnvelope<'processing/step-start', { meetingId: string; step: string }>
  | MeetingLogEnvelope<'processing/step-end', { meetingId: string; step: string; ok: boolean; detail?: string }>
  | MeetingLogEnvelope<'summary/generated', { meetingId: string; basedOnSeq: number; model?: string; provider?: string }>
  | MeetingLogEnvelope<'artifact/published', { meetingId: string; archiveName: string; dir: string }>
  | MeetingLogEnvelope<'knowledge/ingested', { meetingId: string; summarySeq: number; docId: string; contentHash: string }>
  | MeetingLogEnvelope<'retrieval/result', { question: string; sourceType: 'meeting' | 'knowledge' | 'soulmirror'; sourceId: string; contentHash?: string; asOfSeq?: number }>

export type AnyMeetingLogEvent = ScheduleEvent | LifecycleEvent | MeetingLogEnvelope

export interface ProjectedSchedule {
  detected?: true
  mode: 'join' | 'quick'
  id: string
  title: string
  platform: string
  platformRaw: string
  meetingCode: string
  meetingUrl: string
  cron: string | null
  runAt: string | null
  autoRecord: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
  triggeredAt?: string
  lastResult?: string
  displayTime: string
  isToday: boolean
}

export interface ProjectedMeetingLifecycle {
  meetingId: string
  phase: MeetingLifecyclePhase
  title: string
  platform: string
  meetingCode: string
  scheduleId?: string
  startedAt?: string
  endedAt?: string
  archiveName?: string
  lastStep?: string
  lastSeq: number
}

const PLATFORM_LABELS: Record<string, string> = {
  tencent: '腾讯会议',
  chinamobile: '移动云会议',
  feishu: '飞书会议',
  dingtalk: '钉钉会议',
  zoom: 'Zoom',
}

export function formatScheduleTime(
  cron: string | null,
  runAt: string | null,
  nowDate = new Date(),
): { displayTime: string; isToday: boolean } {
  const todayStr = nowDate.toLocaleDateString('sv-SE')
  if (cron) {
    const parts = String(cron).trim().split(/\s+/)
    if (parts.length >= 2) {
      const hh = parts[1].padStart(2, '0')
      const mm = parts[0].padStart(2, '0')
      return { displayTime: `每天 ${hh}:${mm}`, isToday: true }
    }
  }
  if (runAt) {
    const d = new Date(runAt)
    if (!Number.isNaN(d.getTime())) {
      const dStr = d.toLocaleDateString('sv-SE')
      const isToday = dStr === todayStr
      const hhmm = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
      return { displayTime: `${isToday ? '今天 ' : `${dStr} `}${hhmm}`, isToday }
    }
  }
  return { displayTime: '待定', isToday: false }
}

/** 纯函数折叠器：从 schedule/* 只追加事件流重建当前日程视图 */
export function foldSchedules(events: readonly MeetingLogEnvelope[], nowDate = new Date()): ProjectedSchedule[] {
  const map = new Map<string, ProjectedSchedule & { deleted?: boolean }>()

  for (const ev of events) {
    const d = (ev.data || {}) as Record<string, any>
    switch (ev.type) {
      case 'schedule/created':
      case 'schedule/imported':
      case 'schedule/detected': {
        if (!d.id) break
        const platformRaw = String(d.platform || 'tencent')
        const cron = d.cron ? String(d.cron) : null
        const runAt = d.runAt ? String(d.runAt) : null
        const { displayTime, isToday } = formatScheduleTime(cron, runAt, nowDate)
        map.set(String(d.id), {
          id: String(d.id),
          title: String(d.title || '未命名会议'),
          platform: PLATFORM_LABELS[platformRaw] || platformRaw || '腾讯会议',
          platformRaw,
          mode: d.mode === 'quick' ? 'quick' : 'join',
          meetingCode: String(d.meetingCode || ''),
          meetingUrl: String(d.meetingUrl || ''),
          cron,
          runAt,
          ...(ev.type === 'schedule/detected' ? { detected: true } : {}),
          autoRecord: ev.type !== 'schedule/detected' && d.autoRecord !== false,
          enabled: ev.type !== 'schedule/detected',
          createdAt: ev.at,
          updatedAt: ev.at,
          displayTime,
          isToday,
        })
        break
      }
      case 'schedule/edited': {
        const cur = map.get(String(d.id || ''))
        if (!cur || cur.deleted) break
        if (d.title !== undefined) cur.title = String(d.title || '未命名会议')
        if (d.platform !== undefined) {
          cur.platformRaw = String(d.platform)
          cur.platform = PLATFORM_LABELS[cur.platformRaw] || cur.platformRaw
        }
        if (d.meetingCode !== undefined) cur.meetingCode = String(d.meetingCode || '')
        if (d.meetingUrl !== undefined) cur.meetingUrl = String(d.meetingUrl || '')
        if (d.cron !== undefined) cur.cron = d.cron ? String(d.cron) : null
        if (d.runAt !== undefined) {
          cur.runAt = d.runAt ? String(d.runAt) : null
          // 手动修改了执行时间后，清空旧的已触发标记并自动恢复为启用状态
          cur.triggeredAt = undefined
          cur.enabled = !cur.detected
        }
        if (d.autoRecord !== undefined) cur.autoRecord = Boolean(d.autoRecord)
        if (d.mode === 'join' || d.mode === 'quick') cur.mode = d.mode
        const formatted = formatScheduleTime(cur.cron, cur.runAt, nowDate)
        cur.displayTime = formatted.displayTime
        cur.isToday = formatted.isToday
        cur.updatedAt = ev.at
        break
      }
      case 'schedule/paused': {
        const cur = map.get(String(d.id || ''))
        if (cur && !cur.deleted) {
          cur.enabled = false
          cur.updatedAt = ev.at
        }
        break
      }
      case 'schedule/resumed': {
        const cur = map.get(String(d.id || ''))
        if (cur && !cur.deleted && !cur.detected) {
          cur.enabled = true
          cur.updatedAt = ev.at
        }
        break
      }
      case 'schedule/triggered': {
        const cur = map.get(String(d.id || ''))
        if (cur && !cur.deleted) {
          cur.triggeredAt = String(d.triggeredAt || ev.at)
          delete cur.lastResult
          cur.updatedAt = ev.at
        }
        break
      }
      case 'schedule/deleted': {
        const cur = map.get(String(d.id || ''))
        if (cur) {
          cur.deleted = true
          cur.updatedAt = ev.at
        }
        break
      }
      case 'schedule/status': {
        const cur = map.get(String(d.id || ''))
        if (cur && !cur.deleted && typeof d.result === 'string') cur.lastResult = d.result
        break
      }
    }
  }

  return Array.from(map.values())
    .filter((item) => !item.deleted)
    .map(({ deleted: _deleted, ...rest }) => rest)
}

/** 纯函数折叠器：从单场会议的事件流重建会议生命周期状态 */
export function foldMeetingLifecycle(meetingId: string, events: readonly MeetingLogEnvelope[]): ProjectedMeetingLifecycle {
  const state: ProjectedMeetingLifecycle = {
    meetingId,
    phase: 'scheduled',
    title: '未命名会议',
    platform: '腾讯会议',
    meetingCode: '',
    lastSeq: 0,
  }

  for (const ev of events) {
    state.lastSeq = ev.seq
    const d = (ev.data || {}) as Record<string, any>
    switch (ev.type) {
      case 'meeting/start':
        state.phase = 'active'
        state.title = String(d.title || state.title)
        state.platform = String(d.platform || state.platform)
        if (d.meetingCode) state.meetingCode = String(d.meetingCode)
        if (d.scheduleId) state.scheduleId = String(d.scheduleId)
        state.startedAt = ev.at
        break
      case 'meeting/detected':
        if (state.phase === 'scheduled') state.phase = 'active'
        if (d.app) state.platform = String(d.app)
        if (d.meetingCode) state.meetingCode = String(d.meetingCode)
        break
      case 'meeting/code-discovered':
        if (d.meetingCode) state.meetingCode = String(d.meetingCode)
        break
      case 'meeting/titled':
        if (d.title) state.title = String(d.title)
        break
      case 'meeting/end':
        state.phase = 'processing'
        state.endedAt = ev.at
        break
      case 'meeting/interrupted':
        state.phase = 'interrupted'
        break
      case 'processing/step-start':
        state.phase = 'processing'
        state.lastStep = String(d.step || '')
        break
      case 'artifact/published':
        state.phase = 'archived'
        state.archiveName = String(d.archiveName || '')
        break
    }
  }

  return state
}

export interface InvariantViolation {
  seq: number
  code: 'SEQ_NOT_MONOTONIC' | 'UNCLOSED_PAIR' | 'ORPHAN_END'
  message: string
}

/**
 * 不变量校验器（对应 DSH session-invariant 思想）：
 * 检查流内 seq 严格递增、meeting/start↔end 与 processing/step-start↔step-end 配对。
 */
export function verifyStreamInvariants(events: readonly MeetingLogEnvelope[]): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  let expectedSeq = 1
  let meetingOpen = false
  const openSteps = new Set<string>()

  for (const ev of events) {
    if (ev.seq !== expectedSeq) {
      violations.push({
        seq: ev.seq,
        code: 'SEQ_NOT_MONOTONIC',
        message: `期望 seq=${expectedSeq}，实际收到 seq=${ev.seq}`,
      })
    }
    expectedSeq = ev.seq + 1

    if (ev.type === 'meeting/start') {
      meetingOpen = true
    } else if (ev.type === 'meeting/end' || ev.type === 'meeting/interrupted') {
      if (!meetingOpen) {
        violations.push({ seq: ev.seq, code: 'ORPHAN_END', message: `${ev.type} 缺少前置 meeting/start` })
      }
      meetingOpen = false
    } else if (ev.type === 'processing/step-start') {
      const step = String((ev.data as any)?.step || '')
      openSteps.add(step)
    } else if (ev.type === 'processing/step-end') {
      const step = String((ev.data as any)?.step || '')
      if (!openSteps.has(step)) {
        violations.push({ seq: ev.seq, code: 'ORPHAN_END', message: `processing/step-end(${step}) 缺少前置 step-start` })
      }
      openSteps.delete(step)
    }
  }

  return violations
}

