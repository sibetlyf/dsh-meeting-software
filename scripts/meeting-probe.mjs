import { execFile } from 'node:child_process'
import { rename, rm, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { meetingProbeScript } from '../app/src/main/meetingProbe.mjs'

/** Run the read-only window probe from the desktop launcher and publish fresh samples while Yogurt is open. */
export function startMeetingProbe(userData, launch) {
  const dir = join(userData, 'meeting-scan-temp')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${randomUUID()}.json`)
  const child = launch(file)
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(meetingProbeScript, 'utf16le').toString('base64')]
  const probeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(temp|tmp|tmpdir)$/i.test(key)))
  Object.assign(probeEnv, { TEMP: dir, TMP: dir, TMPDIR: dir })
  const timeoutMs = 15_000
  let lastFailure = ''
  let probe, timer, stopped = false, pending
  function scan() {
    probe = execFile('powershell.exe', args, {
      timeout: timeoutMs, windowsHide: true, env: probeEnv,
    }, (error, stdout, stderr) => {
      if (stopped) return
      if (error) {
        const failure = error.killed && error.signal === 'SIGTERM'
          ? `Local Windows meeting probe timed out after ${timeoutMs / 1000}s; meeting state unknown, retrying`
          : stderr.trim().slice(0, 500) || `PowerShell probe failed (${error.code ?? error.signal ?? 'unknown'})`
        if (failure !== lastFailure) console.warn(`[meeting-probe] ${failure}`)
        lastFailure = failure
      } else lastFailure = ''
      pending = (async () => {
        const rows = error ? null : JSON.parse(stdout)
        await writeFile(`${file}.tmp`, JSON.stringify({ at: Date.now(), rows }))
        await rename(`${file}.tmp`, file)
      })().catch(() => {}).finally(() => {
        if (!stopped) timer = setTimeout(scan, 1000)
      })
    })
  }
  async function cleanup() {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    probe?.kill()
    await pending
    await Promise.all([file, `${file}.tmp`].map(path => rm(path, { force: true }).catch(() => {})))
  }
  child.once('spawn', scan)
  child.meetingProbeDone = new Promise(resolve => {
    const finish = () => { void cleanup().finally(resolve) }
    child.once('error', finish)
    child.once('exit', finish)
  })
  return child
}
