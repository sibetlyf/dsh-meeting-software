import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Migrate only the instance created by the old Windows launcher, never an arbitrary port owner. */
export async function retireLegacyDsh({ dshHome, dshBin, dshPort, sessionFile, runtimeDir }) {
  if (process.platform !== 'win32') return 'skipped';
  let saved;
  try { saved = JSON.parse(await readFile(sessionFile, 'utf8')); } catch { return 'skipped'; }
  const samePath = (a, b) => typeof a === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();
  if (!samePath(saved?.dshHome, dshHome) || typeof saved.authToken !== 'string' || !saved.authToken) return 'skipped';
  const headers = { Authorization: `Bearer ${saved.authToken}` };
  const get = async path => {
    const r = await fetch(`http://127.0.0.1:${Number(dshPort)}${path}`, { headers, signal: AbortSignal.timeout(1800), redirect: 'error' });
    return r.ok ? r.json() : null;
  };
  try {
    const health = await get('/api/dsh-meeting/v1/health');
    if (health?.plugin !== 'dsh-meeting-host' || !samePath(health.artifactsRoot, join(dshHome, 'artifacts', 'meetings'))) return 'skipped';
    const status = await get('/api/soulmirror/health').catch(() => null);
    if (status?.capture?.capturing !== false) return 'busy';
    const quote = s => `'${s.replaceAll("'", "''")}'`;
    const script = `
$owner = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ${Number(dshPort)} -State Listen -ErrorAction SilentlyContinue)
if ($owner.Count -ne 1 -or $owner[0].OwningProcess -le 4) { exit 2 }
$child = Get-CimInstance Win32_Process -Filter "ProcessId=$($owner[0].OwningProcess)"
if ($child.Name -ne 'node.exe' -or !$child.CommandLine -or $child.CommandLine.IndexOf(${quote(`"${dshBin}" meeting --no-open --port ${Number(dshPort)}`)}, [StringComparison]::OrdinalIgnoreCase) -lt 0) { exit 2 }
$launcher = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ParentProcessId)"
if ($launcher.Name -ne 'cmd.exe' -or !$launcher.CommandLine -or $launcher.CreationDate -gt $child.CreationDate) { exit 2 }
if ($launcher.CommandLine.IndexOf(${quote(`set DSH_HOME=${dshHome}&`)}, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $launcher.CommandLine.IndexOf(${quote(join(runtimeDir, 'dsh-boot.log'))}, [StringComparison]::OrdinalIgnoreCase) -lt 0) { exit 2 }
$process = Get-Process -Id $child.ProcessId -ErrorAction Stop
if ([Math]::Abs(($process.StartTime - $child.CreationDate).TotalSeconds) -gt 1) { exit 2 }
Stop-Process -InputObject $process -ErrorAction Stop
`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 4500, windowsHide: true, stdio: 'ignore' });
    return 'retired';
  } catch { return 'skipped'; }
}
