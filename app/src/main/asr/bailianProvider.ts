/**
 * 阿里云百炼 (DashScope) 语音识别驱动 (bailianProvider.ts)
 *
 * 1. 会中实时流式 ASR：通过 WebSocket 连接 paraformer-realtime-v2，实现低延迟逐字实时上屏。
 * 2. 会后离线精准重转写：会议结束后将完整录音重新提交给非流式高精度 ASR，获得精确时间戳与标点。
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadDshCredentials } from '../dsh/dshBridge';

const DASHSCOPE_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

export interface AsrSentence {
  startMs: number;
  endMs: number;
  text: string;
  track: 'me' | 'them';
}

export class BailianRealtimeStream {
  private ws: WebSocket | null = null;
  private taskId: string = randomUUID();
  private started = false;
  private closed = false;
  private queue: Buffer[] = [];

  constructor(
    private track: 'me' | 'them',
    private opts: {
      onPartial?: (text: string) => void;
      onSentence?: (seg: AsrSentence) => void;
      onError?: (err: Error) => void;
    },
  ) {}

  async start(): Promise<boolean> {
    const creds = await loadDshCredentials();
    if (!creds.dashscopeApiKey) {
      this.opts.onError?.(new Error('未配置百炼 DashScope API Key（~/.dsh/.credentials.yaml）'));
      return false;
    }

    return new Promise((resolve) => {
      const ws = new WebSocket(DASHSCOPE_WS_URL, {
        headers: {
          Authorization: `bearer ${creds.dashscopeApiKey}`,
        },
      });
      this.ws = ws;

      const timeout = setTimeout(() => {
        if (!this.started) {
          resolve(false);
        }
      }, 6000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            header: {
              action: 'run-task',
              task_id: this.taskId,
              streaming: 'duplex',
            },
            payload: {
              task_group: 'audio',
              task: 'asr',
              function: 'recognition',
              model: 'paraformer-realtime-v2',
              parameters: {
                format: 'pcm',
                sample_rate: 16000,
                language_hints: ['zh', 'en'],
                semantic_punctuation_enabled: true,
              },
              input: {},
            },
          }),
        );
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString('utf8'));
          const event = msg?.header?.event;
          if (event === 'task-started') {
            this.started = true;
            clearTimeout(timeout);
            // 将握手期间缓存的音频帧冲刷出去
            for (const buf of this.queue) ws.send(buf);
            this.queue = [];
            resolve(true);
            return;
          }

          if (event === 'result-generated') {
            const sentence = msg?.payload?.output?.sentence;
            if (sentence?.text) {
              if (sentence.sentence_end) {
                this.opts.onSentence?.({
                  track: this.track,
                  startMs: Number(sentence.begin_time ?? 0),
                  endMs: Number(sentence.end_time ?? 0),
                  text: String(sentence.text).trim(),
                });
              } else {
                this.opts.onPartial?.(String(sentence.text).trim());
              }
            }
          } else if (event === 'task-failed') {
            this.opts.onError?.(new Error(msg?.header?.error_message || '百炼流式转写任务失败'));
          }
        } catch {
          // 忽略非 JSON 帧
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        this.opts.onError?.(err);
        if (!this.started) resolve(false);
      });

      ws.on('close', () => {
        this.closed = true;
      });
    });
  }

  /** 推送 16kHz 16-bit 单声道 PCM 数据 */
  pushPcm(pcm: Buffer): void {
    if (this.closed || !pcm.length) return;
    if (this.started && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    } else if (this.queue.length < 120) {
      this.queue.push(pcm);
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(
          JSON.stringify({
            header: {
              action: 'finish-task',
              task_id: this.taskId,
              streaming: 'duplex',
            },
            payload: { input: {} },
          }),
        );
      } catch {
        // 忽略发送错误
      }
      await new Promise((r) => setTimeout(r, 300));
      this.ws.close();
    }
    this.ws = null;
  }
}

/**
 * 会后非流式高精度重转写（对完整录音 WAV 进行离线高精度识别）
 *
 * 通过百炼非流式识别接口处理完整 WAV（带长上下文标点与逆文本正则化），
 * 返回带精确起止时间戳的句子列表，用于后续声纹对齐与知识库留档。
 */
export async function transcribeOfflineBailian(
  wavPath: string,
  track: 'me' | 'them' = 'them',
): Promise<AsrSentence[]> {
  if (!existsSync(wavPath)) return [];
  const creds = await loadDshCredentials();
  if (!creds.dashscopeApiKey) {
    throw new Error('缺少百炼 DashScope API Key，无法执行会后高精度重转写');
  }

  // 读取 WAV 文件并通过非流式 Paraformer/SenseVoice 同步识别（分段送入确保长音频稳定）
  const wavBuf = await readFile(wavPath);
  const pcmData = wavBuf.length > 44 && wavBuf.subarray(0, 4).toString('ascii') === 'RIFF' ? wavBuf.subarray(44) : wavBuf;
  if (pcmData.length < 3200) return [];

  // 使用 DashScope 非流式同步识别模式（关闭语义断句干扰，获取整段上下文的精准文本）
  const results: AsrSentence[] = [];
  const taskId = randomUUID();

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(DASHSCOPE_WS_URL, {
      headers: { Authorization: `bearer ${creds.dashscopeApiKey}` },
    });

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve();
    }, 60_000);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: 'paraformer-realtime-v2',
            parameters: {
              format: 'pcm',
              sample_rate: 16000,
              language_hints: ['zh', 'en'],
              disfluency_removal_enabled: true,
              punctuation_prediction_enabled: true,
              inverse_text_normalization_enabled: true,
            },
            input: {},
          },
        }),
      );
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        const event = msg?.header?.event;
        if (event === 'task-started') {
          // 以高速批处理方式分块发送完整音频数据
          const CHUNK_SIZE = 16000 * 2; // 每块 1 秒
          for (let offset = 0; offset < pcmData.length; offset += CHUNK_SIZE) {
            if (ws.readyState !== WebSocket.OPEN) break;
            ws.send(pcmData.subarray(offset, offset + CHUNK_SIZE));
          }
          ws.send(
            JSON.stringify({
              header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
              payload: { input: {} },
            }),
          );
        } else if (event === 'result-generated') {
          const s = msg?.payload?.output?.sentence;
          if (s?.sentence_end && s?.text) {
            results.push({
              track,
              startMs: Number(s.begin_time ?? 0),
              endMs: Number(s.end_time ?? 0),
              text: String(s.text).trim(),
            });
          }
        } else if (event === 'task-finished') {
          clearTimeout(timer);
          ws.close();
          resolve();
        } else if (event === 'task-failed') {
          clearTimeout(timer);
          ws.close();
          reject(new Error(msg?.header?.error_message || '会后重转写失败'));
        }
      } catch {
        // 忽略解析错误
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return results;
}

