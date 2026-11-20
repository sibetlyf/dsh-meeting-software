/**
 * 百炼云端实时流式 ASR + 回声去重 + 会中/会后全自动整理流水线 (asr/bailianHook.ts)
 *
 * 1. 双轨实时流式 ASR，并内置 me/them 文本级回声去重（避免麦克风与扬声器同时录到同一句话造成重复）
 * 2. 会中每有新内容积累自动触发一次结构化笔记整理，并推送完整 NoteView 更新前端
 * 3. 会议结束自动触发百炼非流式精转、声纹说话人标注、DSH 四象限纪要、制品同步与知识库留档
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { BailianRealtimeStream, type AsrSentence } from './bailianProvider';
import { onCaptureStart, recordingFinished, type Track } from '../capture';
import { onMeetingStop } from '../meeting';
import { userDataDir } from '../paths';
import { runPostMeetingPipeline } from '../pipeline/postMeeting';
import { DshCloudEngine } from '../dsh/dshEngine';
import type { Segment, Store } from '../store';

function float32ToInt16Buffer(samples: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), i * 2);
  }
  return buf;
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[\s，。！？、,.!?:;"'“”‘’\-_]/g, '');
}

/** 计算两句转写文本的字符重合度（用于过滤 me 与 them 之间的回声/串音重复） */
function textOverlapRatio(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (longer.includes(shorter) && shorter.length >= 4) return 1;
  let hits = 0;
  const freq = new Map<string, number>();
  for (const ch of longer) freq.set(ch, (freq.get(ch) || 0) + 1);
  for (const ch of shorter) {
    const cnt = freq.get(ch) || 0;
    if (cnt > 0) {
      hits++;
      freq.set(ch, cnt - 1);
    }
  }
  return hits / shorter.length;
}

export function hookBailianCloudAsr(opts: {
  store: Store;
  sendSegment: (seg: Segment) => void;
  sendPartial: (p: { meetingId: string; track: Track; startMs: number; text: string }) => void;
  onRefreshTranscript: (meetingId: string) => void;
  onRefreshNotes: (meetingId: string) => void;
}) {
  const activeStreams = new Map<
    string,
    {
      me: BailianRealtimeStream;
      them: BailianRealtimeStream;
      cached: AsrSentence[];
      recent: Array<{ track: Track; text: string; at: number }>;
      noteTimer?: NodeJS.Timeout;
      lastOrganizedCount: number;
    }
  >();
  const finalizing = new Map<string, Promise<boolean>>();

  async function organizeLiveNotes(meetingId: string, title: string, sentences: AsrSentence[]) {
    if (sentences.length < 2) return;
    try {
      const engine = new DshCloudEngine();
      const lines = sentences.map((s) => `${s.track === 'me' ? '我' : '参会者'}: ${s.text}`).join('\n');
      const md = await engine.chat(
        {
          messages: [
            {
              role: 'system',
              content: '你是会议助手，请将实时转写内容整理成简洁清晰的中文 Markdown 笔记（含讨论要点、初步结论与待办）。',
            },
            { role: 'user', content: `会议主题：${title}\n\n实时转写：\n${lines}` },
          ],
          temperature: 0.2,
        },
        () => {},
      );
      if (md?.trim() && activeStreams.has(meetingId) && !opts.store.notes(meetingId).edited) {
        opts.store.setNotes(meetingId, { enhanced: md.trim() });
        opts.onRefreshNotes(meetingId);
      }
    } catch (err) {
      console.warn('[bailianHook] 会中自动整理笔记失败:', err);
    }
  }

  onCaptureStart((capture, meetingId) => {
    const cached: AsrSentence[] = [];
    const recent: Array<{ track: Track; text: string; at: number }> = [];
    const startedAt = Date.now();
    let warnedMissingKey = false;

    const makeStream = (track: Track) =>
      new BailianRealtimeStream(track, {
        onPartial: (text) => {
          opts.sendPartial({ meetingId, track, startMs: Date.now() - startedAt, text });
        },
        onSentence: (seg) => {
          const now = Date.now();
          // 过滤 8 秒内跨轨（me vs them）高度重复的回声语句
          const isDuplicate = recent.some(
            (r) => r.track !== seg.track && now - r.at < 8000 && textOverlapRatio(r.text, seg.text) >= 0.5,
          );
          if (isDuplicate) {
            opts.sendPartial({ meetingId, track, startMs: seg.endMs, text: '' });
            return;
          }

          recent.push({ track: seg.track, text: seg.text, at: now });
          if (recent.length > 20) recent.shift();
          cached.push(seg);

          const speaker = seg.track === 'me' ? '我 (本人)' : '参会者';
          opts.store.addSegments([
            {
              meetingId,
              track: seg.track,
              startMs: seg.startMs,
              endMs: seg.endMs,
              text: seg.text,
              speaker,
            },
          ]);
          opts.sendSegment({
            id: Date.now(),
            meetingId,
            track: seg.track,
            startMs: seg.startMs,
            endMs: seg.endMs,
            text: seg.text,
            speaker,
          });
          opts.sendPartial({ meetingId, track, startMs: seg.endMs, text: '' });
        },
        onError: (err) => {
          console.warn(`[bailian-asr][${track}]`, err.message);
          if (!warnedMissingKey && /API Key|未配置/i.test(err.message)) {
            warnedMissingKey = true;
            opts.sendPartial({
              meetingId,
              track: 'me',
              startMs: 0,
              text: '⚠️ 尚未配置阿里云百炼 API Key，请前往【设置 → DSH 云端语音与大模型】填入 sk-... 后即可开启实时流式转写',
            });
          }
        },
      });

    const me = makeStream('me');
    const them = makeStream('them');
    const entry = {
      me,
      them,
      cached,
      recent,
      lastOrganizedCount: 0,
      noteTimer: setInterval(() => {
        if (entry.cached.length >= entry.lastOrganizedCount + 2) {
          entry.lastOrganizedCount = entry.cached.length;
          const m = opts.store.meeting(meetingId);
          void organizeLiveNotes(meetingId, m?.title || '会议记录', [...entry.cached]);
        }
      }, 30_000),
    };
    activeStreams.set(meetingId, entry);

    void me.start();
    void them.start();

    capture.on('pcm', (track: Track, _ms: number, samples: Float32Array) => {
      const pcmBuf = float32ToInt16Buffer(samples);
      if (track === 'me') me.pushPcm(pcmBuf);
      else them.pushPcm(pcmBuf);
    });
  });

  onMeetingStop((meeting) => {
    const entry = activeStreams.get(meeting.id);
    if (!entry) return;
    if (entry.noteTimer) clearInterval(entry.noteTimer);
    activeStreams.delete(meeting.id);

    const task = (async () => {
      await Promise.all([entry.me.stop(), entry.them.stop()]);
      await recordingFinished(meeting.id);

      const dir = join(userDataDir(), 'meetings', meeting.id);
      const meWav = join(dir, 'me.wav');
      const themWav = join(dir, 'them.wav');

      try {
        const codeMatch = String(meeting.title || '').match(/(\d{3}[-\s]?\d{3}[-\s]?\d{3,4})/);
        const myNotes = opts.store.notes(meeting.id);
        const result = await runPostMeetingPipeline({
          meetingId: meeting.id,
          title: meeting.title || '会议记录',
          platform: meeting.app || '腾讯会议',
          meetingCode: codeMatch ? codeMatch[1] : '',
          notesMarkdown: myNotes.mine || undefined,
          startedAt: meeting.startedAt,
          endedAt: meeting.endedAt ?? Date.now(),
          meWavPath: existsSync(meWav) ? meWav : undefined,
          themWavPath: existsSync(themWav) ? themWav : undefined,
          fallbackTranscript: entry.cached,
        });

        // Refined segments are archived separately; don't append them over existing live lines.
        if (result.transcript.length > 0 && !opts.store.segments(meeting.id, { hidden: true }).length &&
          opts.store.meeting(meeting.id)?.state !== 'recording') {
          opts.store.addSegments(
            result.transcript.map((s) => ({
              meetingId: meeting.id,
              track: s.track,
              startMs: s.startMs,
              endMs: s.endMs,
              text: s.text,
              speaker: s.speaker,
            })),
          );
        }
        if (result.summaryMarkdown && !opts.store.notes(meeting.id).edited && opts.store.meeting(meeting.id)?.state !== 'recording') {
          opts.store.setNotes(meeting.id, { enhanced: result.summaryMarkdown });
        }
        opts.onRefreshNotes(meeting.id);
        opts.onRefreshTranscript(meeting.id);
        return Boolean(result.summaryMarkdown);
      } catch (err) {
        console.error('[bailianHook] 会后流水线执行失败:', err);
        return false;
      }
    })().catch(err => {
      console.error('[bailianHook] failed to finalize audio:', err);
      return false;
    }).finally(() => finalizing.delete(meeting.id));
    finalizing.set(meeting.id, task);
  });
  return (meetingId: string) => finalizing.get(meetingId);
}
