import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { meetingProbeScript } from '../src/main/meetingProbe.mjs'
import { classifyMeetingWindows } from '../src/main/meetingAutowatch'

function probe(findFirst: string, findAll: string, title: string) {
  const temp = mkdtempSync(join(tmpdir(), 'yogurt-probe-test-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(temp|tmp|tmpdir)$/i.test(key)))
  Object.assign(env, { TEMP: temp, TMP: temp, TMPDIR: temp })
  const script = meetingProbeScript.replace(/\r\n/g, '\n')
    .replace('Get-Process -Name $processNames -ErrorAction SilentlyContinue', () => 'Get-Process -Id $PID')
    .replace('[YogurtMeetingNativeWindows]::Find($meetingProcesses)', "@([pscustomobject]@{ Handle = 42; ProcessName = 'wemeetapp' })")
    .replace('[Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([long]$native.Handle))', () => `([pscustomobject]@{ Current = [pscustomobject]@{ Name = '${title}'; ClassName = 'BaseDialog' } } |
      Add-Member -PassThru -MemberType ScriptMethod -Name FindFirst -Value { ${findFirst} } |
      Add-Member -PassThru -MemberType ScriptMethod -Name FindAll -Value { ${findAll} })`)
    .replace('[YogurtMeetingNativeWindows]::StillVisible([IntPtr]::new([long]$native.Handle))', () => '$true')
  try {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    })
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

const gridFound = 'if ([object]::ReferenceEquals($args[1], $script:audioGrid)) { return $true }'

describe.runIf(process.platform === 'win32')('Windows meeting probe with a simulated UI Automation provider', () => {
  it.each(['Daily sync', 'Meeting ID: 123-456-789'])('publishes confirmed in-call evidence when FindAll throws (%s)', title => {
    const result = probe(gridFound, "throw [Runtime.InteropServices.COMException]::new('UIA provider failure')", title)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    const rows = JSON.parse(result.stdout)
    expect(rows).toEqual([expect.objectContaining({ hasAudioGrid: true, MeetingCode: null })])
    expect(classifyMeetingWindows(rows, undefined, undefined, true)).toEqual([expect.objectContaining({
      evidence: 'tencent-audio-grid', meetingCode: title.startsWith('Meeting ID') ? '123-456-789' : undefined,
    })])
  }, 15_000)

  it('still returns a code from a healthy provider', () => {
    const result = probe(gridFound, "[pscustomobject]@{ Current = [pscustomobject]@{ Name = 'Meeting ID: 123-456-789' } }", 'Daily sync')
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ hasAudioGrid: true, MeetingCode: '123456789' })])
  }, 15_000)

  it('leaves the meeting state unknown and reports a readable error when core evidence fails', () => {
    const result = probe("throw 'core UIA failure'", 'return', 'Daily sync')
    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr).toContain('core UIA failure')
    expect(result.stderr).not.toContain('CLIXML')
  }, 15_000)
})
