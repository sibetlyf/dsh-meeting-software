import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

it.runIf(process.platform === 'win32')('normalizes launcher Temp before any child starts and compiles with unusable inherited Temp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yogurt-launch-temp-'))
  const blocked = join(dir, 'blocked')
  await writeFile(blocked, 'file')
  try {
    const env: Record<string, string | undefined> = { ...process.env, Temp: blocked, TMP: blocked, TmpDir: blocked }
    const source = readFileSync(new URL('../../scripts/launch.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const start = source.indexOf("if (process.platform === 'win32') {\n  mkdirSync(desktopTempDir")
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('\n}', start) + 2
    runInNewContext(source.slice(start, end), {
      process: { platform: 'win32', env }, mkdirSync, desktopTempDir: join(dir, 'temp'),
    })
    expect(Object.keys(env).filter(key => /^temp$/i.test(key))).toEqual(['TEMP'])
    expect(env.TMP).toBe(env.TEMP)
    const script = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'public class YogurtLauncherTempTest { public static int Value = 7; }'; [YogurtLauncherTempTest]::Value"
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('7')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

