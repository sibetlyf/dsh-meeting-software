import { readableMeetingTitle } from '../titles';
/**
 * 会后全自动后处理流水线 (pipeline/postMeeting.ts)
 *
 * 会议结束后自动依次执行：
 * 1. 百炼非流式高精度重转写（对完整录音重新转写，修正流式断句与标点）
 * 2. 本地 ONNX 声纹识别（标注出每个发言片段对应的说话人姓名/聚类标签）
 * 3. 调用 DSH 生成四象限结构化决策（决议、待办、风险、待定）与 Markdown 纪要
 * 4. 发布制品到 DSH 统一目录（桌面应用与 DSH Web 双向实时可见）
 * 5. 写入 DSH 知识库（dsh-knowledge 向量沉淀，支持跨会议问答溯源）
 */
import { transcribeOfflineBailian, type AsrSentence } from '../asr/bailianProvider';
import { labelSpeakersWithVoiceprint, type LabeledSentence } from '../voiceprint';
import { DshCloudEngine } from '../dsh/dshEngine';
import { ingestToKnowledgeBase, publishMeetingArtifacts } from '../dsh/dshBridge';

export interface PostMeetingInput {
  meetingId: string;
  title: string;
  platform?: string;
  meetingCode?: string;
  notesMarkdown?: string;
  startedAt: number;
  endedAt: number;
  meWavPath?: string;
  themWavPath?: string;
  fallbackTranscript?: AsrSentence[];
  onProgress?: (stage: string, message: string) => void;
}

export interface PostMeetingResult {
  ok: boolean;
  meetingId: string;
  speakers: string[];
  transcript: LabeledSentence[];
  quadrants: {
    decisions: string[];
    todos: Array<{ owner?: string; task: string; due?: string }>;
    risks: string[];
    questions: string[];
  };
  summaryMarkdown: string;
  artifactDir: string;
  knowledgeIngested: boolean;
}

export async function runPostMeetingPipeline(input: PostMeetingInput): Promise<PostMeetingResult> {
  const notify = input.onProgress ?? ((stage, msg) => console.log(`[postMeeting][${stage}] ${msg}`));

  // 1. 全量音频非流式高精度重转写
  notify('offline_asr', '正在调用百炼非流式 ASR 重新转写完整会议录音...');
  const rawSentences: AsrSentence[] = [];
  if (input.meWavPath) {
    try {
      const meRes = await transcribeOfflineBailian(input.meWavPath, 'me');
      rawSentences.push(...meRes);
    } catch (err) {
      console.warn('[postMeeting] 麦克风轨离线转写失败:', err);
    }
  }
  if (input.themWavPath) {
    try {
      const themRes = await transcribeOfflineBailian(input.themWavPath, 'them');
      rawSentences.push(...themRes);
    } catch (err) {
      console.warn('[postMeeting] 扬声器轨离线转写失败:', err);
    }
  }

  const refinedTracks = new Set(rawSentences.filter(s => s.text.trim()).map(s => s.track));
  const baseSentences = [
    ...rawSentences.filter(s => s.text.trim()),
    ...(input.fallbackTranscript || []).filter(s => !refinedTracks.has(s.track)),
  ].sort((a, b) => a.startMs - b.startMs);

  // 2. 本地 ONNX 声纹识别与说话人标注
  notify('voiceprint', '正在进行本地声纹识别与说话人标注...');
  const { sentences: labeledTranscript, speakers } = await labelSpeakersWithVoiceprint(
    input.themWavPath || input.meWavPath || '',
    baseSentences,
  );

  // 3. 调用 DSH 生成四象限纪要与结构化总结
  notify('minutes', '正在调用 DSH 提炼会议四象限纪要与待办事项...');
  const transcriptText = labeledTranscript
    .map((s) => `[${Math.floor(s.startMs / 1000)}s] ${s.speaker}: ${s.text}`)
    .join('\n');

  const engine = new DshCloudEngine();
  let quadrants = {
    decisions: [] as string[],
    todos: [] as Array<{ owner?: string; task: string; due?: string }>,
    risks: [] as string[],
    questions: [] as string[],
  };
  input = { ...input, title: readableMeetingTitle(input) };
  let summaryMarkdown = `# ${input.title}\n\n${transcriptText ? `## 逐字稿\n${transcriptText}` : '暂无转写内容。'}`;

  if (transcriptText.trim() || input.notesMarkdown?.trim()) {
    const notesBlock = input.notesMarkdown?.trim()
      ? `\n\n参会人手写笔记（请作为核心重点与结构骨架参考并扩写补全）：\n${input.notesMarkdown.trim()}`
      : '';
    const prompt = `你是一名专业的会议纪要专家。请基于以下带说话人标签的完整会议逐字稿${notesBlock ? '以及参会人手写笔记' : ''}，输出严格符合以下 JSON 结构的总结（不要包裹多余解释）：
{
  "decisions": ["决议1", "..."],
  "todos": [{"owner": "责任人", "task": "具体任务", "due": "截止时间"}],
  "risks": ["风险项1", "..."],
  "questions": ["待定问题1", "..."],
  "summaryMarkdown": "# ${input.title}\\n\\n## 会议概要\\n...\\n## 关键决议\\n...\\n## 行动待办\\n..."
}${notesBlock}

会议逐字稿：
${transcriptText || '（暂无语音转写内容）'}`;

    try {
      const sessionTitle = `纪要生成 · ${input.platform || '腾讯会议'}${input.meetingCode ? ` · ${input.meetingCode}` : ''} · ${input.title}`;
      const rawReply = await engine.chat(
        {
          messages: [
            { role: 'system', content: '你必须返回合法 JSON，包含 decisions, todos, risks, questions, summaryMarkdown 字段。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
        },
        () => {},
        undefined,
        sessionTitle,
      );
      const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        quadrants = {
          decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
          todos: Array.isArray(parsed.todos) ? parsed.todos : [],
          risks: Array.isArray(parsed.risks) ? parsed.risks : [],
          questions: Array.isArray(parsed.questions) ? parsed.questions : [],
        };
        if (typeof parsed.summaryMarkdown === 'string' && parsed.summaryMarkdown.trim()) {
          summaryMarkdown = parsed.summaryMarkdown;
        }
      }
    } catch (err) {
      console.warn('[postMeeting] 解析 DSH 纪要失败，使用基础 Markdown 兜底:', err);
      summaryMarkdown = `# ${input.title}\n\n## 参会人\n${speakers.join('、') || '未知'}\n\n## 逐字稿\n${transcriptText}`;
    }

    if (input.notesMarkdown?.trim() && !summaryMarkdown.includes(input.notesMarkdown.trim())) {
      summaryMarkdown = `${summaryMarkdown.trim()}\n\n---\n\n## 参会人手写笔记（原稿保留）\n${input.notesMarkdown.trim()}`;
    }
  }

  // 0. 防护：空录音、失败的录音且无任何有效手写笔记，直接跳过归档与知识库入库，避免污染知识库
  const hasTranscript = labeledTranscript.some((s) => String(s.text || '').trim().length >= 2);
  const hasNotes = Boolean(input.notesMarkdown && input.notesMarkdown.trim().length >= 2);
  if (!hasTranscript && !hasNotes) {
    notify('done', '未检测到有效语音或笔记内容，已跳过归档与知识库入库');
    return {
      ok: true,
      meetingId: input.meetingId,
      speakers: [],
      transcript: [],
      quadrants: { decisions: [], todos: [], risks: [], questions: [] },
      summaryMarkdown: '',
      artifactDir: '',
      knowledgeIngested: false,
    };
  }

  // 4. 发布制品到统一目录（应用内与 DSH Web 双向实时可见）
  notify('artifacts', '正在发布会议制品至 DSH 工作区与桌面端...');
  const artifactPayload = {
    meetingId: input.meetingId,
    title: input.title,
    platform: input.platform || '腾讯会议',
    meetingCode: input.meetingCode || '',
    notesMarkdown: input.notesMarkdown,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    speakers,
    summaryMarkdown,
    quadrants,
    transcript: labeledTranscript,
  };
  const pubRes = await publishMeetingArtifacts(artifactPayload);

  // 5. 自动写入 DSH 知识库
  notify('knowledge', '正在将会议纪要与逐字稿沉淀至 DSH 知识库...');
  const kbRes = await ingestToKnowledgeBase(artifactPayload).catch(() => ({ ok: false }));

  notify('done', kbRes.ok ? '会议已归档，知识库同步完成。' : '会议已归档，知识库同步未确认。');
  return {
    ok: true,
    meetingId: input.meetingId,
    speakers,
    transcript: labeledTranscript,
    quadrants,
    summaryMarkdown,
    artifactDir: pubRes.dir,
    knowledgeIngested: kbRes.ok,
  };
}

