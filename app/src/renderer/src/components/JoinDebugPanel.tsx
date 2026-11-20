import { useEffect, useState } from 'react'

type DebugRow = { stage: string; detail?: string; at: number }
export type ScheduleDebugLoader = (id: string) => Promise<DebugRow[]>

export function JoinDebugPanel({ id, load }: { id: string; load?: ScheduleDebugLoader }) {
  const [rows, setRows] = useState<DebugRow[]>([])
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (!load) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const next = await load(id)
        if (!cancelled) {
          setRows(next)
          setUnavailable(false)
        }
      } catch {
        if (!cancelled) setUnavailable(true)
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 700)
      }
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [id, load])

  return <div role="region" aria-label="入会调试" className="mt-2 max-h-72 overflow-auto rounded-md border border-zinc-200 p-3 text-xs dark:border-zinc-700">
    {(!load || unavailable) && <p className="settings-description">暂时无法读取调试记录。</p>}
    {load && !unavailable && rows.length === 0 && <p className="settings-description">此日程还没有当前运行期间的调试记录。</p>}
    {rows.length > 0 && <ol className="space-y-2">
      {[...rows].sort((a, b) => a.at - b.at).map((row, index) => <li key={index} className="flex items-start gap-3">
        <time className="shrink-0 tabular-nums text-zinc-500">{new Date(row.at).toLocaleTimeString()}</time>
        <div className="min-w-0 break-words">
          <span className="font-medium">{row.stage}</span>
          {row.detail && <p className="settings-description">{row.detail}</p>}
        </div>
      </li>)}
    </ol>}
  </div>
}
