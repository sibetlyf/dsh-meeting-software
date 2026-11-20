import type { JoinTrace } from './scheduledMeeting';
/**
 * DSH 宿主桥接外观 (dshBridge.ts)
 *
 * 职责（已模块化拆分）：
 * - 进程自举、凭证与 cordis.patch.yml 单一模型配置管理；
 * - 协调 MeetingLogStore（只追加事件流）、invitationParser、clientLauncher 与 knowledgeService；
 * - 优先使用 DSH SSE 事件流与 HTTP API，DSH 不可达时自动降级本地日志引擎。
 */
import { readFile, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { embeddedDshEnvironment, spawnEmbeddedDsh } from './embeddedProcess';
import { parseExternalDshEndpoint } from './externalEndpoint.mjs';
import yaml from 'js-yaml';
import { userDataDir } from '../paths';
import { saveDetectedSchedule } from './detectedSchedule';
import { MeetingLogStore } from './meetingLogStore';
import { parseMeetingInvitationText } from './invitationParser';
import {
  buildArchiveFolderName,
  getMeetingArtifactBundle as getBundleImpl,
  ingestToKnowledgeBase as ingestImpl,
  listMeetingArtifacts as listArtifactsImpl,
  publishMeetingArtifacts as publishArtifactsImpl,
  searchExternalKnowledge as searchExternalImpl,
  type ExternalKnowledgeItem,
  type KnowledgeServiceDeps,
  type MeetingArtifactPayload,
} from './knowledgeService';
import type { MeetingLogSource, ProjectedMeetingLifecycle, ProjectedSchedule } from '../../shared/meetingLog';

export type { MeetingArtifactPayload, ExternalKnowledgeItem };
export { buildArchiveFolderName, parseMeetingInvitationText };

function bundledDshResourcesDir(): string | undefined {
  const resPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resPath) return undefined;
  const candidate = join(resPath, 'dsh-bundle');
  return existsSync(candidate) ? candidate : undefined;
}

const DEFAULT_DSH_PORT = Number(process.env.DSH_MEETING_PORT || 3090);
// On Windows the application launcher owns both processes; Electron must not spawn a second DSH.
const suppliedEndpoint = process.env.YOGURT_DSH_MANAGED_URL || process.env.YOGURT_DSH_EXTERNAL_URL;
const externalEndpoint = suppliedEndpoint ? parseExternalDshEndpoint(suppliedEndpoint) : undefined;
const DEFAULT_BASE_URL = externalEndpoint?.baseUrl ?? `http://127.0.0.1:${DEFAULT_DSH_PORT}`;
const managedProfile = !externalEndpoint && (process.env.DSH_EMBEDDED_MANAGED === '1' || Boolean(bundledDshResourcesDir()));
const FALLBACK_POLL_MS = 3000;

let triggerImmediateScheduleCheck: (() => void) | null = null;

export interface DshCredentials {
  dashscopeApiKey?: string;
  volcengineApiKey?: string;
  cctqApiKey?: string;
}

export interface MeetingVoiceConfig {
  dashscopeApiKey: string;
  hasDashscopeKey: boolean;
  realtimeAsrModel: 'paraformer-realtime-v2' | 'sensevoice-v1';
  postMeetingOfflineAsr: boolean;
  voiceprintEnabled: boolean;
  voiceprintThreshold: number;
  llmModel: string;
  enrolledSpeakers: string[];
}

let dshChild: ChildProcess | null = null;
let childSessionReady = false;
let dshWebUrl = externalEndpoint?.webUrl ?? (managedProfile ? DEFAULT_BASE_URL : process.env.DSH_WEB_URL || DEFAULT_BASE_URL);
let dshAuthToken = externalEndpoint?.token ?? (managedProfile ? '' : process.env.DSH_AUTH_TOKEN || '');
let startupTask: ReturnType<typeof startEmbeddedProfile> | undefined;
let shuttingDown = false;
let logStoreInstance: MeetingLogStore | null = null;

function resolveRepoRoot(): string {
  // 向上探测包含 .dsh-home 的目录，避免硬编码盘符路径
  let cur = process.cwd();
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(cur, '.dsh-home'))) return cur;
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

export function getDshHome(): string {
  if (process.env.DSH_HOME?.trim()) return process.env.DSH_HOME.trim();
  if (bundledDshResourcesDir()) return join(userDataDir(), 'dsh-home');
  const repoEmbedded = join(resolveRepoRoot(), '.dsh-home');
  if (existsSync(repoEmbedded)) return repoEmbedded;
  return join(homedir(), '.dsh');
}

/** 打包版首次启动时，将安装包内置的 meeting Profile 配置与 5 个插件初始化到用户可写 dsh-home 目录 */
async function ensurePackagedDshHomeSeeded(bundleDir: string, dshHome: string): Promise<void> {
  const tplDir = join(bundleDir, 'profile-template');
  const targetProfile = join(dshHome, 'profiles', 'meeting');
  await mkdir(targetProfile, { recursive: true });

  // package.json 与 cordis.yml 随安装包更新；cordis.patch.yml 仅首次复制以保留用户模型配置
  for (const file of ['package.json', 'cordis.yml']) {
    const src = join(tplDir, file);
    if (existsSync(src)) await copyFile(src, join(targetProfile, file));
  }
  const patchSrc = join(tplDir, 'cordis.patch.yml');
  const patchDst = join(targetProfile, 'cordis.patch.yml');
  if (existsSync(patchSrc) && !existsSync(patchDst)) {
    await copyFile(patchSrc, patchDst);
  }

  // 将内置的 node_modules（含 5 个插件）通过目录联接挂载到用户 Profile，无需管理员权限且升级自动同步
  const nmSrc = join(tplDir, 'node_modules');
  const nmDst = join(targetProfile, 'node_modules');
  if (existsSync(nmSrc)) {
    try {
      if (existsSync(nmDst)) {
        const st = lstatSync(nmDst);
        if (st.isSymbolicLink()) await rm(nmDst, { recursive: true, force: true });
      }
      if (!existsSync(nmDst) && process.platform === 'win32') {
        execFileSync('cmd', ['/c', 'mklink', '/J', nmDst, nmSrc], { windowsHide: true, stdio: 'ignore' });
      }
    } catch (err) {
      console.warn('[dshBridge] 挂载内置插件目录失败:', err);
    }
  }

  // 同步预校准的腾讯会议按钮坐标（若用户尚未标定）
  const uiMapSrc = join(bundleDir, 'soulmirror', 'uimap.json');
  const uiMapDst = join(dshHome, 'soulmirror', 'uimap.json');
  if (existsSync(uiMapSrc) && !existsSync(uiMapDst)) {
    await mkdir(join(dshHome, 'soulmirror'), { recursive: true });
    await copyFile(uiMapSrc, uiMapDst);
  }
}

export function getWritableDataDir(): string {
  return process.env.DSH_WRITABLE_DATA_DIR?.trim() || join(userDataDir(), 'dsh-data');
}

export function getArtifactsRoot(): string {
  return process.env.DSH_ARTIFACTS_DIR?.trim() || join(getWritableDataDir(), 'artifacts', 'meetings');
}

export function getMeetingLogStore(): MeetingLogStore {
  if (!logStoreInstance) {
    logStoreInstance = new MeetingLogStore(join(getWritableDataDir(), 'meeting-logs'));
  }
  return logStoreInstance;
}

function legacyScheduleFiles(): string[] {
  return Array.from(new Set([join(getDshHome(), 'meeting-schedules.json'), join(getWritableDataDir(), 'meeting-schedules.json')]));
}

function refreshSessionFromDisk() {
  if (externalEndpoint || managedProfile || childSessionReady) return;
  const candidates = [
    process.env.DSH_SESSION_FILE,
    resolve(userDataDir(), '..', 'dsh-web-session.json'),
    join(resolveRepoRoot(), '.dsh-runtime', 'dsh-web-session.json'),
  ].filter(Boolean) as string[];
  for (const f of candidates) {
    try {
      if (existsSync(f)) {
        const saved = JSON.parse(readFileSync(f, 'utf8'));
        if (saved?.authToken) dshAuthToken = saved.authToken;
        if (saved?.webUrl) dshWebUrl = saved.webUrl;
        return;
      }
    } catch {}
  }
}

export function getDshWebUrl(): string {
  refreshSessionFromDisk();
  return dshWebUrl;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  refreshSessionFromDisk();
  return dshAuthToken ? { ...extra, Authorization: `Bearer ${dshAuthToken}` } : extra;
}

function knowledgeDeps(): KnowledgeServiceDeps {
  return {
    baseUrl: DEFAULT_BASE_URL,
    dshHome: getDshHome,
    artifactsRoot: getArtifactsRoot,
    authHeaders,
    hasAuth: () => Boolean(dshAuthToken),
  };
}

export async function loadDshCredentials(): Promise<DshCredentials> {
  const credsPath = join(getDshHome(), '.credentials.yaml');
  const out: DshCredentials = {
    dashscopeApiKey: process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY,
    volcengineApiKey: process.env.VOLCENGINE_API_KEY,
    cctqApiKey: process.env.CCTQ_API_KEY,
  };
  try {
    if (!existsSync(credsPath)) return out;
    const doc = (yaml.load(await readFile(credsPath, 'utf8')) || {}) as Record<string, any>;
    const refs = doc?.refs || {};
    out.dashscopeApiKey ||= refs.DASHSCOPE_API_KEY || refs.BAILIAN_API_KEY || doc?.dashscope?.apiKey || doc?.bailian?.apiKey;
    out.volcengineApiKey ||= refs.VOLCENGINE_API_KEY || doc?.volcengine?.apiKey;
    out.cctqApiKey ||= refs.CCTQ_API_KEY || doc?.cctq?.apiKey;
  } catch (err) {
    console.warn('[dshBridge] 读取 .credentials.yaml 失败:', err);
  }
  return out;
}

export async function isDshProfileAlive(baseUrl = DEFAULT_BASE_URL): Promise<boolean> {
  if (managedProfile && !childSessionReady) return false;
  try {
    if (externalEndpoint && baseUrl !== externalEndpoint.baseUrl) return false;
    const res = await fetch(`${baseUrl}/api/dsh-meeting/v1/health`, { headers: authHeaders(), signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!res.ok) return false;
    const json = await res.json();
    return json?.ok === true && json?.plugin === 'dsh-meeting-host' && (!(managedProfile || externalEndpoint) || json.desktopScheduler === true);
  } catch { return false; }
}

export function ensureDshProfileRunning() {
  return startupTask ??= startEmbeddedProfile().finally(() => { startupTask = undefined; });
}

async function startEmbeddedProfile(): Promise<{ ok: boolean; baseUrl: string; webUrl: string }> {
  if (process.env.YOGURT_WITHOUT_DSH === '1') return { ok: false, baseUrl: DEFAULT_BASE_URL, webUrl: dshWebUrl };
  if (externalEndpoint) return { ok: !shuttingDown && await isDshProfileAlive(), baseUrl: DEFAULT_BASE_URL, webUrl: dshWebUrl };

  const bundleDir = bundledDshResourcesDir();
  if (bundleDir) {
    await ensurePackagedDshHomeSeeded(bundleDir, getDshHome());
  }

  // 确保 ~/.dsh/soulmirror/uimap.json 的标定坐标已同步至内置 .dsh-home/soulmirror/uimap.json
  try {
    const userUiMap = join(homedir(), '.dsh', 'soulmirror', 'uimap.json');
    const embeddedUiMap = join(getDshHome(), 'soulmirror', 'uimap.json');
    if (existsSync(userUiMap) && !existsSync(embeddedUiMap)) {
      await mkdir(join(getDshHome(), 'soulmirror'), { recursive: true });
      await copyFile(userUiMap, embeddedUiMap);
    }
  } catch {}

  if (await isDshProfileAlive()) return { ok: true, baseUrl: DEFAULT_BASE_URL, webUrl: dshWebUrl };
  if (shuttingDown) return { ok: false, baseUrl: DEFAULT_BASE_URL, webUrl: dshWebUrl };

  const dshCandidates = [
    bundleDir ? join(bundleDir, 'dsh', 'lib', 'bin.js') : undefined,
    process.env.DSH_BIN,
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'E:\\NodeJS\\node_global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  ].filter((p): p is string => Boolean(p && existsSync(p)));

  const dshBin = dshCandidates[0];
  if (!dshBin) return { ok: false, baseUrl: DEFAULT_BASE_URL, webUrl: dshWebUrl };

  if (!dshChild) {
    const bundledNode = bundleDir ? join(bundleDir, 'node.exe') : '';
    const nodeBin = (bundledNode && existsSync(bundledNode))
      ? bundledNode
      : (process.env.NODE_BIN || (existsSync('E:\\NodeJS\\node.exe') ? 'E:\\NodeJS\\node.exe' : 'node'));
    const dshNodeModules = bundleDir ? join(bundleDir, 'dsh', 'node_modules') : '';
    const childEnv = embeddedDshEnvironment(
      {
        ...process.env,
        DSH_HOME: getDshHome(),
        DSH_MEETING_DESKTOP_SCHEDULER: '1',
        ...(dshNodeModules && existsSync(dshNodeModules)
          ? { NODE_PATH: [dshNodeModules, process.env.NODE_PATH].filter(Boolean).join(';') }
          : {}),
      },
      getWritableDataDir(),
    );
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.CHROME_CRASHPAD_PIPE_NAME;
    dshChild = spawnEmbeddedDsh(nodeBin, dshBin, DEFAULT_DSH_PORT, childEnv);
    const child = dshChild;
    child.stdin?.on('error', () => {});
    const clear = () => {
      if (dshChild !== child) return;
      dshChild = null; childSessionReady = false;
      if (managedProfile) { dshAuthToken = ''; dshWebUrl = DEFAULT_BASE_URL; }
    };
    child.once('error', err => { console.warn('[dsh] spawn failed:', err.message); clear(); });
    child.once('exit', clear);
    let startup = '';
    const captureStartupUrl = (chunk: Buffer) => {
      if (childSessionReady || dshChild !== child) return;
      startup = (startup + chunk.toString('utf8')).slice(-4096);
      const m = startup.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)\s/);
      if (m && new URL(m[0].trim()).origin === DEFAULT_BASE_URL) {
        dshWebUrl = m[0].trim(); dshAuthToken = m[1]; childSessionReady = true;
      }
    };
    child.stdout?.on('data', captureStartupUrl);
    child.stderr?.on('data', captureStartupUrl);
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDshProfileAlive()) return { ok: true, baseUrl: DEFAULT_BASE_URL, webUrl: dshWebUrl };
    if (!dshChild) break;
  }
  return { ok: false, baseUrl: DEFAULT_BASE_URL, webUrl: dshWebUrl };
}

/** 退出软件时一并关闭内置 DSH `meeting` Profile 进程树并刷新事件日志 */
export function stopEmbeddedDshProfile(): void {
  try {
    void getMeetingLogStore().flush();
  } catch {}

  shuttingDown = true;
  dshChild?.stdin?.end();
}

export async function orchestrateNaturalLanguage(
  prompt: string,
  sessionId?: string,
  title = '会议助手自然语言调度',
): Promise<{ ok: boolean; sessionId?: string; reply: string; tools?: string[] }> {
  if (!sessionId) {
    const parsed = parseMeetingInvitationText(prompt);
    if (parsed) {
      const record = await createScheduleManual({
        title: parsed.title,
        platform: parsed.platform,
        meetingCode: parsed.meetingCode,
        meetingUrl: parsed.meetingUrl,
        runAt: parsed.runAt,
        autoRecord: false,
        source: 'import',
        rawTextHash: parsed.rawTextHash,
      });
      const platformLabel = parsed.platform === 'chinamobile' ? '移动云会议' : '腾讯会议';
      return {
        ok: true,
        reply: [
          `已解析会议邀请并写入事件日志，生成日程「${record.title}」：`,
          `- 平台：${platformLabel}`,
          `- 会议号：${record.meetingCode || '未识别'}`,
          `- 时间：${record.runAt || '待定'}`,
          ...(record.meetingUrl ? [`- 入会链接：${record.meetingUrl}`] : []),
        ].join('\n'),
        tools: ['meeting_invitation_parser'],
      };
    }
  }

  refreshSessionFromDisk();
  if (!(await ensureDshProfileRunning()).ok) return { ok: false, reply: '内置 DSH 尚未就绪，请稍后重试。' };

  const res = await fetch(`${DEFAULT_BASE_URL}/api/dsh-meeting/v1/copilot/chat`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prompt, sessionId, title }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, reply: `DSH sessionController 请求失败 (HTTP ${res.status}): ${errText || res.statusText}` };
  }
  const json = (await res.json()) as any;
  return {
    ok: Boolean(json?.ok),
    sessionId: json?.sessionId,
    reply: json?.reply || json?.error || '',
    tools: Array.isArray(json?.tools) ? json.tools : undefined,
  };
}

export function getCordisPatchPath(): string {
  return join(getDshHome(), 'profiles', 'meeting', 'cordis.patch.yml');
}

export async function readCordisDefaultModel(): Promise<{ provider: string; model: string }> {
  const patchPath = getCordisPatchPath();
  try {
    if (existsSync(patchPath)) {
      const patches = yaml.load(await readFile(patchPath, 'utf8'));
      if (Array.isArray(patches)) {
        const entry = patches.find((p: any) => p?.id === 'agent-default-model');
        if (entry?.config?.provider && entry?.config?.model) {
          return { provider: String(entry.config.provider), model: String(entry.config.model) };
        }
      }
    }
  } catch {}
  return { provider: 'volcengine', model: 'deepseek-v4.1-flash' };
}

export async function getMeetingVoiceConfig(): Promise<MeetingVoiceConfig> {
  const creds = await loadDshCredentials();
  const cordisModel = await readCordisDefaultModel();
  const cfgPath = join(getWritableDataDir(), 'meeting-voice-config.json');
  let saved: Partial<MeetingVoiceConfig> = {};
  try {
    if (existsSync(cfgPath)) saved = JSON.parse(await readFile(cfgPath, 'utf8'));
  } catch {}

  let enrolledSpeakers: string[] = [];
  try {
    const vpPath = join(homedir(), '.dsh', 'soulmirror', 'voiceprint', 'library.json');
    if (existsSync(vpPath)) {
      const vp = JSON.parse(await readFile(vpPath, 'utf8'));
      if (Array.isArray(vp?.speakers)) enrolledSpeakers = vp.speakers.map((s: any) => String(s?.name || '')).filter(Boolean);
    }
  } catch {}

  return {
    dashscopeApiKey: creds.dashscopeApiKey ? `${creds.dashscopeApiKey.slice(0, 6)}******${creds.dashscopeApiKey.slice(-4)}` : '',
    hasDashscopeKey: Boolean(creds.dashscopeApiKey),
    realtimeAsrModel: saved.realtimeAsrModel || 'paraformer-realtime-v2',
    postMeetingOfflineAsr: saved.postMeetingOfflineAsr !== false,
    voiceprintEnabled: saved.voiceprintEnabled !== false,
    voiceprintThreshold: Number(saved.voiceprintThreshold ?? 0.68),
    llmModel: `${cordisModel.provider}:${cordisModel.model}`,
    enrolledSpeakers,
  };
}

export async function saveMeetingVoiceConfig(patch: Partial<MeetingVoiceConfig>): Promise<MeetingVoiceConfig> {
  const cfgPath = join(getWritableDataDir(), 'meeting-voice-config.json');
  let cur: Record<string, any> = {};
  try {
    if (existsSync(cfgPath)) cur = JSON.parse(await readFile(cfgPath, 'utf8'));
  } catch {}
  const next = { ...cur, ...patch };
  delete next.dashscopeApiKey;
  delete next.hasDashscopeKey;
  delete next.enrolledSpeakers;
  await mkdir(getWritableDataDir(), { recursive: true });
  await writeFile(cfgPath, JSON.stringify(next, null, 2), 'utf8');

  if (patch.llmModel && patch.llmModel.includes(':')) {
    const [provider, model] = patch.llmModel.split(':', 2);
    const patchPath = getCordisPatchPath();
    if (provider && model && existsSync(patchPath)) {
      try {
        const patches = yaml.load(await readFile(patchPath, 'utf8'));
        if (Array.isArray(patches)) {
          const entry = patches.find((p: any) => p?.id === 'agent-default-model');
          if (entry) {
            entry.config = { ...(entry.config || {}), provider, model };
            await writeFile(patchPath, yaml.dump(patches, { lineWidth: 120 }), 'utf8');
          }
        }
      } catch (err) {
        console.warn('[dshBridge] 同步更新 cordis.patch.yml 失败:', err);
      }
    }
  }

  if (patch.dashscopeApiKey && !patch.dashscopeApiKey.includes('******')) {
    const credsPath = join(getDshHome(), '.credentials.yaml');
    let doc: Record<string, any> = {};
    try {
      if (existsSync(credsPath)) doc = (yaml.load(await readFile(credsPath, 'utf8')) as Record<string, any>) || {};
    } catch {}
    doc.refs = { ...(doc.refs || {}), DASHSCOPE_API_KEY: patch.dashscopeApiKey.trim() };
    await mkdir(getDshHome(), { recursive: true });
    await writeFile(credsPath, yaml.dump(doc), 'utf8');
  }
  return getMeetingVoiceConfig();
}

function matchCronMinute(cronExpr: string, now: Date): boolean {
  const parts = String(cronExpr || '').trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [min, hour] = parts;
  const mMatch = min === '*' || Number(min) === now.getMinutes();
  const hMatch = hour === '*' || Number(hour) === now.getHours();
  return mMatch && hMatch;
}

/** DSH publishes schedules to the compatibility snapshot; only the desktop dispatches them. */
export function startScheduleTriggerWatcher(onTrigger: (item: import('./scheduledMeeting').ScheduledMeeting) => void): () => void {
  let stopped = false;
  let running = false;
  const checkSchedulesNow = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const store = getMeetingLogStore();
      const schedules = await store.getProjectedSchedules(legacyScheduleFiles());
      const now = new Date();
      const minute = now.toISOString().slice(0, 16);
      for (const item of schedules) {
        if (stopped || item.detected || !item.enabled) continue;
        const target = item.runAt ? Date.parse(item.runAt) : NaN;
        const elapsed = now.getTime() - target;
        const due = item.runAt
          ? elapsed >= 0 && elapsed <= 15 * 60_000 && !item.triggeredAt
          : Boolean(item.cron && matchCronMinute(item.cron, now) && item.triggeredAt?.slice(0, 16) !== minute);
        if (!due) continue;
        await store.append('schedule', 'schedule/triggered', { id: item.id, triggeredAt: now.toISOString() }, 'yogurt');
        if (item.runAt) await store.append('schedule', 'schedule/paused', { id: item.id }, 'yogurt');
        await store.syncScheduleProjectionSnapshot(legacyScheduleFiles());
        if (!stopped) onTrigger({ ...item, platform: item.platformRaw });
      }
    } catch (err) {
      console.warn('[schedule-watcher] local schedule check failed:', err);
    } finally { running = false; }
  };
  triggerImmediateScheduleCheck = () => { void checkSchedulesNow(); };
  void checkSchedulesNow();
  const timer = setInterval(checkSchedulesNow, FALLBACK_POLL_MS);
  return () => { stopped = true; triggerImmediateScheduleCheck = null; clearInterval(timer); };
}

// =========================================================================
// 日程与生命周期服务（全部基于 MeetingLog 只追加事件流折叠）
// =========================================================================

export async function listTodaySchedules(): Promise<ProjectedSchedule[]> {
  const store = getMeetingLogStore();
  return store.getProjectedSchedules(legacyScheduleFiles());
}

export function recordDetectedSchedule(observation: Parameters<typeof saveDetectedSchedule>[2]): Promise<boolean> {
  return saveDetectedSchedule(getMeetingLogStore(), legacyScheduleFiles(), observation);
}

export async function createScheduleManual(payload: {
  title: string;
  platform?: string;
  meetingCode?: string;
  meetingUrl?: string;
  runAt?: string | null;
  cron?: string | null;
  autoRecord?: boolean;
  mode?: 'join' | 'quick';
  source?: MeetingLogSource;
  rawTextHash?: string;
}): Promise<ProjectedSchedule> {
  const store = getMeetingLogStore();
  await store.ensureLegacySchedulesImported(legacyScheduleFiles());
  const id = `sched_${randomUUID().slice(0, 8)}`;
  const type = payload.source === 'import' ? 'schedule/imported' : 'schedule/created';
  await store.append(
    'schedule',
    type,
    {
      id,
      title: String(payload.title || '').trim() || '未命名会议',
      platform: payload.platform || 'tencent',
      meetingCode: String(payload.meetingCode || '').normalize('NFKC').replace(/[\s\p{Dash_Punctuation}]+/gu, '-').trim(),
      meetingUrl: String(payload.meetingUrl || '').trim(),
      runAt: payload.runAt || null,
      cron: payload.cron || null,
      autoRecord: payload.autoRecord === true,
      mode: payload.mode === 'quick' ? 'quick' : 'join',
      ...(payload.rawTextHash ? { rawTextHash: payload.rawTextHash } : {}),
    },
    payload.source || 'user',
  );
  await store.syncScheduleProjectionSnapshot(legacyScheduleFiles());
  triggerImmediateScheduleCheck?.();
  const all = await store.getProjectedSchedules();
  return all.find((x) => x.id === id) || all[all.length - 1];
}

export async function updateScheduleItem(
  id: string,
  patch: Partial<{ title: string; platform: string; meetingCode: string; meetingUrl: string; runAt: string | null; cron: string | null; enabled: boolean; autoRecord: boolean; mode: 'join' | 'quick' }>,
): Promise<boolean> {
  const store = getMeetingLogStore();
  await store.ensureLegacySchedulesImported(legacyScheduleFiles());
  const cur = (await store.getProjectedSchedules()).find((s) => s.id === id);
  if (!cur || cur.detected) return false;

  if (patch.enabled !== undefined && patch.enabled !== cur.enabled) {
    await store.append('schedule', patch.enabled ? 'schedule/resumed' : 'schedule/paused', { id }, 'user');
  }
  const hasFieldEdit =
    patch.title !== undefined ||
    patch.platform !== undefined ||
    patch.meetingCode !== undefined ||
    patch.meetingUrl !== undefined ||
    patch.runAt !== undefined ||
    patch.cron !== undefined || typeof patch.autoRecord === 'boolean' || patch.mode === 'quick' || patch.mode === 'join';
  if (hasFieldEdit) {
    await store.append(
      'schedule',
      'schedule/edited',
      {
        id,
        ...(patch.title !== undefined ? { title: String(patch.title).trim() || '未命名会议' } : {}),
        ...(patch.platform !== undefined ? { platform: String(patch.platform) } : {}),
        ...(patch.meetingCode !== undefined ? { meetingCode: String(patch.meetingCode).normalize('NFKC').replace(/[\s\p{Dash_Punctuation}]+/gu, '-').trim() } : {}),
        ...(patch.meetingUrl !== undefined ? { meetingUrl: String(patch.meetingUrl).trim() } : {}),
        ...(patch.runAt !== undefined ? { runAt: patch.runAt } : {}),
        ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
        ...(typeof patch.autoRecord === 'boolean' ? { autoRecord: patch.autoRecord } : {}),
        ...(patch.mode === 'quick' || patch.mode === 'join' ? { mode: patch.mode } : {}),
      },
      'user',
    );
  }
  await store.syncScheduleProjectionSnapshot(legacyScheduleFiles());
  triggerImmediateScheduleCheck?.();
  return true;
}

export async function deleteScheduleItem(id: string): Promise<boolean> {
  const store = getMeetingLogStore();
  await store.ensureLegacySchedulesImported(legacyScheduleFiles());
  const cur = (await store.getProjectedSchedules()).find((s) => s.id === id);
  if (!cur) return false;
  await store.append('schedule', 'schedule/deleted', { id }, 'user');
  await store.syncScheduleProjectionSnapshot(legacyScheduleFiles());
  return true;
}

export async function updateScheduleMeetingCode(id: string, meetingCode: string): Promise<boolean> {
  return updateScheduleItem(id, { meetingCode });
}


/** 读取内置 DSH soulmirror 的实时会议状态与实时转写字幕 */
export async function getSoulmirrorLiveStatus(): Promise<any> {
  refreshSessionFromDisk();
  try {
    const res = await fetch(`${DEFAULT_BASE_URL}/api/soulmirror/status?light=1`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as any;
    return {
      ok: true,
      enabled: Boolean(data?.enabled),
      capturing: Boolean(data?.session?.capturing),
      partial: String(data?.partial || ''),
      transcript: Array.isArray(data?.transcript) ? data.transcript.slice(-20) : [],
      meeting: data?.meeting || null,
      postMeeting: data?.postMeeting || null,
      artifactsDir: data?.artifacts?.dir || '',
    };
  } catch {
    return { ok: false };
  }
}

/** 统一交由内置 DSH (soulmirror) 打开/唤醒会议客户端，避免 Electron 与 DSH 双端重复拉起导致僵尸进程冲突 */
export async function openClientWithDsh(
  platform: 'tencent' | 'chinamobile',
  trace?: JoinTrace,
): Promise<'opened' | 'unavailable' | 'failed'> {
  try {
    trace?.('检查内置 DSH');
    if (!(await ensureDshProfileRunning()).ok) {
      trace?.('内置 DSH 未就绪');
      return 'unavailable';
    }
    const appLabel = platform === 'chinamobile' ? '移动会议' : '腾讯会议';
    trace?.('交由 DSH 启动会议客户端', appLabel);
    const res = await fetch(`${DEFAULT_BASE_URL}/api/soulmirror/open`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ app: appLabel }),
      signal: AbortSignal.timeout(25_000),
      redirect: 'error',
    });
    if ([401, 403, 404, 405].includes(res.status)) return 'unavailable';
    if (!res.ok) return 'failed';
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; windows?: number; result?: string };
    const ready = data?.ok === true && (typeof data.windows !== 'number' || data.windows > 0);
    trace?.('DSH 客户端启动结果', ready ? '主窗口已就绪' : (data?.result?.slice(0, 100) || '未确认主窗口'));
    return ready ? 'opened' : 'failed';
  } catch (error) {
    trace?.('DSH 启动客户端异常', error instanceof Error && error.name === 'TimeoutError' ? '请求超时' : '请求失败');
    return 'failed';
  }
}

/** Invoke DSH's desktop meeting tool without starting its recorder. */
export async function startQuickWithDshComputerUse(platform: 'tencent' | 'chinamobile', trace?: JoinTrace): Promise<'submitted' | 'unavailable' | 'uncertain' | 'permission-denied' | { windowId: string }> {
  try {
    trace?.('检查内置 DSH');
    if (!(await ensureDshProfileRunning()).ok) { trace?.('内置 DSH 未就绪'); return 'unavailable'; }
    trace?.('发送 DSH 请求');
    const res = await fetch(`${DEFAULT_BASE_URL}/api/dsh-meeting/v1/meetings/quick`, {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ platform, confirm: true }),
      signal: AbortSignal.timeout(120_000), redirect: 'error',
    });
    trace?.('DSH HTTP 响应', `HTTP ${res.status}`);
    if ([401, 403, 404, 405].includes(res.status)) return 'unavailable';
    if (!res.ok) return 'uncertain';
    const result = await res.json();
    for (const step of Array.isArray(result?.debug) ? result.debug.slice(0, 80) : []) {
      if (typeof step?.stage === 'string' && Number.isFinite(step.at)) trace?.(step.stage, typeof step.detail === 'string' ? step.detail : undefined, step.at);
    }
    if (result?.reason === 'permission-denied') return 'permission-denied';
    if (platform === 'tencent' && result?.ok === true && typeof result.room?.windowId === 'string' && /^\d{1,20}$/.test(result.room.windowId)) {
      trace?.('DSH 已确认会中控件，正在核对客户端窗口');
      return { windowId: result.room.windowId };
    }
    trace?.('DSH 执行结果', result?.ok === true ? '已提交，等待会中确认' : 'DSH 未确认提交');
    return result?.ok === true ? 'submitted' : 'uncertain';
  } catch (error) {
    trace?.('DSH 请求异常', error instanceof Error && error.name === 'TimeoutError' ? '请求超时' : '请求失败或响应无法解析');
    return 'uncertain';
  }
}

export async function joinWithDshComputerUse(platform: 'tencent' | 'chinamobile', code: string, trace?: JoinTrace): Promise<'submitted' | 'unavailable' | 'uncertain'> {
  if (!/^\d{6,12}$/.test(code)) throw new Error('会议号格式无效');
  try {
    trace?.('检查内置 DSH');
    if (!(await ensureDshProfileRunning()).ok) { trace?.('内置 DSH 未就绪'); return 'unavailable'; }
    trace?.('发送 DSH 请求');
    const res = await fetch(`${DEFAULT_BASE_URL}/api/soulmirror/join`, {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ app: platform === 'chinamobile' ? '移动会议' : '腾讯会议', code }),
      signal: AbortSignal.timeout(35_000), redirect: 'error',
    });
    trace?.('DSH HTTP 响应', `HTTP ${res.status}`);
    if ([401, 403, 404, 405].includes(res.status)) return 'unavailable';
    if (!res.ok) return 'uncertain';
    const result = await res.json();
    if (trace && typeof result?.result === 'string') {
      for (const [pattern, detail] of [
        [/Add-Type[\s\S]*(?:UnauthorizedAccessException|访问被拒绝|access (?:is )?denied)/i, 'PowerShell 初始化失败：临时文件访问被拒绝'],
        [/入会对话框已打开|打开入会对话框（/, '已打开入会对话框'],
        [/已填会议号/, 'DSH 报告已填写会议号'],
        [/已点「加入|已回车提交/, 'DSH 报告已提交入会'],
        [/没找到会议号输入框|未找到会议号输入框/, '未找到会议号输入框'],
        [/打不开入会对话框|没能打开入会对话框/, '未能打开入会对话框'],
      ] as const) if (pattern.test(result.result)) trace('DSH 会控步骤', detail);
    }
    trace?.('DSH 执行结果', result?.ok === true ? '已提交，等待会中确认' : 'DSH 未确认提交');
    return result?.ok === true ? 'submitted' : 'uncertain';
  } catch (error) {
    trace?.('DSH 请求异常', error instanceof Error && error.name === 'TimeoutError' ? '请求超时' : '请求失败或响应无法解析');
    return 'uncertain';
  }
}

/** Soulmirror's manual capture controls are separate from scheduled join. */
export async function controlSoulmirrorAuto(action: 'record' | 'start' | 'stop' | 'off'): Promise<any> {
  await ensureDshProfileRunning();
  const res = await fetch(`${DEFAULT_BASE_URL}/api/soulmirror/auto`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok ? res.json() : { ok: false, error: `HTTP ${res.status}` };
}

export async function appendMeetingLogEvent<T extends string, D extends Record<string, unknown>>(
  stream: string,
  type: T,
  data: D,
  source: MeetingLogSource = 'yogurt',
  cause?: string,
) {
  return getMeetingLogStore().append(stream, type, data, source, cause);
}

export async function readMeetingLifecycle(meetingId: string): Promise<ProjectedMeetingLifecycle> {
  return getMeetingLogStore().getProjectedLifecycle(meetingId);
}

// =========================================================================
// 制品与知识检索门面（委托 knowledgeService）
// =========================================================================

export async function publishMeetingArtifacts(payload: MeetingArtifactPayload) {
  return publishArtifactsImpl(knowledgeDeps(), payload);
}

export async function listMeetingArtifacts() {
  return listArtifactsImpl(knowledgeDeps());
}

export async function getMeetingArtifactBundle(meetingId: string) {
  return getBundleImpl(knowledgeDeps(), meetingId);
}

export async function ingestToKnowledgeBase(payload: MeetingArtifactPayload) {
  return ingestImpl(knowledgeDeps(), payload);
}

export async function searchExternalKnowledge(question: string, limit = 6) {
  return searchExternalImpl(getDshHome(), question, limit);
}
