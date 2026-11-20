/**
 * 已剥离本地 node-llama-cpp 推理引擎：
 * 实际对话与总结均已路由至主进程 DshCloudEngine（DSH 原生会话 + 云端大模型）。
 * 此文件保留最小兼容接口以保障原有工程结构与测试编译通过。
 */
import type { EngineMessage } from '../shared/engine-protocol'

export function createLlm() {
  return {
    async load(_modelPath: string, contextSize: number, _minContext: number) {
      return { contextSize: Math.max(contextSize, 128_000) }
    },
    async unload() {},
    async count(texts: string[]) {
      return texts.map((t) => Math.ceil(t.length / 2))
    },
    async chat(
      _req: { messages: EngineMessage[]; maxTokens?: number; thoughtBudget: number; temperature?: number },
      _onToken: (text: string, thought?: boolean) => void,
      _signal?: AbortSignal,
      _onTiming?: (text: string) => void,
    ) {
      return ''
    },
    async preload(messages: EngineMessage[], _signal?: AbortSignal, _onTiming?: (text: string) => void) {
      return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 2), 0)
    },
    async embed(_modelPath: string, texts: string[]) {
      return texts.map(() => new Array<number>(64).fill(0))
    },
    async unloadEmbed() {},
    async probe() {
      return { gpu: false, gpuDevices: [] as string[], cpuOnly: true }
    },
  }
}
