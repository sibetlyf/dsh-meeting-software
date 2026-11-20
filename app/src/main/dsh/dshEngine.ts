/**
 * DSH 云端推理引擎适配器 (dshEngine.ts)
 *
 * 100% 与 DSH cordis.patch.yml 配置保持一致：
 * 按 DSH 配置直接调用模型。转写和笔记是数据，不交给可执行会议工具的调度会话。
 */
import type { Engine, ChatRequest } from '../engine';
import type { EngineMessage } from '../../shared/engine-protocol';
import { loadDshCredentials, readCordisDefaultModel } from './dshBridge';

function estimateTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x2e80) cjk++;
  }
  const ascii = text.length - cjk;
  return Math.ceil(cjk * 1.5 + ascii / 3.5);
}

export class DshCloudEngine implements Engine {
  private exitListeners: Array<() => void> = [];

  async load(_modelPath: string, contextSize: number): Promise<{ contextSize: number }> {
    return { contextSize: Math.max(contextSize, 128_000) };
  }

  async unload(): Promise<void> { }

  async count(texts: string[]): Promise<number[]> {
    return texts.map((t) => estimateTokens(t));
  }

  async preload(messages: EngineMessage[]): Promise<number> {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  async chat(req: ChatRequest, onToken: (text: string) => void, signal?: AbortSignal, _sessionTitle?: string): Promise<string> {
    const creds = await loadDshCredentials();
    const { provider, model } = await readCordisDefaultModel();
    const isCctq = provider === 'cctq';
    const apiKey = isCctq ? creds.cctqApiKey : creds.volcengineApiKey;
    const endpoint = isCctq
      ? 'https://www.cctq.ai/v1/chat/completions'
      : 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions';

    if (apiKey) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: req.messages,
          stream: true,
          temperature: req.temperature ?? 0.3,
          max_tokens: req.maxTokens ?? 4096,
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });

      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                onToken(delta);
              }
            } catch { }
          }
        }
        if (fullText) return fullText;
      }
    }

    return '';
  }

  async embed(_modelPath: string, texts: string[]): Promise<number[][]> {
    const creds = await loadDshCredentials();
    if (creds.dashscopeApiKey && texts.length > 0) {
      try {
        const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${creds.dashscopeApiKey}`,
          },
          body: JSON.stringify({
            model: 'text-embedding-v3',
            input: texts.slice(0, 25),
          }),
        });
        if (res.ok) {
          const json = (await res.json()) as any;
          if (Array.isArray(json?.data)) {
            return json.data.map((d: any) => d.embedding as number[]);
          }
        }
      } catch (err) {
        console.warn('[DshCloudEngine] 百炼 Embedding 请求失败，使用轻量降级向量:', err);
      }
    }
    return texts.map((t) => {
      const vec = new Array<number>(64).fill(0);
      for (let i = 0; i < t.length; i++) {
        vec[t.charCodeAt(i) % 64] += 1;
      }
      const norm = Math.hypot(...vec) || 1;
      return vec.map((v) => v / norm);
    });
  }

  async unloadEmbed(): Promise<void> { }

  onExit(cb: () => void): void {
    this.exitListeners.push(cb);
  }

  dispose(): void {
    this.exitListeners.length = 0;
  }
}
