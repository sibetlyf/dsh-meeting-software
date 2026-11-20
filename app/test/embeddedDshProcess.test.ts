import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { embeddedDshEnvironment, spawnEmbeddedDsh } from '../src/main/dsh/embeddedProcess'

it('starts the meeting CLI and stops it when the desktop closes its pipe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yogurt-dsh-process-'))
  const cli = join(dir, 'cli.cjs')
  await writeFile(cli, 'console.log(JSON.stringify({ pid: process.pid, args: process.argv.slice(2), permission: process.env.DSH_PERMISSION_MODE })); setInterval(() => {}, 1000);')
  const env = embeddedDshEnvironment({ ...process.env, dsh_permission_mode: 'read-only' }, dir)
  const child = spawnEmbeddedDsh(process.execPath, cli, 3090, env)
  const exited = once(child, 'exit')
  try {
    const [data] = await once(child.stdout, 'data')
    const ready = JSON.parse(String(data))
    expect(ready.args).toEqual(['--profile', 'meeting', '--no-open', '--port', '3090'])
    expect(ready.permission).toBe('danger-full-access')
    child.stdin.end()
    await exited
    expect(() => process.kill(ready.pid, 0)).toThrow()
  } finally {
    child.stdin.end()
    await exited
    await rm(dir, { recursive: true, force: true })
  }
})

it.runIf(process.platform === 'win32')('allows the embedded Windows child to compile Add-Type with unusable inherited Temp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yogurt-dsh-temp-'))
  const cli = join(dir, 'cli.cjs')
  const invalidTemp = join(dir, 'not-a-directory')
  await writeFile(invalidTemp, 'file')
  const env = embeddedDshEnvironment({ ...process.env, Temp: invalidTemp, TMP: invalidTemp }, dir)
  const script = "Add-Type -TypeDefinition 'public class YogurtDshCompileProbe { public static int Value = 1; }' -ErrorAction Stop; Write-Output 'PROBE_OK'"
  await writeFile(cli, `const r = require('node:child_process').spawnSync('powershell.exe', ${JSON.stringify(['-NoProfile', '-NonInteractive', '-Command', script])}, { encoding: 'utf8' }); process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exitCode = r.status ?? 1;`)
  try {
    expect(Object.keys(env).filter(key => /^temp$/i.test(key))).toEqual(['TEMP'])
    expect(env.TEMP).not.toBe(invalidTemp)
    expect(env.TMP).toBe(env.TEMP)
    const child = spawnEmbeddedDsh(process.execPath, cli, 3090, env)
    try {
      let stdout = '', stderr = ''
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      const [code] = await once(child, 'close')
      expect(code, stderr).toBe(0)
      expect(stdout).toContain('PROBE_OK')
    } finally { child.stdin.end() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
