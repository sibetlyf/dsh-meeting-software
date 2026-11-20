export const meetingProbeScript = String.raw`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap {
  # EncodedCommand otherwise emits a CLIXML error record instead of readable stderr.
  [Console]::Error.WriteLine(($_.Exception.Message -replace '[\r\n]+', ' '))
  exit 1
}
# Take one process snapshot. Process.GetProcessById for every desktop window can exceed the probe deadline.
$processNames = @('wemeetapp', 'wemeet', 'tencentmeeting', 'cloudmeeting', 'cloudvideo', 'ydmeeting', 'dingtalk', 'feishu', 'lark', 'zoom', 'teams', 'ms-teams')
$meetingProcesses = [Collections.Generic.Dictionary[uint32,string]]::new()
Get-Process -Name $processNames -ErrorAction SilentlyContinue | ForEach-Object {
  $meetingProcesses[[uint32]$_.Id] = $_.ProcessName
}
if ($meetingProcesses.Count -eq 0) { '[]'; return }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$nativeSource = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class YogurtMeetingNativeWindows {
  public sealed class Item { public long Handle; public int ProcessId; public string ProcessName = ""; public string Title = ""; public string ClassName = ""; }
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  public static bool StillVisible(IntPtr hWnd) { return IsWindowVisible(hWnd); }
  public static Item[] Find(Dictionary<uint, string> meetingProcesses) {
    var items = new List<Item>();
    EnumWindows((hWnd, lParam) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      string name;
      if (!meetingProcesses.TryGetValue(pid, out name) || !IsWindowVisible(hWnd)) return true;
      var title = new StringBuilder(512); var className = new StringBuilder(256);
      GetWindowText(hWnd, title, title.Capacity); GetClassName(hWnd, className, className.Capacity);
      if (title.Length > 0 || className.Length > 0)
        items.Add(new Item { Handle = hWnd.ToInt64(), ProcessId = (int)pid, ProcessName = name, Title = title.ToString(), ClassName = className.ToString() });
      return true;
    }, IntPtr.Zero);
    return items.ToArray();
  }
}
"@
Add-Type -TypeDefinition $nativeSource
$leaveNames = @(
  (([char[]](0x79bb,0x5f00,0x4f1a,0x8bae)) -join ''),
  (([char[]](0x7ed3,0x675f,0x4f1a,0x8bae)) -join ''),
  'Leave meeting', 'End meeting'
)
$leaveConditions = [Windows.Automation.Condition[]]@($leaveNames | ForEach-Object {
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $_, [Windows.Automation.PropertyConditionFlags]::IgnoreCase)
})
$leave = [Windows.Automation.OrCondition]::new($leaveConditions)
$audioGridConditions = [Windows.Automation.Condition[]]@(
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'AudioGridWidget', [Windows.Automation.PropertyConditionFlags]::IgnoreCase),
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ClassNameProperty, 'AudioGridWidget', [Windows.Automation.PropertyConditionFlags]::IgnoreCase),
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, 'AudioGridWidget', [Windows.Automation.PropertyConditionFlags]::IgnoreCase)
)
$audioGrid = [Windows.Automation.OrCondition]::new($audioGridConditions)
$codeLabel = 'Meeting\s*(?:ID|Code|Number)|Conference\s*ID|' + (([char[]](0x4f1a,0x8bae,0x53f7)) -join '')
$number = '[0-9](?:[ \t-]*[0-9]){8,11}'
function Read-Code([string]$text, [bool]$codeField = $false) {
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  $text = $text.Normalize([Text.NormalizationForm]::FormKC).Trim()
  $pattern = '(?i)^(?:' + $codeLabel + ')[ \t:#]*(' + $number + ')$'
  if ($text -match $pattern) { return ($Matches[1] -replace '[^0-9]', '') }
  if ($codeField -and $text -match ('^' + $number + '$')) { return ($text -replace '[^0-9]', '') }
}
function Read-WindowMeetingCode($element) {
  # The provider can reject FindAll or a property read even after in-call evidence was found.
  # A missing code must not invalidate that evidence or stop an existing recording.
  try {
    $codes = [Collections.Generic.HashSet[string]]::new()
    $children = $element.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
      try {
        $value = $child.Current
        if ($value.IsOffscreen) { continue }
        $codeField = $value.AutomationId -match '(?:^|\.)(?:meeting[_-]?(?:id|code|number)(?:[_-]?(?:value|label))?)$'
        $code = Read-Code $value.Name $codeField
        if (!$code -and $codeField) {
          $valuePattern = $null
          if ($child.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
            $code = Read-Code $valuePattern.Current.Value $true
          }
        }
        if ($code) { $null = $codes.Add($code) }
      } catch [Windows.Automation.ElementNotAvailableException] {}
    }
    if ($codes.Count -eq 1) { return @($codes)[0] }
  } catch {
    return $null
  }
}
$rows = @(foreach ($native in [YogurtMeetingNativeWindows]::Find($meetingProcesses)) {
  try {
    $element = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([long]$native.Handle))
    $current = $element.Current
    $hasAudioGrid = $null -ne $element.FindFirst([Windows.Automation.TreeScope]::Descendants, $audioGrid)
    $button = $element.FindFirst([Windows.Automation.TreeScope]::Descendants, $leave)
    $hasInCallControl = $null -ne $button -and $button.Current.IsEnabled -and !$button.Current.IsOffscreen -and $button.Current.ControlType -eq [Windows.Automation.ControlType]::Button
    $meetingCode = if ($hasAudioGrid -or $hasInCallControl) { Read-WindowMeetingCode $element }
    [pscustomobject]@{
      ProcessName = $native.ProcessName
      MainWindowTitle = if ($current.Name) { $current.Name } else { $native.Title }
      windowId = $native.Handle.ToString()
      windowClass = if ($current.ClassName) { $current.ClassName } else { $native.ClassName }
      hasInCallControl = $hasInCallControl
      hasAudioGrid = $hasAudioGrid
      MeetingCode = $meetingCode
    }
  } catch {
    # A failed accessibility read is an unknown scan, not evidence that a meeting ended.
    if ([YogurtMeetingNativeWindows]::StillVisible([IntPtr]::new([long]$native.Handle))) { throw }
  }
})
ConvertTo-Json -InputObject $rows -Compress`
