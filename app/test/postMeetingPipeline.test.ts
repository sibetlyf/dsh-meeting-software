import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ transcribe: vi.fn(), publish: vi.fn(), ingest: vi.fn(), chat: vi.fn() }))
vi.mock('../src/main/asr/bailianProvider', () => ({ transcribeOfflineBailian: mocks.transcribe }))
vi.mock('../src/main/voiceprint', () => ({ labelSpeakersWithVoiceprint: async (_path: string, sentences: object[]) => ({
  sentences: sentences.map(s => ({ ...s, speaker: 'Speaker' })), speakers: ['Speaker'],
}) }))
vi.mock('../src/main/dsh/dshEngine', () => ({ DshCloudEngine: class { chat = mocks.chat } }))
vi.mock('../src/main/dsh/dshBridge', () => ({ publishMeetingArtifacts: mocks.publish, ingestToKnowledgeBase: mocks.ingest }))

import { runPostMeetingPipeline } from '../src/main/pipeline/postMeeting'

const input = { meetingId: 'm1', title: 'Standup', startedAt: 10, endedAt: 100, onProgress: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.publish.mockResolvedValue({ ok: true, dir: 'archive' })
  mocks.ingest.mockResolvedValue({ ok: false })
})

it('keeps the other track when only one track is refined and retains text if the model has no output', async () => {
  mocks.transcribe.mockResolvedValueOnce([{ track: 'me', startMs: 0, endMs: 10, text: 'Refined microphone' }]).mockResolvedValueOnce([])
  mocks.chat.mockResolvedValue('')
  const result = await runPostMeetingPipeline({ ...input, meWavPath: 'me.wav', themWavPath: 'them.wav', fallbackTranscript: [
    { track: 'me', startMs: 0, endMs: 10, text: 'Old microphone' },
    { track: 'them', startMs: 11, endMs: 25, text: 'Kept remote speech' },
  ] })
  expect(result.transcript.map(s => s.text)).toEqual(['Refined microphone', 'Kept remote speech'])
  expect(result.summaryMarkdown).toContain('Kept remote speech')
  expect(result.artifactDir).toBe('archive')
  expect(result.knowledgeIngested).toBe(false)
})

it('does not archive or index an empty meeting', async () => {
  const result = await runPostMeetingPipeline(input)
  expect(result.artifactDir).toBe('')
  expect(mocks.publish).not.toHaveBeenCalled()
  expect(mocks.ingest).not.toHaveBeenCalled()
})
