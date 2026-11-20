import { JoinDebugPanel, type ScheduleDebugLoader } from '../components/JoinDebugPanel'
import { useEffect, useState } from 'react'
import { CalendarDays, ExternalLink, Pencil, Play, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'

interface ScheduleItem {
  detected?: true
  id: string
  title: string
  platform: string
  platformRaw?: string
  meetingCode: string
  meetingUrl?: string
  cron?: string | null
  runAt?: string | null
  displayTime: string
  isToday: boolean
  enabled: boolean
  autoRecord?: boolean
  mode?: 'join' | 'quick'
  triggeredAt?: string
  lastResult?: string
}

const PLATFORM_OPTIONS = [
  { value: 'tencent', label: '腾讯会议' },
  { value: 'chinamobile', label: '移动云会议' },
  { value: 'feishu', label: '飞书会议' },
  { value: 'dingtalk', label: '钉钉会议' },
  { value: 'zoom', label: 'Zoom' },
]

function toLocalDatetimeInput(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function SchedulesScreen() {
  const [items, setItems] = useState<ScheduleItem[]>([])
  const [loading, setLoading] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [joiningId, setJoiningId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')

  // 查询与筛选
  const [searchQuery, setSearchQuery] = useState('')
  const [filterScope, setFilterScope] = useState<'today' | 'all'>('all')

  // 手动新建表单
  const [showManualForm, setShowManualForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newPlatform, setNewPlatform] = useState('tencent')
  const [newCode, setNewCode] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newTime, setNewTime] = useState('')
  const [newDailyCron, setNewDailyCron] = useState('')
  const [newAutoRecord, setNewAutoRecord] = useState(false)
  const [newMode, setNewMode] = useState<'join' | 'quick'>('join')

  // 行内编辑状态
  const [debugId, setDebugId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editPlatform, setEditPlatform] = useState('tencent')
  const [editCode, setEditCode] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editTime, setEditTime] = useState('')
  const [editCron, setEditCron] = useState('')
  const [editAutoRecord, setEditAutoRecord] = useState(false)
  const [editMode, setEditMode] = useState<'join' | 'quick'>('join')

  const dshApi = (window as unknown as {
    dsh?: {
      listSchedules: () => Promise<ScheduleItem[]>
      createSchedule: (payload: unknown) => Promise<unknown>
      updateSchedule: (id: string, patch: unknown) => Promise<boolean>
      deleteSchedule: (id: string) => Promise<boolean>
      scheduleDebug: ScheduleDebugLoader
      joinSchedule: (id: string, preferLink?: boolean) => Promise<{ ok: boolean; result: string }>
      onSchedulesChanged: (cb: () => void) => () => void
      onScheduleStatus: (cb: (status: { id: string; result: string }) => void) => () => void
      orchestrate: (prompt: string) => Promise<{ ok: boolean; reply: string }>
    }
  }).dsh

  const load = async (showLoading = true) => {
    if (!dshApi) return
    if (showLoading) setLoading(true)
    try {
      const list = await dshApi.listSchedules()
      setItems(list || [])
    } catch {
      setFeedback('无法加载会议日程，请重试。')
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  useEffect(() => {
    const offChanged = dshApi?.onSchedulesChanged?.(() => { void load(false) })
    const offStatus = dshApi?.onScheduleStatus?.(status => {
      setFeedback(status.result)
      setItems(items => items.map(item => item.id === status.id ? { ...item, lastResult: status.result } : item))
    })
    void load()
    return () => { offChanged?.(); offStatus?.() }
  }, [])

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dshApi || !prompt.trim() || creating) return
    setCreating(true)
    setFeedback('')
    try {
      const res = await dshApi.orchestrate(prompt.trim())
      setFeedback(res.reply || '已创建日程')
      setPrompt('')
      await load()
    } finally {
      setCreating(false)
    }
  }

  const handleManualCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dshApi || !newTitle.trim()) return
    if (newMode === 'join' && !newCode.trim() && !newUrl.trim()) { setFeedback('请填写会议号或官方邀请链接。'); return }
    if (newMode === 'quick' && !['tencent', 'chinamobile'].includes(newPlatform)) { setFeedback('该平台不支持快速会议。'); return }
    const cron = newDailyCron.trim()
      ? (() => {
          const [hh, mm] = newDailyCron.trim().split(':')
          return hh && mm ? `${Number(mm)} ${Number(hh)} * * *` : null
        })()
      : null
    const runAt = !cron && newTime ? new Date(newTime).toISOString() : null
    await dshApi.createSchedule({
      title: newTitle.trim(),
      platform: newPlatform,
      meetingCode: newMode === 'join' ? newCode.trim() : '',
      meetingUrl: newMode === 'join' ? newUrl.trim() : '',
      mode: newMode,
      runAt,
      cron,
      autoRecord: newAutoRecord,
    })
    setNewTitle('')
    setNewCode('')
    setNewUrl('')
    setNewTime('')
    setNewDailyCron('')
    setNewAutoRecord(false)
    setNewMode('join')
    setShowManualForm(false)
    setFeedback(`已创建会议日程「${newTitle.trim()}」`)
    await load()
  }

  const startEdit = (item: ScheduleItem) => {
    setEditingId(item.id)
    setEditTitle(item.title)
    setEditPlatform(item.platformRaw || 'tencent')
    setEditCode(item.meetingCode || '')
    setEditUrl(item.meetingUrl || '')
    setEditTime(toLocalDatetimeInput(item.runAt))
    setEditCron(item.cron || '')
    setEditAutoRecord(item.autoRecord !== false)
    setEditMode(item.mode ?? 'join')
  }

  const handleSaveEdit = async (id: string) => {
    if (!dshApi) return
    if (editMode === 'join' && !editCode.trim() && !editUrl.trim()) { setFeedback('请填写会议号或官方邀请链接。'); return }
    if (editMode === 'quick' && !['tencent', 'chinamobile'].includes(editPlatform)) { setFeedback('该平台不支持快速会议。'); return }
    await dshApi.updateSchedule(id, {
      title: editTitle.trim() || '未命名会议',
      platform: editPlatform,
      meetingCode: editMode === 'join' ? editCode.trim() : '',
      meetingUrl: editMode === 'join' ? editUrl.trim() : '',
      mode: editMode,
      runAt: editCron.trim() ? null : editTime ? new Date(editTime).toISOString() : null,
      cron: editCron.trim() || null,
      autoRecord: editAutoRecord,
    })
    setEditingId(null)
    setFeedback('已更新会议日程')
    await load()
  }

  const handleToggleEnabled = async (item: ScheduleItem) => {
    if (!dshApi) return
    await dshApi.updateSchedule(item.id, { enabled: !item.enabled })
    await load()
  }

  const handleDelete = async (item: ScheduleItem) => {
    if (!dshApi) return
    await dshApi.deleteSchedule(item.id)
    setFeedback(`已删除日程「${item.title}」`)
    await load()
  }

  const handleJoin = async (item: ScheduleItem, preferLink = false) => {
    if (!dshApi || joiningId) return
    setJoiningId(item.id)
    setFeedback(!preferLink && item.meetingCode && ['tencent', 'chinamobile'].includes(item.platformRaw || item.platform)
      ? `正在通过 DSH 操作 ${item.platform} 客户端…` : `正在打开 ${item.platform}…`)
    try {
      const res = await dshApi.joinSchedule(item.id, preferLink)
      setFeedback(res.ok ? res.result : `未能发起入会：${res.result}`)
    } catch (err: any) {
      setFeedback(`入会异常：${err?.message || String(err)}`)
    } finally {
      setJoiningId(null)
    }
  }

  const filtered = items.filter((item) => {
    if (filterScope === 'today' && !item.isToday) return false
    if (!searchQuery.trim()) return true
    const q = searchQuery.trim().toLowerCase()
    return (
      item.title.toLowerCase().includes(q) ||
      item.platform.toLowerCase().includes(q) ||
      (item.meetingCode || '').toLowerCase().includes(q) ||
      (item.displayTime || '').toLowerCase().includes(q)
    )
  })

  return (
    <div data-testid="schedules-screen" className="settings-screen">
      <div className="settings-titlebar-space" />
      <div className="settings-scroll">
        <div className="settings-content">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="settings-heading">今日日程</h1>
              <p className="settings-intro">与 DSH 待办及定时任务实时联动，支持增删查改、粘贴会议邀请自动解析、到点自动入会转录。</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowManualForm((v) => !v)}
                className="workspace-button"
              >
                <Plus size={14} aria-hidden="true" />
                <span>{showManualForm ? '收起表单' : '手动新建'}</span>
              </button>
              <button type="button" onClick={() => void load()} className="workspace-button">
                <RefreshCw size={14} aria-hidden="true" />
                <span>刷新</span>
              </button>
            </div>
          </div>

          <h2 className="settings-section-heading">一句话添加预约 / 粘贴会议邀请</h2>
          <form onSubmit={handleQuickAdd} className="settings-group p-3">
            <div className="flex items-start gap-2">
              <textarea
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    void handleQuickAdd(e as unknown as React.FormEvent)
                  }
                }}
                placeholder={'支持自然语言（如“每天上午九点半开站会”）\n或直接粘贴整段腾讯会议/移动云会议邀请文本（自动提取主题、时间、会议号与链接）'}
                className="settings-input flex-1 resize-y"
              />
              <button type="submit" disabled={creating} className="workspace-button primary shrink-0">
                <Plus size={14} aria-hidden="true" />
                <span>{creating ? '解析中...' : '创建日程'}</span>
              </button>
            </div>
            {feedback && <p className="settings-description mt-2 whitespace-pre-wrap">{feedback}</p>}
          </form>

          {showManualForm && (
            <>
              <h2 className="settings-section-heading">手动新建日程</h2>
              <form onSubmit={handleManualCreate} className="settings-group p-3 space-y-2.5 text-xs">
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">会议主题 *</span>
                    <input
                      type="text"
                      required
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      placeholder="例如：项目周会"
                      className="settings-input"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">会议软件</span>
                    <select value={newPlatform} onChange={(e) => setNewPlatform(e.target.value)} className="settings-input">
                      {PLATFORM_OPTIONS.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">会议操作</span>
                    <select value={newMode} onChange={e => setNewMode(e.target.value === 'quick' ? 'quick' : 'join')} className="settings-input">
                      <option value="join">加入已有会议</option><option value="quick">发起快速会议</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">会议号</span>
                    <input
                      type="text"
                      value={newCode}
                      disabled={newMode === 'quick'}
                      onChange={(e) => setNewCode(e.target.value)}
                      placeholder="例如：977-694-801"
                      className="settings-input"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">单次会议时间</span>
                    <input
                      type="datetime-local"
                      value={newTime}
                      onChange={(e) => setNewTime(e.target.value)}
                      className="settings-input"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">或每日周期时间（HH:mm）</span>
                    <input
                      type="text"
                      value={newDailyCron}
                      onChange={(e) => setNewDailyCron(e.target.value)}
                      placeholder="例如：09:30（留空则按单次时间）"
                      className="settings-input"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">入会链接（可选）</span>
                    <input
                      type="text"
                      value={newUrl}
                      disabled={newMode === 'quick'}
                      onChange={(e) => setNewUrl(e.target.value)}
                      placeholder="https://meeting.tencent.com/..."
                      className="settings-input"
                    />
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={newAutoRecord} onChange={e => setNewAutoRecord(e.target.checked)} />
                    入会确认后自动录音
                  </label>
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setShowManualForm(false)} className="workspace-button">取消</button>
                  <button type="submit" className="workspace-button primary">保存日程</button>
                </div>
              </form>
            </>
          )}

          <div className="flex items-center justify-between mt-5 mb-2">
            <h2 className="settings-section-heading !m-0">
              会议日程列表 ({filtered.length}/{items.length})
            </h2>
            <div className="flex items-center gap-2">
              <div className="relative flex items-center">
                <Search size={13} className="absolute left-2.5 text-zinc-400 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索主题 / 会议号 / 平台"
                  className="settings-input pl-7 py-1 text-xs w-48"
                />
              </div>
              <button
                type="button"
                onClick={() => setFilterScope((s) => (s === 'all' ? 'today' : 'all'))}
                className="workspace-button text-xs"
              >
                {filterScope === 'today' ? '仅看今日' : '查看全部'}
              </button>
            </div>
          </div>

          <div className="settings-group">
            {loading ? (
              <div className="settings-row">
                <p className="settings-description">正在加载 DSH 日程...</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="settings-row">
                <div className="settings-row-copy">
                  <p className="settings-label">暂无匹配的会议日程</p>
                  <p className="settings-description">可尝试切换“查看全部”，或在上方粘贴会议邀请 / 手动新建日程。</p>
                </div>
              </div>
            ) : (
              filtered.map((item) => (
                <div key={item.id} className="settings-row flex-col !items-stretch gap-2">
                  <div className="flex items-center gap-3 w-full">
                    <span className="settings-permission-icon">
                      <CalendarDays size={17} strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <div className="settings-row-copy">
                      <p className="settings-label">
                        {item.title}
                        <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          {item.platform}
                        </span>
                        {item.meetingCode ? (
                          <span className="ml-1.5 rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-normal text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                            会议号：{item.meetingCode}
                          </span>
                        ) : !item.detected && (
                          <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-normal text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                            {item.mode === 'quick' ? '快速会议' : item.meetingUrl ? '使用邀请链接' : '缺少入会信息'}
                          </span>
                        )}
                        {item.detected && <span className="ml-2 text-xs text-zinc-500">自动检测</span>}
                        {!item.detected && !item.enabled && (
                          <span className="ml-1.5 rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] font-normal text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                            已暂停
                          </span>
                        )}
                      </p>
                      <p className="settings-description">
                        {item.displayTime} · {item.lastResult ?? (item.triggeredAt ? '已触发，未记录入会结果' : item.enabled ? '待触发' : '已暂停自动触发')}
                        {item.meetingUrl ? ` · 链接已绑定` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {!item.detected && <>
                        <button type="button" aria-expanded={debugId === item.id} className="workspace-button text-xs"
                          onClick={() => setDebugId(debugId === item.id ? null : item.id)}>
                          入会调试
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggleEnabled(item)}
                          className="workspace-button text-xs"
                          title={item.enabled ? '暂停自动触发' : '启用自动触发'}
                        >
                          {item.enabled ? '暂停' : '启用'}
                        </button>
                        <button
                          type="button"
                          onClick={() => (editingId === item.id ? setEditingId(null) : startEdit(item))}
                          className="workspace-button"
                          title="编辑日程"
                        >
                          <Pencil size={13} aria-hidden="true" />
                        </button>
                      </>}
                      <button
                        type="button"
                        onClick={() => void handleDelete(item)}
                        className="workspace-button text-red-600 dark:text-red-400"
                        title="删除日程"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                      {!item.detected && <button
                        type="button"
                        disabled={!!joiningId}
                        onClick={() => void handleJoin(item)}
                        className="workspace-button primary settings-action"
                      >
                        <Play size={13} aria-hidden="true" />
                        <span>{joiningId === item.id ? '正在打开…' : item.mode === 'quick' ? '发起会议' : '加入会议'}</span>
                      </button>}
                      {!item.detected && item.meetingUrl && item.meetingCode && (
                        <button type="button" disabled={!!joiningId} onClick={() => void handleJoin(item, true)}
                          className="workspace-button" title="打开官方邀请链接" aria-label="打开官方邀请链接">
                          <ExternalLink size={13} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>

                  {debugId === item.id && (
                    <JoinDebugPanel key={item.id} id={item.id} load={dshApi?.scheduleDebug} />
                  )}
                  {editingId === item.id && (
                    <div className="mt-1 rounded-md border border-zinc-200/80 dark:border-zinc-700/80 p-3 space-y-2 text-xs">
                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1">
                          <span className="text-zinc-500">主题</span>
                          <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="settings-input" />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-zinc-500">平台</span>
                          <select value={editPlatform} onChange={(e) => setEditPlatform(e.target.value)} className="settings-input">
                            {PLATFORM_OPTIONS.map((p) => (
                              <option key={p.value} value={p.value}>{p.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-zinc-500">会议号</span>
                          <input type="text" value={editCode} disabled={editMode === 'quick'} onChange={(e) => setEditCode(e.target.value)} placeholder="如 977-694-801" className="settings-input" />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-zinc-500">时间（单次）</span>
                          <input type="datetime-local" value={editTime} onChange={(e) => setEditTime(e.target.value)} className="settings-input" />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-zinc-500">Cron 周期表达式（可选）</span>
                          <input type="text" value={editCron} onChange={(e) => setEditCron(e.target.value)} placeholder="如 30 9 * * *" className="settings-input" />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-zinc-500">入会链接</span>
                          <input type="text" value={editUrl} disabled={editMode === 'quick'} onChange={(e) => setEditUrl(e.target.value)} className="settings-input" />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-zinc-500">会议操作</span>
                          <select value={editMode} onChange={e => setEditMode(e.target.value === 'quick' ? 'quick' : 'join')} className="settings-input">
                            <option value="join">加入已有会议</option><option value="quick">发起快速会议</option>
                          </select>
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={editAutoRecord} onChange={e => setEditAutoRecord(e.target.checked)} />
                          入会确认后自动录音
                        </label>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => setEditingId(null)} className="workspace-button">取消</button>
                        <button type="button" onClick={() => void handleSaveEdit(item.id)} className="workspace-button primary">保存修改</button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
