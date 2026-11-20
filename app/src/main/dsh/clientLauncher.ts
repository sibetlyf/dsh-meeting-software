/**
 * 会议客户端拉起与自动快速会议模块 (clientLauncher.ts)
 *
 * 职责：解析系统会议客户端协议安装路径，拉起腾讯会议 / 移动云会议，
 * 在无会议号时优先通过 Windows UIA 点击「快速会议」，必要时交由 DSH computer-use 兜底。
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MeetingClientHandoff, type JoinTrace } from './scheduledMeeting';

const UIA_WINDOW_READY_DELAY_MS = 1800;

type JoinPoint = { x: number; y: number };
export async function readTencentJoinPoint(files: string[]): Promise<JoinPoint | undefined> {
  for (const file of files) {
    try {
      const p = JSON.parse(await readFile(file, 'utf8'))?.['腾讯会议']?.join;
      if ([p?.x, p?.y].every(n => typeof n === 'number' && n > 0 && n < 1)) return { x: p.x, y: p.y };
    } catch { /* An uncalibrated client can still use a visible Join control. */ }
  }
  return undefined;
}

/** Only the client's confirmed Join dialog can receive or submit a number. */
export async function fillTencentJoin(code: string, point?: JoinPoint, probeOnly = false): Promise<boolean> {
  if (process.platform !== 'win32' || !/^\d{9,12}$/.test(code)) return false;
  const calibration = point && [point.x, point.y].every(n => n > 0 && n < 1) ? point : undefined;
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JoinNative {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint data,UIntPtr extra);
}
'@
$null = [JoinNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
$root = [Windows.Automation.AutomationElement]::RootElement
$all = [Windows.Automation.Condition]::TrueCondition
function Get-ClientWindows {
  $ids = @((Get-Process -Name wemeetapp -ErrorAction SilentlyContinue).Id)
  foreach ($w in $root.FindAll([Windows.Automation.TreeScope]::Children, $all)) {
    if ($ids -contains $w.Current.ProcessId) { $w }
  }
}
function Invoke-Button($element) {
  $invoke = $null
  if ($element.Current.IsEnabled -and $element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
    $invoke.Invoke(); return $true
  }
  return $false
}
$homeClicked = $false
for ($i = 0; $i -lt 20; $i++) {
  $wins = @(Get-ClientWindows)
  $joinDialog = @($wins | Where-Object { $_.Current.ClassName -match 'JoinMeetingDialog' -or $_.Current.Name -ceq '加入会议' }) | Select-Object -First 1
  if ($joinDialog) { break }
  if (!$homeClicked) {
    $homeWindow = $wins | Where-Object { $_.Current.Name -ceq '腾讯会议' -and $_.Current.ClassName -eq 'BaseDialog' } | Select-Object -First 1
    if ($homeWindow) {
      foreach ($e in $homeWindow.FindAll([Windows.Automation.TreeScope]::Descendants, $all)) {
        if ($e.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $e.Current.Name -match '^(加入会议|Join Meeting)$' -and (Invoke-Button $e)) { $homeClicked = $true; break }
      }
      ${calibration ? `if (!$homeClicked) {
        $h = [IntPtr]$homeWindow.Current.NativeWindowHandle
        $null = [JoinNative]::ShowWindowAsync($h, 9)
        $null = [JoinNative]::SetForegroundWindow($h)
        Start-Sleep -Milliseconds 180
        $rect = New-Object JoinNative+Rect
        if ([JoinNative]::GetClientRect($h, [ref]$rect) -and $rect.R -gt 0 -and $rect.B -gt 0) {
          $pt = New-Object JoinNative+Point
          $pt.X = [int]($rect.R * ${calibration.x}); $pt.Y = [int]($rect.B * ${calibration.y})
          if ([JoinNative]::ClientToScreen($h, [ref]$pt) -and [JoinNative]::GetAncestor([JoinNative]::WindowFromPoint($pt), 2) -eq $h -and [JoinNative]::SetCursorPos($pt.X, $pt.Y)) {
            [JoinNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [JoinNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
            $homeClicked = $true
          } else { exit 2 }
        }
      }` : ''}
    }
  }
  Start-Sleep -Milliseconds 200
}
if (!$joinDialog) { exit 2 }
$controls = $joinDialog.FindAll([Windows.Automation.TreeScope]::Descendants, $all)
foreach ($e in $controls) {
  if ($e.Current.ControlType -ne [Windows.Automation.ControlType]::Edit -or (($e.Current.Name + ' ' + $e.Current.AutomationId) -notmatch '会议号|meeting[_ ]?code|meeting[_ ]?id')) { continue }
  $value = $null
  if ($e.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$value) -and !$value.Current.IsReadOnly) {
    $value.SetValue('${code}')
    if (($value.Current.Value -replace '[^0-9]', '') -ne '${code}') { exit 3 }
    ${probeOnly ? "Write-Output 'JOIN_NUMBER_VERIFIED'; exit 0" : ''}
    foreach ($button in $joinDialog.FindAll([Windows.Automation.TreeScope]::Descendants, $all)) {
      if ($button.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and ($button.Current.Name -match '^(加入会议|加入|Join Meeting|Join)$' -or $button.Current.AutomationId -match 'join_meeting_btn$') -and (Invoke-Button $button)) {
        Write-Output 'JOIN_NUMBER_VERIFIED'; exit 0
      }
    }
    exit 4
  }
}
exit 3`;
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 9500, windowsHide: true });
    return stdout.trim() === 'JOIN_NUMBER_VERIFIED';
  } catch (err) {
    if (probeOnly) console.warn('[launcher] join probe did not verify a number', (err as { code?: number; stderr?: string }).code, (err as { stderr?: string }).stderr?.slice(0, 400));
    return false;
  }
}

function resolveTencentExe(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKEY_CLASSES_ROOT\\wemeet\\shell\\open\\command', '/ve'],
      { encoding: 'utf8', timeout: 2000, windowsHide: true },
    );
    const command = out.match(/^\s*\S+\s+REG_SZ\s+(.+)$/mi)?.[1];
    const match = command?.match(/^"([^"]+\.exe)"/i) || command?.match(/^([A-Za-z]:\\[^\r\n"]+?\.exe)(?:\s|$)/i);
    if (match?.[1] && win32.isAbsolute(match[1]) && /^wemeetapp.exe$/i.test(win32.basename(match[1])) && existsSync(match[1])) return match[1];
  } catch { /* Fall back to the registered home URI. */ }
  return null;
}

export async function autoStartQuickMeeting(
  platform: 'tencent' | 'chinamobile',
): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const processes = platform === 'chinamobile' ? "'cloudmeeting','cloudvideo','ydmeeting'" : "'wemeetapp'";

  await new Promise((r) => setTimeout(r, UIA_WINDOW_READY_DELAY_MS));

  const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$procs = Get-Process -Name ${processes} -ErrorAction SilentlyContinue
if (-not $procs) { exit 2 }
foreach ($p in $procs) {
  if ($p.MainWindowHandle -eq 0) { continue }
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
  if (-not $win) { continue }
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $buttons = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  foreach ($b in $buttons) {
    $name = $b.Current.Name
    if ($b.Current.IsEnabled -and !$b.Current.IsOffscreen -and $name -match "^(快速会议|发起会议|Quick Meeting|Start Meeting|开始会议)$") {
      try {
        $pat = $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pat.Invoke()
        Write-Output 'QUICK_SUBMITTED'
        exit 0
      } catch {}
    }
  }
}
exit 1
`;
  try {
    const { stdout: out } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(psScript, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return out.trim() === 'QUICK_SUBMITTED';
  } catch { return false; }
}

type TencentClientState = { windows: number; clients: number; crashHandlers: number };

export async function scanTencentClient(): Promise<TencentClientState | undefined> {
  const script = "$session = (Get-Process -Id $PID).SessionId\n" +
    "$clients = @(Get-Process -Name wemeetapp -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)\n" +
    "$crash = @(Get-Process -Name WeMeetCrashHandler -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)\n" +
    "@{ clients = $clients.Count; windows = @($clients | Where-Object { $_.MainWindowHandle -ne 0 }).Count; crashHandlers = $crash.Count } | ConvertTo-Json -Compress";
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 2500, windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch { return undefined; }
}

export async function openTencentQuickClient(deps: {
  openPath(path: string): Promise<string>;
  openExternal(uri: string): Promise<void>;
  scan?: typeof scanTencentClient;
  resolveExe?: () => string | null;
  wait?: () => Promise<unknown>;
}, trace?: JoinTrace): Promise<void> {
  const scan = deps.scan ?? scanTencentClient;
  const before = await scan();
  trace?.('启动前检查腾讯会议', before ? '客户端 ' + before.clients + '，主窗口 ' + before.windows + '，崩溃处理进程 ' + before.crashHandlers : '进程检查不可用');
  if (before?.windows) { trace?.('复用现有腾讯会议主窗口'); return; }
  const exe = (deps.resolveExe ?? resolveTencentExe)();
  trace?.('交由 Windows Shell 启动', exe ? '已找到注册的客户端程序' : '使用腾讯会议主页协议');
  if (!exe || await deps.openPath(exe)) {
    if (exe) trace?.('程序启动请求失败，改用主页协议');
    await deps.openExternal('wemeet://page/home');
  }
  let state: TencentClientState | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    state = await scan();
    if (state?.windows) { trace?.('腾讯会议主窗口已就绪'); return; }
    if (attempt < 5) await (deps.wait ?? (() => delay(1000)))();
  }
  const possibleResidue = Boolean(state && (state.clients || state.crashHandlers));
  trace?.('客户端未就绪', possibleResidue ? '仍有客户端或崩溃处理进程，但没有主窗口；未结束任何进程' : '未确认主窗口出现');
  throw new MeetingClientHandoff(possibleResidue
    ? '腾讯会议进程存在，但主窗口未就绪。请检查客户端，必要时从托盘正常退出后重试。'
    : '未确认腾讯会议主窗口已打开，请检查客户端后重试。');
}

