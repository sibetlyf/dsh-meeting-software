import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const supervise = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, process.argv.slice(1), { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
process.stdin.once('end', stop);
process.stdin.once('error', stop);
process.stdin.resume();
child.once('error', () => process.exit(1));
child.once('exit', code => process.exit(code ?? 1));
`;

export async function runManagedWindowsDsh({ node, cli, port, cwd, env, launchDesktop, timeoutMs = 25_000 }) {
  const dsh = spawn(node, ['-e', supervise, '--', cli, '--profile', 'meeting', '--no-open', '--port', String(port)], {
    cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  dsh.stdin.on('error', () => {});
  const stopped = new Promise(resolve => {
    dsh.once('error', error => resolve({ error }));
    dsh.once('exit', code => resolve({ code }));
  });
  const origin = `http://127.0.0.1:${Number(port)}`;
  let token;
  for (const stream of [dsh.stdout, dsh.stderr]) {
    let buffer = '';
    stream.on('data', chunk => {
      if (token) return;
      buffer = (buffer + chunk.toString('utf8')).slice(-8192);
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)(?=\s|\x1b)/.exec(buffer);
      if (match && new URL(match[0]).origin === origin) token = match[1];
    });
  }
  let desktop;
  const stopDsh = () => { dsh.stdin.end(); };
  const stop = () => { desktop?.kill(); stopDsh(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await Promise.race([stopped, delay(200, null)]);
      if (result) throw new Error(`内置 DSH 未能启动${result.error?.code ? ` (${result.error.code})` : ` (退出码 ${result.code})`}，请检查端口 ${port} 和 DSH 配置。`);
      if (!token) continue;
      const response = await fetch(`${origin}/api/dsh-meeting/v1/health`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(1000),
      }).catch(() => null);
      const health = response?.ok ? await response.json().catch(() => null) : null;
      if (health?.ok !== true || health.plugin !== 'dsh-meeting-host' || health.desktopScheduler !== true) continue;
      desktop = launchDesktop(`${origin}/?token=${token}`);
      return await new Promise((resolve, reject) => {
        desktop.once('error', reject);
        desktop.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
    }
    throw new Error(`内置 DSH 未通过就绪检查，未启动 Yogurt。请检查端口 ${port} 和 DSH 配置。`);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    stopDsh();
    await stopped;
  }
}
