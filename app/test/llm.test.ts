import { describe, it, expect } from 'vitest'
import { DshCloudEngine } from '../src/main/dsh/dshEngine'

describe('DshCloudEngine', () => {
  it('loads cloud context window without local GGUF weights', async () => {
    const engine = new DshCloudEngine()
    const res = await engine.load('unused', 32_768)
    expect(res.contextSize).toBeGreaterThanOrEqual(128_000)
  })

  it('estimates token counts and generates fallback embeddings', async () => {
    const engine = new DshCloudEngine()
    const counts = await engine.count(['你好，今天上午九点半开站会', 'hello world'])
    expect(counts[0]).toBeGreaterThan(0)
    expect(counts[1]).toBeGreaterThan(0)

    const vectors = await engine.embed('unused', ['测试文本'])
    expect(vectors).toHaveLength(1)
    expect(vectors[0].length).toBeGreaterThan(0)
  })
})
