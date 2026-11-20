import type { DetectedMeeting } from '../meetingAutowatch'

export type ScheduledMeeting = {
  id: string; title: string; platform: string; meetingCode?: string; meetingUrl?: string; autoRecord?: boolean; mode?: 'join' | 'quick'
}

const platforms: Record<string, { app: string; scheme?: string; domains: string[] }> = {
  tencent: { app: '腾讯会议', scheme: 'wemeet:', domains: ['meeting.tencent.com', 'meeting.qq.com', 'voovmeeting.com'] },
  chinamobile: { app: '移动云会议', scheme: 'cloudmeeting:', domains: ['10086.cn', '139.com'] },
  feishu: { app: '飞书会议', domains: ['feishu.cn', 'larksuite.com'] },
  dingtalk: { app: '钉钉会议', domains: ['dingtalk.com'] },
  zoom: { app: 'Zoom', domains: ['zoom.us', 'zoom.com'] },
}

export type JoinTrace = (stage: string, detail?: string, at?: number) => void

const digits = (code?: string) => (code ?? '').replace(/[\s-]/g, '')

export function normalizeMeetingCode(code?: string): string {
  return (code ?? '').normalize('NFKC').replace(/[\s\p{Dash_Punctuation}]/gu, '')
}

export function scheduledTarget(item: ScheduledMeeting, preferLink = false): { uri: string; fallbackUri?: string; app: string; quick: boolean } {
  const platform = Object.hasOwn(platforms, item.platform) ? platforms[item.platform] : undefined
  if (!platform) throw new Error('不支持该会议平台')
  const raw = item.meetingUrl?.trim()
  if (item.mode === 'quick') {
    if (!platform.scheme) throw new Error('该平台不支持自动发起快速会议')
    if (raw || item.meetingCode?.trim() || preferLink) throw new Error('发起快速会议不需要会议号或邀请链接')
    return { uri: item.platform === 'tencent' ? 'wemeet://page/home' : `${platform.scheme}//`, app: platform.app, quick: true }
  }
  let link: string | undefined
  if (raw) {
    try {
      const url = new URL(raw)
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        platform.domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) link = url.href
    } catch { /* invalid links are never dispatched */ }
    if (!link) throw new Error('请使用所选平台的官方 HTTPS 入会链接')
  }
  const code = normalizeMeetingCode(item.meetingCode)
  if (preferLink) {
    if (!link) throw new Error('此日程没有官方邀请链接')
    return { uri: link, app: platform.app, quick: false }
  }
  if (item.platform === 'tencent' && /^\d{9,12}$/.test(code)) {
    return { uri: `wemeet://page/inmeeting?meeting_code=${code}`, fallbackUri: link, app: platform.app, quick: false }
  }
  if (link) return { uri: link, app: platform.app, quick: false }
  if (code) {
    if (item.platform === 'chinamobile' && /^\d{6,12}$/.test(code)) {
      return { uri: `cloudmeeting://join?confid=${code}`, app: platform.app, quick: false }
    }
    throw new Error(platform.scheme ? '会议号格式无效，请核对号码或使用官方邀请链接' : '该平台需要填写入会链接')
  }
  throw new Error(platform.scheme ? '请填写会议号或官方邀请链接' : '该平台需要填写入会链接')
}

type Phase = 'unconfirmed' | 'quick-click-unconfirmed' | 'joined' | 'recording' | 'ended'
type Result = { ok: boolean; result: string }
export class MeetingClientHandoff extends Error {}
export class MeetingClientPending extends Error {}

export function createScheduledMeetingRunner(deps: {
  open: (uri: string) => Promise<void>
  openQuick?: (platform: 'tencent' | 'chinamobile', uri: string, trace?: JoinTrace) => Promise<void>
  joinTencentNumber?: (code: string) => Promise<void>
  joinNumber?: (platform: 'tencent' | 'chinamobile', code: string, trace?: JoinTrace) => Promise<void>
  quick: (platform: 'tencent' | 'chinamobile', trace?: JoinTrace) => Promise<boolean | 'permission-denied' | { windowId: string }>
  scan: (app: string, verifiedWindowId?: string) => Promise<DetectedMeeting[] | undefined>
  active: () => string | undefined
  start: (item: ScheduledMeeting, detected: DetectedMeeting, trace?: JoinTrace) => string
  showNote?: (item: ScheduledMeeting, detected: DetectedMeeting) => void
  stop: (id: string) => void
  notify: (phase: Phase, item: ScheduledMeeting) => void
  automaticDetection: boolean
  newTrace?: (item: ScheduledMeeting) => JoinTrace
  onConfirmed?: (detected: DetectedMeeting) => void
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  let dispatching: string | undefined
  let scanning = false
  let closed = false
  type Watch = { item: ScheduledMeeting; app: string; until: number; trace?: JoinTrace; probeState?: string; quickClickSent?: boolean; corroboratedId?: string; exactOnly?: boolean; id?: string; observed?: string; samples: number; misses: number }
  let watch: Watch | undefined
  const identity = (m: DetectedMeeting) => `${m.processName}:${m.windowId || digits(m.meetingCode) || m.windowTitle}`
  const notifyUnconfirmed = (attempt: Watch) => {
    attempt.trace?.('入会确认超时', '等待 90 秒后仍未确认目标会议')
    deps.notify(attempt.quickClickSent ? 'quick-click-unconfirmed' : 'unconfirmed', attempt.item)
  }

  function confirmed(current: Watch, found: DetectedMeeting) {
    deps.onConfirmed?.(found)
    const evidence = found.evidence === 'tencent-audio-grid' ? '腾讯会议 AudioGridWidget'
      : found.evidence === 'leave-control' ? '离开或结束会议控件'
      : found.evidence === 'dsh-window' ? 'DSH 会中控件与本机窗口一致' : undefined
    if (evidence) current.trace?.('已确认会中窗口', evidence)
    else current.trace?.('已确认会中窗口')
    current.observed = identity(found)
    if (current.item.autoRecord === false) {
      deps.showNote?.(current.item, found)
      current.trace?.('笔记交接', '日程未开启自动录音')
      watch = undefined
      deps.notify('joined', current.item)
    } else {
      current.trace?.('笔记交接', '请求打开笔记并启动录音')
      current.id = current.trace ? deps.start(current.item, found, current.trace) : deps.start(current.item, found)
      deps.notify('recording', current.item)
    }
  }

  async function join(item: ScheduledMeeting, preferLink = false): Promise<Result> {
    if (closed) return { ok: false, result: '会议助手正在退出' }
    if (!dispatching && watch && (watch.id ? deps.active() !== watch.id : now() >= watch.until)) {
      const expired = watch
      watch = undefined
      if (!expired.id) notifyUnconfirmed(expired)
    }
    const previous = watch
    if (item.mode !== 'quick' && (dispatching === item.id || (!preferLink && previous?.item.id === item.id))) {
      if (!dispatching) await tick()
      return { ok: true, result: deps.active() ? '这场会议已在录音。' : '正在确认这场会议是否已进入，无需重复提交。' }
    }
    if (dispatching || deps.active() || (watch && !(preferLink && watch.item.id === item.id && !watch.id))) {
      return { ok: false, result: '已有会议正在连接或录音，请结束后再试' }
    }
    dispatching = item.id
    const trace = deps.newTrace?.(item)
    trace?.('收到请求', item.mode === 'quick' ? '发起快速会议' : '加入已有会议')
    try {
      trace?.('检查日程和入会参数')
      const target = scheduledTarget(item, preferLink)
      if (target.quick && !deps.automaticDetection) return { ok: false, result: '当前系统不支持自动发起快速会议' }
      const monitor = (target.quick || item.autoRecord !== false || Boolean(deps.showNote)) && deps.automaticDetection
      const baseline = previous ? [] : monitor ? await deps.scan(target.app) : undefined
      trace?.('客户端初始探测', !monitor ? '已跳过' : baseline ? `检测到 ${baseline.length} 个会中窗口` : '未获得探测结果')
      if (closed) return { ok: false, result: '会议助手正在退出' }
      if (deps.active()) return { ok: false, result: '已有录音正在进行，请先结束录音' }
      const code = normalizeMeetingCode(item.meetingCode)
      if (baseline?.length) {
        const existing = !target.quick && code && baseline.find(m => normalizeMeetingCode(m.meetingCode) === code)
        if (!existing) return { ok: false, result: '检测到已有会议，未能确认是此日程，请先核对客户端' }
        watch = { item, trace, app: target.app, until: now() + 90_000, samples: 0, misses: 0 }
        confirmed(watch, existing)
        return { ok: true, result: item.autoRecord === false ? '已在该会议中，已打开笔记。' : '已在该会议中，已打开笔记并启动录音。' }
      }
      let usedLink = target.uri.startsWith('https:')
      let manual = false
      let handoff: string | undefined
      try {
        if (deps.joinNumber && /^(?:wemeet:\/\/page\/inmeeting\?|cloudmeeting:\/\/join\?)/.test(target.uri)) {
          trace?.('发起会议号入会')
          const platform = item.platform as 'tencent' | 'chinamobile'
          await (trace ? deps.joinNumber(platform, code, trace) : deps.joinNumber(platform, code))
        } else if (deps.joinTencentNumber && target.uri.startsWith('wemeet://page/inmeeting?')) {
          await deps.joinTencentNumber(code)
        } else {
          trace?.(usedLink ? '打开邀请链接' : '唤起会议客户端')
          if (target.quick && deps.openQuick) await deps.openQuick(item.platform as 'tencent' | 'chinamobile', target.uri, trace)
          else await deps.open(target.uri)
          trace?.('打开请求已交给系统')
        }
      } catch (error) {
        if (error instanceof MeetingClientPending) manual = true
        else if (target.fallbackUri) {
          trace?.('改用邀请链接')
          await deps.open(target.fallbackUri)
          usedLink = true
        } else if (error instanceof MeetingClientHandoff) { manual = true; handoff = error.message }
        else throw error
      }
      const sent = manual ? '尚未确认入会，请检查会议客户端。' : usedLink ? '已打开官方邀请链接。' : '已向会议客户端发送请求。'
      if (target.quick) {
        const platform = item.platform as 'tencent' | 'chinamobile'
        const canSubmit = baseline && !manual && !closed && !deps.active()
        const submitted = canSubmit && await (trace ? deps.quick(platform, trace) : deps.quick(platform)).catch(() => false)
        const corroboratedId = typeof submitted === 'object' ? submitted.windowId : undefined
        if (baseline && !closed) watch = { item, trace, app: target.app, until: now() + 90_000, quickClickSent: submitted === true || Boolean(corroboratedId), corroboratedId, samples: 0, misses: 0 }
        trace?.('快速会议请求结果', corroboratedId ? 'DSH 已返回会中窗口' : submitted === true ? 'DSH 已报告点击' : submitted === 'permission-denied' ? '客户端授权被拒绝' : '未确认已提交')
        if (watch?.trace === trace) trace?.('等待确认会中窗口')
        if (handoff) return { ok: true, result: handoff + (watch ? ' 手动发起后，助手会继续确认会中窗口。' : '') }
        if (submitted === 'permission-denied') return { ok: true, result: 'DSH 未获会议客户端操作权限，未自动发起会议。可在客户端手动发起，助手会继续检测。' }
        return { ok: true, result: submitted ? '已提交快速会议请求，正在确认是否进入会议。'
          : baseline ? '请在客户端发起或确认快速会议，助手会继续检测。' : '请在客户端发起快速会议；当前无法自动确认，请手动开始笔记。' }
      }
      // A failed baseline cannot distinguish a newly joined call from an existing one.
      if (monitor && (baseline || (deps.joinNumber && code)) && !closed) {
        watch = { item, trace, app: target.app, until: now() + 90_000, exactOnly: !baseline, samples: 0, misses: 0 }
        trace?.('等待确认会中窗口')
        return { ok: true, result: `${sent}确认进入会议后将${item.autoRecord === false ? '打开笔记' : '打开笔记并启动录音'}。` }
      }
      watch = undefined
      return { ok: true, result: sent + (item.autoRecord === false ? '此日程未开启自动录音。' : '当前无法自动确认会议，可入会后手动开始笔记。') }
    } catch (error) {
      trace?.('发起操作失败', '请查看日程结果和前一条调试记录')
      return { ok: false, result: error instanceof Error ? error.message : '无法打开会议客户端' }
    } finally { dispatching = undefined }
  }

  async function tick() {
    const current = watch
    if (!current || closed || scanning || dispatching) return
    if (current.id ? deps.active() !== current.id : deps.active()) { watch = undefined; return }
    if (!current.id && now() >= current.until) { watch = undefined; notifyUnconfirmed(current); return }
    scanning = true
    try {
      const windows = await (current.corroboratedId ? deps.scan(current.app, current.corroboratedId) : deps.scan(current.app))
      if (closed || current !== watch || dispatching) return
      const probeState = windows ? `检测到 ${windows.length} 个会中候选窗口` : '窗口探测未返回结果'
      if (current.probeState !== probeState) {
        current.probeState = probeState
        current.trace?.('会中窗口探测', probeState)
      }
      if (!windows) {
        current.misses = 0
        current.samples = 0
        return
      }
      const expected = digits(current.item.meetingCode)
      const candidates = windows.filter(w => !expected || (!current.exactOnly && !w.meetingCode) || digits(w.meetingCode) === expected)
      const exact = expected ? candidates.filter(w => digits(w.meetingCode) === expected) : []
      const narrowed = exact.length ? exact : candidates
      const primary = narrowed.filter(w => w.primary)
      const found = current.id ? candidates.find(w => identity(w) === current.observed)
        : current.corroboratedId ? narrowed.find(w => w.windowId === current.corroboratedId)
        : narrowed.length === 1 ? narrowed[0] : primary.length === 1 ? primary[0] : undefined
      if (current.id) {
        if (deps.active() !== current.id) { watch = undefined; return }
        current.misses = found ? 0 : current.misses + 1
        if (current.misses >= 5) {
          current.trace?.('会中窗口已离开', '请求停止录音')
          deps.stop(current.id)
          watch = undefined
          deps.notify('ended', current.item)
        }
      } else if (found && !deps.active()) {
        const key = identity(found)
        if (key !== current.observed) current.trace?.('发现候选会议', '等待下一次探测确认')
        current.samples = key === current.observed ? current.samples + 1 : 1
        current.observed = key
        if (current.samples >= 2 || current.corroboratedId === found.windowId && Boolean(current.corroboratedId)) confirmed(current, found)
      } else { current.samples = 0; current.observed = undefined }
    } catch (error) {
      current.trace?.('会中检测或交接异常')
      throw error
    } finally { scanning = false }
  }

  return { join, tick, isBusy: () => Boolean(dispatching || watch), dispose: () => { closed = true; watch = undefined } }
}
