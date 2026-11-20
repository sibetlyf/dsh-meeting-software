import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { labelSpeakersWithVoiceprint } from '../src/main/voiceprint'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const temp = mkdtempSync(join(tmpdir(), 'dsh-meeting-test-'))
let bridge: typeof import('../src/main/dsh/dshBridge')
const fetchStub = vi.fn(async (url: string, _options?: RequestInit) => {
  if (url.endsWith('/health')) return Response.json({ ok: true, plugin: 'dsh-meeting-host' })
  if (url.endsWith('/copilot/chat')) return Response.json({ ok: true, reply: '日程已创建', tools: ['meeting_schedule_create'] })
  if (url.endsWith('/api/soulmirror/join')) return Response.json({ ok: true })
  if (url.endsWith('/v1/meetings/quick')) return Response.json({ ok: true, debug: [{ at: 123, stage: 'computer 返回', detail: '点击已发送' }] })
  return new Response(null, { status: 503 })
})
beforeAll(async () => {
  vi.stubEnv('DSH_HOME', join(temp, 'profile'))
  vi.stubEnv('DSH_WRITABLE_DATA_DIR', join(temp, 'data'))
  vi.stubEnv('DSH_ARTIFACTS_DIR', join(temp, 'artifacts'))
  vi.stubEnv('DSH_AUTH_TOKEN', '')
  vi.stubGlobal('fetch', fetchStub)
  bridge = await import('../src/main/dsh/dshBridge')
})
afterAll(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(temp, { recursive: true, force: true })
})

describe('DSH 会议助手集成链路', () => {
  it('requests a quick meeting via DSH with explicit confirmation', async () => {
    fetchStub.mockClear()
    const trace = vi.fn()
    expect(await bridge.startQuickWithDshComputerUse('tencent', trace)).toBe('submitted')
    expect(trace).toHaveBeenCalledWith('computer 返回', '点击已发送', 123)
    const calls = fetchStub.mock.calls.filter(([url]) => !url.endsWith('/health'))
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toMatch(/\/v1\/meetings\/quick$/)
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ platform: 'tencent', confirm: true })
  })
  it('能够发布制品至统一目录并在列表中读取（支持应用与 DSH Web 双向可见）', async () => {
    const testId = `test_meeting_${Date.now()}`
    const pub = await bridge.publishMeetingArtifacts({
      meetingId: testId,
      title: '每日站会测试',
      platform: 'tencent',
      startedAt: Date.now() - 60_000,
      endedAt: Date.now(),
      speakers: ['我 (本人)', '李亚峰'],
      summaryMarkdown: '# 每日站会测试\n\n- 完成 DSH Profile 接入',
      quadrants: {
        decisions: ['采用百炼云端 ASR + 本地 ONNX 声纹'],
        todos: [{ owner: '李亚峰', task: '验证 DSH Web 制品预览', due: '今天' }],
        risks: [],
        questions: [],
      },
      transcript: [
        { track: 'me', speaker: '我 (本人)', startMs: 1000, endMs: 4000, text: '大家早上好，今天上午九点半站会开始。' },
        { track: 'them', speaker: '李亚峰', startMs: 4500, endMs: 8000, text: '好的，昨天已经完成了 DSH 知识库同步。' },
      ],
    })

    expect(pub.ok).toBe(true)
    expect(existsSync(join(pub.dir, 'summary.md'))).toBe(true)
    expect(existsSync(join(pub.dir, 'quadrants.json'))).toBe(true)
    expect(existsSync(join(pub.dir, 'transcript-labeled.json'))).toBe(true)

    const list = await bridge.listMeetingArtifacts()
    expect(list.some((m) => m.meetingId === testId)).toBe(true)

  })

  it('声纹标注引擎能区分 me 轨与 them 轨说话人', async () => {
    const res = await labelSpeakersWithVoiceprint('', [
      { track: 'me', startMs: 0, endMs: 2000, text: '我这边测试麦克风' },
      { track: 'them', startMs: 2500, endMs: 5000, text: '对方测试扬声器' },
    ])
    expect(res.sentences[0].speaker).toBe('我 (本人)')
    expect(res.sentences[1].speaker).toBeTruthy()
    expect(res.speakers).toContain('我 (本人)')
  })

  it('将自然语言日程请求发送到 DSH 调度接口，不触碰真实日程', async () => {
    const prompt = '以后帮我每天上午九点半开站会'
    const res = await bridge.orchestrateNaturalLanguage(prompt)
    expect(res.ok).toBe(true)
    expect(res.tools).toEqual(['meeting_schedule_create'])
    const call = fetchStub.mock.calls.find(([url]) => url.endsWith('/copilot/chat'))
    expect(JSON.parse(String(call?.[1]?.body)).prompt).toBe(prompt)
  })

  it('从邀请导入本地日程时去掉链接后的标点，且默认不录音', async () => {
    const res = await bridge.orchestrateNaturalLanguage('会议主题：测试会议\n会议号：123-456-789\n邀请您参加：https://meeting.tencent.com/dm/test。）')
    expect(res.ok).toBe(true)
    expect(await bridge.listTodaySchedules()).toEqual(expect.arrayContaining([expect.objectContaining({
      title: '测试会议', meetingCode: '123-456-789', meetingUrl: 'https://meeting.tencent.com/dm/test', autoRecord: false,
    })]))
  })

  it('submits the meeting code through DSH desktop control without arming DSH capture', async () => {
    fetchStub.mockClear()
    expect(await bridge.joinWithDshComputerUse('tencent', '123456789')).toBe('submitted')
    const commands = fetchStub.mock.calls.filter(([url]) => !url.endsWith('/health'))
    expect(commands).toHaveLength(1)
    expect(commands[0][0]).toMatch(/\/api\/soulmirror\/join$/)
    expect(JSON.parse(String(commands[0][1]?.body))).toEqual({ app: '腾讯会议', code: '123456789' })
  })
})

