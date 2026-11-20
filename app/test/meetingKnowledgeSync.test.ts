import { afterEach, expect, it, vi } from 'vitest'
import { ingestToKnowledgeBase } from '../src/main/dsh/knowledgeService'

const deps = {
  baseUrl: 'http://127.0.0.1:3090',
  dshHome: () => { throw new Error('Knowledge sync must not use the knowledge directory') },
  artifactsRoot: () => { throw new Error('Knowledge sync must not write an artifact') },
  authHeaders: (extra?: Record<string, string>) => ({ ...extra, Authorization: 'Bearer test' }),
  hasAuth: () => true,
}
const artifact = { meetingId: 'test-meeting', title: 'Standup', summaryMarkdown: 'The team agreed to ship.' }

afterEach(() => vi.unstubAllGlobals())

it('sends the Yogurt summary through the meeting plugin and requires a knowledge receipt', async () => {
  const request = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true, docId: 'doc-123' }))
  vi.stubGlobal('fetch', request)
  expect(await ingestToKnowledgeBase(deps, artifact)).toMatchObject({ ok: true, contentHash: expect.any(String) })
  const [[url, init]] = request.mock.calls
  expect(url).toBe('http://127.0.0.1:3090/api/dsh-meeting/v1/knowledge/ingest')
  expect(JSON.parse(String(init.body))).toMatchObject({ title: artifact.title, body: expect.stringContaining(artifact.summaryMarkdown) })
})

it.each([200, 503])('does not report a successful write without a document ID (HTTP %s)', async status => {
  vi.stubGlobal('fetch', async () => Response.json({ ok: status === 200 }, { status }))
  expect(await ingestToKnowledgeBase(deps, artifact)).toMatchObject({ ok: false })
})
it('replaces a damaged historical title before sending a knowledge record and its headings', async () => {
  const title = `Tencent Meeting · ${'\uFFFD'.repeat(4)}`
  const request = vi.fn(async () => Response.json({ ok: true, docId: 'repaired' }))
  vi.stubGlobal('fetch', request)
  await ingestToKnowledgeBase(deps, { ...artifact, title, platform: 'Tencent Meeting', startedAt: 1794965816636, summaryMarkdown: `# ${title}\n\nPreserved meeting content.` })
  const init = (request.mock.calls[0] as unknown as [string, RequestInit])[1]
  const sent = JSON.parse(String(init.body))
  expect(sent.title).toContain('Tencent Meeting')
  expect(sent.title).not.toContain('\uFFFD')
  expect(sent.body).not.toContain('\uFFFD')
  expect(sent.body).toContain('Preserved meeting content.')
})
