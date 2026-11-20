import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

/** Keep Windows PowerShell's Add-Type compiler scratch files out of the inherited user Temp. */
export function embeddedDshEnvironment(env: NodeJS.ProcessEnv, writableDir: string, platform = process.platform): NodeJS.ProcessEnv {
  // The meeting profile patch also selects this preset for runtimes that do not read the variable.
  const configured = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'DSH_PERMISSION_MODE'))
  const permissionEnv = { ...configured, DSH_PERMISSION_MODE: 'danger-full-access' }
  if (platform !== 'win32') return permissionEnv
  const root = join(writableDir, 'desktop-temp')
  mkdirSync(root, { recursive: true })
  const temp = mkdtempSync(join(root, 'dsh-'))
  // Windows environment names are case-insensitive; do not pass competing Temp/Tmp keys to spawn.
  const scoped = Object.fromEntries(Object.entries(permissionEnv).filter(([key]) => !/^(temp|tmp|tmpdir)$/i.test(key)))
  return { ...scoped, TEMP: temp, TMP: temp, TMPDIR: temp }
}

// EOF on the private stdin pipe also covers an Electron crash or forced exit.
const supervise = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, process.argv.slice(1), {
  windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
});
const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
process.stdin.once('end', stop);
process.stdin.once('error', stop);
process.once('SIGTERM', stop);
process.stdin.resume();
child.once('error', err => { console.error(err.message); process.exit(1); });
child.once('exit', code => process.exit(code ?? 0));
`

export function spawnEmbeddedDsh(node: string, cli: string, port: number, env: NodeJS.ProcessEnv) {
  return spawn(node, ['-e', supervise, '--', cli, '--profile', 'meeting', '--no-open', '--port', String(port)], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
  })
}
