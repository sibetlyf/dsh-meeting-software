import { JoinDebugPanel, type ScheduleDebugLoader } from './JoinDebugPanel'
import { useEffect, useRef, useState } from 'react'
import { AnswerText } from './AnswerText'

interface TodayScheduleItem {
  detected?: true
  id: string
  title: string
  platform: string
  meetingCode: string
  displayTime: string
  isToday: boolean
  enabled: boolean
  triggeredAt?: string
  lastResult?: string
  mode?: 'join' | 'quick'
}

interface DshWindowApi {
  orchestrate: (prompt: string, sessionId?: string) => Promise<{ ok: boolean; sessionId?: string; reply: string; tools?: string[] }>
  listArtifacts: () => Promise<Array<{ meetingId: string; archiveName?: string; title: string; platform?: string; meetingCode?: string; speakers?: string[]; updatedAt?: string }>>
  getArtifact: (meetingId: string) => Promise<{
    meta: any
    notesMarkdown?: string
    summaryMarkdown?: string
    quadrants?: {
      decisions?: string[]
      todos?: Array<{ owner?: string; task: string; due?: string }>
      risks?: string[]
      questions?: string[]
    }
    transcript?: Array<{ speaker: string; startMs: number; text: string }>
  } | null>
  webUrl: () => Promise<string>
  openWeb: () => Promise<{ ok: boolean; url: string }>
  listSchedules: () => Promise<TodayScheduleItem[]>
  scheduleDebug: ScheduleDebugLoader
  joinSchedule: (id: string) => Promise<{ ok: boolean; result: string }>
  onScheduleStatus: (cb: (status: { id: string; result: string }) => void) => () => void
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools?: string[]
}

const getDshApi = (): DshWindowApi | undefined => (window as unknown as { dsh?: DshWindowApi }).dsh

export function DshControlDrawer() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'native' | 'command' | 'schedules' | 'artifacts'>('native')
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [schedules, setSchedules] = useState<TodayScheduleItem[]>([])
  const [artifacts, setArtifacts] = useState<Array<{ meetingId: string; archiveName?: string; title: string; platform?: string; meetingCode?: string; speakers?: string[] }>>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [bundle, setBundle] = useState<Awaited<ReturnType<DshWindowApi['getArtifact']>>>(null)
  const [dshWebUrl, setDshWebUrl] = useState('')
  const [debugId, setDebugId] = useState<string | null>(null)
  const [openingWeb, setOpeningWeb] = useState(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const api = getDshApi()
    if (!api) return
    void api.webUrl().then((u) => { if (u) setDshWebUrl(u) })
    void api.listSchedules().then((list) => setSchedules((list || []).filter(item => !item.detected)))
    return api.onScheduleStatus?.(status => setSchedules(items => items.map(item => item.id === status.id ? { ...item, lastResult: status.result } : item)))
  }, [open])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, loading])

  useEffect(() => {
    const api = getDshApi()
    if (!open || !api) return
    if (tab === 'artifacts') {
      void api.listArtifacts().then((list) => setArtifacts(list || []))
    } else if (tab === 'schedules') {
      void api.listSchedules().then((list) => setSchedules((list || []).filter(item => !item.detected)))
    }
  }, [open, tab])

  const handleRunCommand = async (e: React.FormEvent) => {
    e.preventDefault()
    const api = getDshApi()
    const trimmed = prompt.trim()
    if (!api || !trimmed || loading) return

    setMessages((prev) => [...prev, { id: `u_${Date.now()}`, role: 'user', text: trimmed }])
    setPrompt('')
    setLoading(true)
    try {
      const res = await api.orchestrate(trimmed, sessionId)
      if (res.sessionId) setSessionId(res.sessionId)
      setMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          role: 'assistant',
          text: res.reply || (res.ok ? '指令已执行。' : '执行失败。'),
          tools: res.tools,
        },
      ])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `e_${Date.now()}`,
          role: 'assistant',
          text: `执行出错：${err instanceof Error ? err.message : String(err)}`,
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleSelectArtifact = async (meetingId: string) => {
    setSelectedId(meetingId)
    const api = getDshApi()
    if (!api) return
    const data = await api.getArtifact(meetingId)
    setBundle(data)
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-xs font-medium text-white shadow-lg hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
      >
        <span>DSH 会议助手 · 原生对话与配置</span>
      </button>
    )
  }

  const drawerWidth = tab === 'native' ? 'w-[min(780px,calc(100vw-2rem))]' : 'w-[min(480px,calc(100vw-2rem))]'
  const drawerHeight = tab === 'native' ? 'h-[min(660px,calc(100vh-2rem))]' : 'h-[min(560px,calc(100vh-2rem))]'

  return (
    <div className={`fixed right-4 bottom-4 z-50 flex ${drawerHeight} ${drawerWidth} flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl transition-all dark:border-zinc-700 dark:bg-zinc-900`}>
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab('native')}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${tab === 'native' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:text-zinc-900'}`}
          >
            DSH 原生对话
          </button>
          <button
            type="button"
            onClick={() => setTab('command')}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${tab === 'command' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:text-zinc-900'}`}
          >
            快捷指令
          </button>
          <button
            type="button"
            onClick={() => setTab('schedules')}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${tab === 'schedules' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:text-zinc-900'}`}
          >
            今日预约 ({schedules.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('artifacts')}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${tab === 'artifacts' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:text-zinc-900'}`}
          >
            归档制品 ({artifacts.length})
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={openingWeb}
            onClick={() => {
              const api = getDshApi()
              if (!api || openingWeb) return
              setOpeningWeb(true)
              void api.openWeb().finally(() => setOpeningWeb(false))
            }}
            title={dshWebUrl}
            className="text-xs text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
          >
            {openingWeb ? '打开中...' : '浏览器打开 ↗'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-400 hover:text-zinc-700">
            收起
          </button>
        </div>
      </div>

      {tab === 'native' && (
        <div className="relative min-h-0 flex-1 bg-zinc-50 dark:bg-zinc-950">
          {dshWebUrl ? (
            <webview
              key={dshWebUrl}
              src={dshWebUrl}
              partition="persist:dsh-web"
              className="h-full w-full"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-zinc-500">
              <span>正在连接内置 DSH 原生会话服务...</span>
              <button
                type="button"
                onClick={() => {
                  const api = getDshApi()
                  if (api) void api.webUrl().then((u) => { if (u) setDshWebUrl(u) })
                }}
                className="rounded-md border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700"
              >
                刷新连接
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'command' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 text-xs text-zinc-700 dark:text-zinc-300">
            {messages.length === 0 && (
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/60">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">可直接用自然语言下达指令：</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-zinc-500">
                  <li>以后帮我每天上午九点半开站会</li>
                  <li>加入腾讯会议 889-123-456</li>
                  <li>查一下上周站会留档的待办事项</li>
                </ul>
              </div>
            )}

            {messages.map((m) => (
              <div
                key={m.id}
                className={`rounded-xl p-3 leading-relaxed ${
                  m.role === 'user'
                    ? 'ml-8 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'mr-2 border border-zinc-200 bg-zinc-50/70 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
                }`}
              >
                {m.role === 'user' ? (
                  <div className="whitespace-pre-wrap">{m.text}</div>
                ) : (
                  <div className="space-y-2">
                    {m.tools && m.tools.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {Array.from(new Set(m.tools)).map((toolName) => (
                          <span key={toolName} className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                            {toolName}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="prose prose-xs max-w-none dark:prose-invert">
                      <AnswerText md={m.text} live={false} sources={[]} onSource={() => {}} />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="mr-8 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800">
                DSH 正在思考与执行工具...
              </div>
            )}
          </div>

          <form onSubmit={handleRunCommand} className="mt-3 flex shrink-0 gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入排会、入会或问答指令..."
              className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs outline-none focus:border-zinc-900 dark:border-zinc-700"
            />
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => { setMessages([]); setSessionId(undefined) }}
                className="shrink-0 rounded-lg border border-zinc-300 px-2.5 py-2 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300"
              >
                清空
              </button>
            )}
            <button
              type="submit"
              disabled={loading}
              className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {loading ? '执行中...' : '发送'}
            </button>
          </form>
        </div>
      )}

      {tab === 'schedules' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 text-xs">
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">DSH 已预约与今日待办会议</span>
            <button
              type="button"
              onClick={() => {
                const api = getDshApi()
                if (api) void api.listSchedules().then((list) => setSchedules((list || []).filter(item => !item.detected)))
              }}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              刷新
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            {schedules.length === 0 ? (
              <p className="py-8 text-center text-zinc-400">
                今日暂无预约会议。可在「快捷指令」或「DSH 原生对话」说：“帮我预约5分钟后的腾讯会议”。
              </p>
            ) : (
              schedules.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                        {s.platform}
                      </span>
                      {s.meetingCode && (
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          {s.meetingCode}
                        </span>
                      )}
                      <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{s.title}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">
                      {s.displayTime} · {s.lastResult ?? (s.triggeredAt ? '已触发，未记录入会结果' : s.enabled ? '待触发' : '已暂停')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const api = getDshApi()
                      if (api) void api.joinSchedule(s.id)
                    }}
                    className="shrink-0 rounded-md bg-zinc-900 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {s.mode === 'quick' ? '发起会议' : '加入会议'}
                  </button>
                  <button type="button" className="workspace-button text-xs" aria-expanded={debugId === s.id}
                    onClick={() => setDebugId(debugId === s.id ? null : s.id)}>入会调试</button>
                  {debugId === s.id && <div className="w-full"><JoinDebugPanel key={s.id} id={s.id} load={getDshApi()?.scheduleDebug} /></div>}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {tab === 'artifacts' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 text-xs">
          {!selectedId ? (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {artifacts.length === 0 ? (
                <p className="py-8 text-center text-zinc-400">暂无已归档会议制品（会议结束后按“软件_会议号_主题”自动归档）</p>
              ) : (
                artifacts.map((a) => (
                  <button
                    key={a.meetingId}
                    type="button"
                    onClick={() => void handleSelectArtifact(a.meetingId)}
                    className="w-full rounded-lg border border-zinc-200 p-2.5 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
                  >
                    <div className="flex items-center gap-1.5">
                      {a.platform && (
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          {a.platform}
                        </span>
                      )}
                      {a.meetingCode && (
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                          {a.meetingCode}
                        </span>
                      )}
                      <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{a.title}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">
                      {a.archiveName ? `📁 ${a.archiveName} · ` : ''}说话人：{(a.speakers || []).join('、') || '识别中'}
                    </div>
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <button
                type="button"
                onClick={() => { setSelectedId(null); setBundle(null) }}
                className="mb-2 shrink-0 self-start text-xs text-blue-600 hover:underline"
              >
                ← 返回制品列表
              </button>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                {bundle?.quadrants && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-md bg-emerald-50 p-2 dark:bg-emerald-950/40">
                      <div className="font-semibold text-emerald-700 dark:text-emerald-300">决议项</div>
                      {(bundle.quadrants.decisions || []).map((d, i) => <div key={i} className="mt-1">• {d}</div>)}
                    </div>
                    <div className="rounded-md bg-blue-50 p-2 dark:bg-blue-950/40">
                      <div className="font-semibold text-blue-700 dark:text-blue-300">待办任务</div>
                      {(bundle.quadrants.todos || []).map((t, i) => <div key={i} className="mt-1">• [{t.owner || '待定'}] {t.task}</div>)}
                    </div>
                  </div>
                )}
                {bundle?.summaryMarkdown && (
                  <div className="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
                    <AnswerText md={bundle.summaryMarkdown} live={false} sources={[]} onSource={() => {}} />
                  </div>
                )}
                {bundle?.transcript && bundle.transcript.length > 0 && (
                  <div className="space-y-1.5 rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
                    <div className="font-semibold text-zinc-900 dark:text-zinc-100">带声纹标注逐字稿</div>
                    {bundle.transcript.map((line, i) => (
                      <div key={i}>
                        <span className="font-medium text-blue-600 dark:text-blue-400">{line.speaker}：</span>
                        <span>{line.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
