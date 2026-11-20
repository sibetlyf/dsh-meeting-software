/**
 * Windows 会议软件全自动检测与启停引擎 (meetingAutowatch.ts)
 *
 * 每 3 秒扫描一次当前活动会议窗口，自动识别：
 * - 腾讯会议 (wemeetapp)
 * - 中国移动云会议 (cloudmeeting)
 * - 钉钉 (DingTalk)
 * - 飞书 (Feishu / Lark)
 * - Zoom / Microsoft Teams
 *
 * 检测到开会中 -> 自动开启双轨录音 + 百炼实时流式转写；
 * 检测到会议结束（连续 2 次探测消失）-> 自动结束录制并触发会后精转、声纹标注、纪要与知识库留档。
 */
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { userDataDir } from './paths'
import { meetingProbeScript } from './meetingProbe.mjs'

export interface DetectedMeeting {
  app: string;
  processName: string;
  windowTitle: string;
  meetingCode?: string;
  windowId?: string;
  primary?: boolean;
  auxiliary?: boolean;
  evidence?: 'tencent-audio-grid' | 'leave-control' | 'dsh-window';
}

export function normalizeDetectedMeetingCode(code: string): string | undefined {
  const normalized = code.normalize('NFKC').trim()
  if (!/^[0-9]+(?:[ \t\p{Dash_Punctuation}]+[0-9]+)*$/u.test(normalized)) return undefined
  const digits = normalized.replace(/[^0-9]/g, '')
  if (digits.length < 9 || digits.length > 12) return undefined
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
}

export function extractMeetingCode(title: string): string | undefined {
  title = title.normalize('NFKC').replace(/\p{Dash_Punctuation}/gu, '-')
  const labelled = title.match(/(?:\u4f1a\u8bae\u53f7|\u4f1a\u8baeID|meeting\s*(?:id|code)|conf(?:erence)?\s*id)[ \t:#]*(\d(?:[ \t-]*\d){8,11})(?![ \t-]*\d)/i)
  const grouped = labelled?.[1] ?? title.trim().match(/^(\d{3}[ \t-]\d{3}[ \t-]\d{3,6})$/)?.[1]
  return grouped ? normalizeDetectedMeetingCode(grouped) : undefined
}

let lastScanFailure = ''
let lastWindowSnapshot = ''


const MEETING_RULES: Array<{
  app: string;
  procRe: RegExp;
  isInMeeting: (title: string) => boolean;
}> = [
  {
    app: '腾讯会议',
    procRe: /^(wemeetapp|wemeet|tencentmeeting)$/i,
    // 识别腾讯会议窗口（排除登录/设置弹窗）
    isInMeeting: (title) => {
      const t = title.trim();
      if (!t || /登录|设置|检测/.test(t)) return false;
      return true;
    },
  },
  {
    app: '移动云会议',
    procRe: /^(cloudmeeting|cloudvideo|ydmeeting)$/i,
    isInMeeting: (title) => {
      const t = title.trim();
      if (!t || t === '中国移动云会议' || /登录/.test(t)) return false;
      return true;
    },
  },
  {
    app: '钉钉会议',
    procRe: /^dingtalk$/i,
    isInMeeting: (title) => /视频会议|语音会议|会议中|钉钉会议|通话/.test(title),
  },
  {
    app: '飞书会议',
    procRe: /^feishu$|^lark$/i,
    isInMeeting: (title) => /视频会议|飞书会议|Meeting|会议中/.test(title),
  },
  {
    app: 'Zoom',
    procRe: /^zoom$/i,
    isInMeeting: (title) => /^Zoom Meeting/i.test(title) || /会议/.test(title),
  },
  {
    app: 'Teams',
    procRe: /^ms-teams$|^teams$/i,
    isInMeeting: (title) => /Meeting|会议/.test(title),
  },
];

export function scanWindowsOnce(): Promise<DetectedMeeting | null> {
  return scanWindows().then(rows => rows?.[0] ?? null);
}

export function isScheduledCallTitle(title: string, windowClass = '', hasInCallControl = false, hasTencentAudioGrid = false): boolean {
  return !/加入会议|正在加入|等候室|等待主持人|预约|预定|会议详情|历史会议|会议设置|设备检测|登录|join(?:ing)? (?:a |the )?meeting|waiting|lobby|sign.in|settings/i.test(title)
    && !/join|premeeting|waiting|lobby/i.test(windowClass)
    && ((hasTencentAudioGrid && Boolean(title.trim()) && !/^(腾讯会议|wemeetapp|TencentMeeting)$/i.test(title.trim()))
      || hasInCallControl || /FloatSpeakingWnd|SpeakingWnd|ParticipantWnd|VideoCellWnd/i.test(windowClass)
      || /会议中|正在开会|通话中|^Zoom Meeting(?:\s|$)|^Meeting in progress/i.test(title)
      || Boolean(title && !/^(腾讯会议|移动会议|移动云会议|中国移动云会议|TencentMeeting|Zoom)$/i.test(title) && /VideoMainWindow|MeetingView|MeetingMainWindow/i.test(windowClass)));
}

export function classifyMeetingWindows(raw: unknown, app?: string, verifiedWindowId?: string, strict = Boolean(app)): DetectedMeeting[] {
  const rows: Array<{ ProcessName?: string; MainWindowTitle?: string; windowId?: string; windowClass?: string; hasInCallControl?: boolean; hasAudioGrid?: boolean; MeetingCode?: string }> = Array.isArray(raw) ? raw : []
  const matches: DetectedMeeting[] = []
  for (const row of rows) {
    const processName = String(row.ProcessName || '')
    const rawTitle = String(row.MainWindowTitle || '')
    if (rawTitle.includes('\uFFFD') && !row.hasAudioGrid && !row.hasInCallControl) continue
    const windowTitle = rawTitle.includes('\uFFFD') ? '' : rawTitle
    const meetingCode = normalizeDetectedMeetingCode(String(row.MeetingCode || '')) || extractMeetingCode(windowTitle)
    for (const rule of MEETING_RULES) {
      const hasTencentGrid = /^(wemeetapp|wemeet|tencentmeeting)$/i.test(processName) && row.hasAudioGrid === true
      const dshWindow = /^(wemeetapp|wemeet|tencentmeeting)$/i.test(processName) && Boolean(verifiedWindowId) && row.windowId === verifiedWindowId && /(?:\u7684\u5feb\u901f\u4f1a\u8bae|['\u2019]s quick meeting)$/i.test(windowTitle)
      if (rule.procRe.test(processName) && (!app || rule.app === app) && (strict ? isScheduledCallTitle(windowTitle || (row.hasAudioGrid ? 'Active meeting' : ''), row.windowClass, row.hasInCallControl, hasTencentGrid || dshWindow) : rule.isInMeeting(windowTitle))) {
        matches.push({ app: rule.app, processName, windowTitle: windowTitle || rule.app, meetingCode, windowId: String(row.windowId || ''),
          primary: dshWindow || hasTencentGrid || row.hasInCallControl === true || /VideoMainWindow|MeetingView|MeetingMainWindow/i.test(String(row.windowClass || '')),
          auxiliary: !dshWindow && !hasTencentGrid && !row.hasInCallControl && /FloatSpeakingWnd|SpeakingWnd|ParticipantWnd|VideoCellWnd/i.test(row.windowClass ?? ''),
          evidence: dshWindow ? 'dsh-window' : hasTencentGrid ? 'tencent-audio-grid' : row.hasInCallControl ? 'leave-control' : undefined })
      }
    }
  }
  if (!matches.length) {
    const snapshot = JSON.stringify(rows.map(row => ({ process: row.ProcessName, class: row.windowClass, leave: row.hasInCallControl, audioGrid: row.hasAudioGrid })))
    if (snapshot !== lastWindowSnapshot) console.info(`[meeting-scan] UIA snapshot: ${snapshot || 'no meeting windows returned'}`)
    lastWindowSnapshot = snapshot
  } else lastWindowSnapshot = ''
  return matches
}

const lastProbeSamples = new Map<string, number>()
export async function scanWindows(app?: string, verifiedWindowId?: string, strict = Boolean(app)): Promise<DetectedMeeting[] | undefined> {
  if (process.platform !== 'win32') return undefined
  const file = process.env.YOGURT_MEETING_PROBE_FILE
  if (file) {
    const consumer = app ?? (strict ? 'ambient' : 'manual')
    const deadline = Date.now() + 18_000
    do {
      const sample = await readFile(file, 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
      if (typeof sample?.at === 'number' && sample.at > (lastProbeSamples.get(consumer) ?? 0) && Date.now() - sample.at <= 20_000) {
        lastProbeSamples.set(consumer, sample.at)
        return Array.isArray(sample.rows) ? classifyMeetingWindows(sample.rows, app, verifiedWindowId, strict) : undefined
      }
      await delay(500)
    } while (Date.now() < deadline)
    return undefined
  }
  const scanTempDir = join(userDataDir(), 'meeting-scan-temp')
  try { mkdirSync(scanTempDir, { recursive: true }) } catch { return undefined }
  const probeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(temp|tmp|tmpdir)$/i.test(key)))
  Object.assign(probeEnv, { TEMP: scanTempDir, TMP: scanTempDir, TMPDIR: scanTempDir })
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(meetingProbeScript, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true, env: probeEnv }, (err, stdout) => {
      try {
        if (err || !stdout.trim()) throw new Error(`PowerShell scan failed (${err?.code ?? err?.signal ?? 'empty output'})`)
        const matches = classifyMeetingWindows(JSON.parse(stdout), app, verifiedWindowId, strict)
        lastScanFailure = ''
        resolve(matches)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Invalid window scan response'
        if (reason !== lastScanFailure) console.warn(`[meeting-scan] ${reason}`)
        lastScanFailure = reason
        resolve(undefined)
      }
    })
  })
}

export function startMeetingAutoWatcher(opts: {
  isEnabled: () => boolean;
  isRecording: () => boolean;
  onMeetingDetected: (m: DetectedMeeting) => void;
  onMeetingCodeDiscovered?: (m: DetectedMeeting) => void;
  onMeetingEnded: (m: DetectedMeeting) => void;
}): () => void {
  let active: DetectedMeeting | null = null;
  let missCount = 0;
  let busy = false;
  let lastNotifiedCode = '';

  const timer = setInterval(async () => {
    if (busy || !opts.isEnabled()) return;
    busy = true;
    try {
      const found = await scanWindowsOnce();
      if (found) {
        missCount = 0;
        if (!active && !opts.isRecording()) {
          active = found;
          lastNotifiedCode = found.meetingCode || '';
          opts.onMeetingDetected(found);
        } else if (found.meetingCode && found.meetingCode !== lastNotifiedCode) {
          lastNotifiedCode = found.meetingCode;
          active = found;
          opts.onMeetingCodeDiscovered?.(found);
        }
      } else if (active) {
        missCount++;
        // 连续 2 次（约 6 秒）未检测到会议窗口，判定为会议已结束
        if (missCount >= 2) {
          const ended = active;
          active = null;
          missCount = 0;
          lastNotifiedCode = '';
          opts.onMeetingEnded(ended);
        }
      }
    } finally {
      busy = false;
    }
  }, 3000);

  return () => clearInterval(timer);
}

