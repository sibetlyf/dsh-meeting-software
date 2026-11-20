import { useEffect, useState } from 'react'
import { ArrowLeft, BookOpen, RefreshCw, Search } from 'lucide-react'
import { AnswerText } from '../components/AnswerText'

interface ArtifactSummary {
  meetingId: string
  archiveName?: string
  title: string
  platform?: string
  meetingCode?: string
  speakers?: string[]
  updatedAt?: string
}

interface ArtifactBundle {
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
}

export function KnowledgeScreen({ initialId = null }: { initialId?: string | null } = {}) {
  const [items, setItems] = useState<ArtifactSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [askAnswer, setAskAnswer] = useState('')
  const [asking, setAsking] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(initialId)
  const [bundle, setBundle] = useState<ArtifactBundle | null>(null)

  const dshApi = (window as unknown as {
    dsh?: {
      listArtifacts: () => Promise<ArtifactSummary[]>
      getArtifact: (meetingId: string) => Promise<ArtifactBundle | null>
      orchestrate: (prompt: string) => Promise<{ ok: boolean; reply: string }>
    }
  }).dsh

  const load = async () => {
    if (!dshApi) return
    setLoading(true)
    try {
      const list = await dshApi.listArtifacts()
      setItems(list || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    if (initialId) {
      void openItem(initialId)
    }
  }, [initialId])

  const openItem = async (id: string) => {
    if (!dshApi) return
    setSelectedId(id)
    const data = await dshApi.getArtifact(id)
    setBundle(data)
  }

  const handleAskKnowledge = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dshApi || !query.trim() || asking) return
    setAsking(true)
    setAskAnswer('')
    try {
      const res = await dshApi.orchestrate(`请从 dsh-knowledge 知识库与历史会议制品中检索并回答：${query.trim()}`)
      setAskAnswer(res.reply || '未检索到相关记录。')
    } finally {
      setAsking(false)
    }
  }

  const filtered = items.filter((a) => {
    if (!query.trim()) return true
    const q = query.trim().toLowerCase()
    return (
      a.title.toLowerCase().includes(q) ||
      (a.platform || '').toLowerCase().includes(q) ||
      (a.meetingCode || '').toLowerCase().includes(q) ||
      (a.speakers || []).join(' ').toLowerCase().includes(q)
    )
  })

  return (
    <div data-testid="knowledge-screen" className="settings-screen">
      <div className="settings-titlebar-space" />
      <div className="settings-scroll">
        <div className="settings-content">
          {selectedId ? (
            <div>
              <button
                type="button"
                onClick={() => { setSelectedId(null); setBundle(null) }}
                className="workspace-button mb-4"
              >
                <ArrowLeft size={14} aria-hidden="true" />
                <span>返回知识库列表</span>
              </button>

              <h1 className="settings-heading">{bundle?.meta?.title || '会议归档详情'}</h1>
              <p className="settings-intro">
                {bundle?.meta?.platform || '会议'} {bundle?.meta?.meetingCode ? `· ${bundle.meta.meetingCode}` : ''}
                {bundle?.meta?.archiveName ? ` · 归档目录：${bundle.meta.archiveName}` : ''}
              </p>

              {bundle?.quadrants && (
                <>
                  <h2 className="settings-section-heading">四象限结构化决策</h2>
                  <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
                    <div className="settings-group p-3">
                      <p className="font-semibold mb-1.5">关键决议</p>
                      {(bundle.quadrants.decisions || []).length ? bundle.quadrants.decisions!.map((d, i) => <p key={i}>• {d}</p>) : <p className="text-zinc-400">无</p>}
                    </div>
                    <div className="settings-group p-3">
                      <p className="font-semibold mb-1.5">行动待办</p>
                      {(bundle.quadrants.todos || []).length ? bundle.quadrants.todos!.map((t, i) => <p key={i}>• [{t.owner || '待定'}] {t.task}</p>) : <p className="text-zinc-400">无</p>}
                    </div>
                    <div className="settings-group p-3">
                      <p className="font-semibold mb-1.5">潜在风险</p>
                      {(bundle.quadrants.risks || []).length ? bundle.quadrants.risks!.map((r, i) => <p key={i}>• {r}</p>) : <p className="text-zinc-400">无</p>}
                    </div>
                    <div className="settings-group p-3">
                      <p className="font-semibold mb-1.5">待定议题</p>
                      {(bundle.quadrants.questions || []).length ? bundle.quadrants.questions!.map((q, i) => <p key={i}>• {q}</p>) : <p className="text-zinc-400">无</p>}
                    </div>
                  </div>
                </>
              )}

              {bundle?.summaryMarkdown && (
                <>
                  <h2 className="settings-section-heading">会议纪要（含手写笔记）</h2>
                  <div className="settings-group p-4 text-sm">
                    <AnswerText md={bundle.summaryMarkdown} live={false} sources={[]} onSource={() => {}} />
                  </div>
                </>
              )}

              {bundle?.transcript && bundle.transcript.length > 0 && (
                <>
                  <h2 className="settings-section-heading">带声纹说话人逐字稿 ({bundle.transcript.length})</h2>
                  <div className="settings-group p-4 space-y-2 text-xs">
                    {bundle.transcript.map((line, i) => (
                      <div key={i}>
                        <span className="font-semibold text-blue-600 dark:text-blue-400">{line.speaker}：</span>
                        <span>{line.text}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="settings-heading">知识库</h1>
                  <p className="settings-intro">自动沉淀全部会议纪要、手写笔记与带声纹转写，与 DSH `dsh-knowledge` 实时同步。</p>
                </div>
                <button type="button" onClick={() => void load()} className="workspace-button">
                  <RefreshCw size={14} aria-hidden="true" />
                  <span>刷新</span>
                </button>
              </div>

              <h2 className="settings-section-heading">跨会议知识检索与问答</h2>
              <form onSubmit={handleAskKnowledge} className="settings-group p-3">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="输入关键词筛选，或直接向 DSH 知识库提问（如：上周站会定了什么？）"
                    className="settings-input flex-1"
                  />
                  <button type="submit" disabled={asking} className="workspace-button primary">
                    <Search size={14} aria-hidden="true" />
                    <span>{asking ? '检索中...' : '问知识库'}</span>
                  </button>
                </div>
                {askAnswer && (
                  <div className="mt-3 border-t border-zinc-200 pt-3 text-xs dark:border-zinc-800">
                    <AnswerText md={askAnswer} live={false} sources={[]} onSource={() => {}} />
                  </div>
                )}
              </form>

              <h2 className="settings-section-heading">已归档会议知识 ({filtered.length})</h2>
              <div className="settings-group">
                {loading ? (
                  <div className="settings-row">
                    <p className="settings-description">正在加载知识库制品...</p>
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="settings-row">
                    <div className="settings-row-copy">
                      <p className="settings-label">暂无匹配的会议归档</p>
                      <p className="settings-description">每次会议结束后将按“会议软件_会议号_会议主题”自动归档并写入知识库。</p>
                    </div>
                  </div>
                ) : (
                  filtered.map((a) => (
                    <div key={a.meetingId} className="settings-row">
                      <span className="settings-permission-icon">
                        <BookOpen size={17} strokeWidth={1.75} aria-hidden="true" />
                      </span>
                      <div className="settings-row-copy">
                        <p className="settings-label">
                          {a.title}
                          {a.platform && (
                            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                              {a.platform}
                            </span>
                          )}
                          {a.meetingCode && (
                            <span className="ml-1.5 rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-normal text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                              {a.meetingCode}
                            </span>
                          )}
                        </p>
                        <p className="settings-description">
                          {a.archiveName ? `${a.archiveName} · ` : ''}说话人：{(a.speakers || []).join('、') || '识别中'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void openItem(a.meetingId)}
                        className="workspace-button settings-action"
                      >
                        <span>查看详情</span>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

