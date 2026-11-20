import { startMeetingProbe } from './meeting-probe.mjs';
/** Windows: launch and supervise both DSH and Electron from the shell. */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { retireLegacyDsh } from './legacy-dsh.mjs';
import { parseExternalDshEndpoint } from '../app/src/main/dsh/externalEndpoint.mjs';
import { runManagedWindowsDsh } from './managed-windows-dsh.mjs';

const root = resolve('.');
const appDir = join(root, 'app');
const entryFile = join(appDir, 'out', 'main', 'index.js');
const dshPort = process.env.DSH_MEETING_PORT || '3090';
if (!/^\d{1,5}$/.test(dshPort) || Number(dshPort) < 1 || Number(dshPort) > 65535) throw new Error('Invalid DSH_MEETING_PORT');
const dshBin = process.env.DSH_BIN || 'E:\\NodeJS\\node_global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';

const dshHome = join(root, '.dsh-home');
const runtimeDir = join(root, '.dsh-runtime');
const userDataDir = join(runtimeDir, 'userdata');
const crashDumpsDir = join(runtimeDir, 'crashdumps');
const desktopTempDir = join(runtimeDir, 'desktop-temp');
const sessionFile = join(runtimeDir, 'dsh-web-session.json');
mkdirSync(dshHome, { recursive: true });
mkdirSync(userDataDir, { recursive: true });
mkdirSync(crashDumpsDir, { recursive: true });
if (process.platform === 'win32') {
  mkdirSync(desktopTempDir, { recursive: true });
  // Normalize case before creating any DSH, Electron, PowerShell, or recorder child.
  for (const key of Object.keys(process.env)) {
    if (/^(temp|tmp|tmpdir)$/i.test(key)) delete process.env[key];
  }
  Object.assign(process.env, { TEMP: desktopTempDir, TMP: desktopTempDir, TMPDIR: desktopTempDir });
}

// 同步用户凭证到项目内置 .dsh-home（若尚未存在或已更新）
const userCreds = join(homedir(), '.dsh', '.credentials.yaml');
const embeddedCreds = join(dshHome, '.credentials.yaml');
if (existsSync(userCreds) && !existsSync(embeddedCreds)) {
  try {
    copyFileSync(userCreds, embeddedCreds);
  } catch {}
}

const candidates = [
  join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  'G:\\dsh-test\\dsh-electron\\node_modules\\electron\\dist\\electron.exe',
];

const electronExe = candidates.find((p) => existsSync(p));
if (!electronExe) {
  console.error('[launch] 未找到 electron.exe');
  process.exit(1);
}
if (!existsSync(entryFile)) throw new Error('Desktop build not found; run pnpm build first');

if (process.argv.includes('--without-dsh') || process.env.YOGURT_WITHOUT_DSH === '1') {
  const env = { ...process.env, YOGURT_USER_DATA: userDataDir, YOGURT_WITHOUT_DSH: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHROME_CRASHPAD_PIPE_NAME;
  delete env.YOGURT_DSH_EXTERNAL_URL;
  delete env.YOGURT_DSH_MANAGED_URL;
  const flags = process.platform === 'win32' ? ['--no-sandbox', `--crash-dumps-dir=${crashDumpsDir}`, `--user-data-dir=${userDataDir}`] : [];
  const args = [...flags, entryFile, ...process.argv.slice(2).filter(arg => arg !== '--without-dsh')];
  const launch = file => spawn(electronExe, args, { cwd: appDir, env: { ...env, ...(file ? { YOGURT_MEETING_PROBE_FILE: file } : {}) }, stdio: 'ignore' });
  console.log('[launch] Yogurt (without DSH)');
  process.exitCode = await new Promise((resolve, reject) => {
    const child = process.platform === 'win32' ? startMeetingProbe(userDataDir, launch) : launch();
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

if (process.env.YOGURT_DSH_EXTERNAL_URL) {
  const endpoint = parseExternalDshEndpoint(process.env.YOGURT_DSH_EXTERNAL_URL);
  const response = await fetch(`${endpoint.baseUrl}/api/dsh-meeting/v1/health`, {
    headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(3000), redirect: 'error',
  }).catch(() => null);
  const health = response?.ok ? await response.json().catch(() => null) : null;
  if (health?.ok !== true || health.plugin !== 'dsh-meeting-host' || health.desktopScheduler !== true) {
    throw new Error('无法连接外部 DSH：请核对 meeting Profile 的启动地址，并使用 DSH_MEETING_DESKTOP_SCHEDULER=1 启动。');
  }
  const env = { ...process.env, DSH_HOME: dshHome, YOGURT_USER_DATA: userDataDir, DSH_EMBEDDED_MANAGED: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHROME_CRASHPAD_PIPE_NAME;
  const flags = process.platform === 'win32' ? ['--no-sandbox', `--crash-dumps-dir=${crashDumpsDir}`, `--user-data-dir=${userDataDir}`] : [];
  const child = spawn(electronExe, [...flags, entryFile, ...process.argv.slice(2)], { cwd: appDir, env, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  console.log(`[launch] Yogurt 使用外部 DSH：${endpoint.baseUrl}（PID=${child.pid}）`);
  process.exit(0);
}

const legacy = await retireLegacyDsh({ dshHome, dshBin, dshPort, sessionFile, runtimeDir });
if (legacy === 'retired') console.log('[launch] 已迁移本项目旧 DSH，现由 Yogurt 管理');
if (legacy === 'busy') console.warn('[launch] 旧 DSH 正在录音或无法确认已停止；保留原进程，新版暂不接管该端口');

const extraArgs = process.argv.slice(2);

if (process.platform === 'win32') {
  if (!existsSync(dshBin)) throw new Error('未找到内置 DSH 的 CLI，请检查 DSH_BIN。');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(electron_run_as_node|chrome_crashpad_pipe_name|dsh_permission_mode|dsh_home|dsh_meeting_desktop_scheduler|yogurt_dsh_managed_url)$/i.test(key)));
  Object.assign(env, { DSH_HOME: dshHome, DSH_PERMISSION_MODE: 'danger-full-access', DSH_MEETING_DESKTOP_SCHEDULER: '1' });
  console.log(`[launch] 正在启动项目内置 DSH（端口 ${dshPort}）`);
  process.exitCode = await runManagedWindowsDsh({
    node: process.env.NODE_BIN || process.execPath, cli: dshBin, port: dshPort, cwd: appDir, env,
    launchDesktop: url => {
      console.log('[launch] 内置 DSH 已就绪，启动 Yogurt');
      const desktopEnv = { ...env, YOGURT_USER_DATA: userDataDir, DSH_MEETING_PORT: dshPort, DSH_EMBEDDED_MANAGED: '1', YOGURT_DSH_MANAGED_URL: url };
      return startMeetingProbe(userDataDir, file => spawn(electronExe, ['--no-sandbox', `--crash-dumps-dir=${crashDumpsDir}`, `--user-data-dir=${userDataDir}`, entryFile, ...extraArgs], { cwd: appDir, env: { ...desktopEnv, YOGURT_MEETING_PROBE_FILE: file }, stdio: 'ignore' }));
    },
  });
} else {
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_EMBEDDED_MANAGED: '1',
    DSH_BIN: dshBin,
    YOGURT_USER_DATA: userDataDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHROME_CRASHPAD_PIPE_NAME;
  const child = spawn(electronExe, [entryFile, ...extraArgs], {
    cwd: appDir,
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
