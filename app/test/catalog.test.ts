import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as catalog from '../src/main/catalog'
import bundled from '../../catalog/catalog.json'
import licenses from '../../catalog/licenses.json'

describe('the catalog', () => {
  it('is the one in this build: nothing is fetched at launch (new models come with app updates)', () => {
    expect(Object.keys(catalog).sort()).toEqual(['loadCatalog'])
    const cat = catalog.loadCatalog({ bundled, licenses })
    expect(cat.models).toHaveLength(bundled.models.length)
    expect(cat.asr.length).toBeGreaterThan(0)
  })
  it('a broken bundled catalog is a clear error', () => {
    expect(() => catalog.loadCatalog({ bundled: { version: 1, models: [] }, licenses })).toThrow(/Bundled catalog is invalid/)
  })
})

/** every file under a folder */
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))

describe('network boundaries', () => {
  it('keeps network calls in explicit main-process adapters and out of the renderer', () => {
    const src = join(__dirname, '../src')
    const allowed = new Set([
      'main/downloader.ts', 'main/asr/server.ts', 'main/asr/transcribe.ts',
      'main/asr/bailianProvider.ts', 'main/dsh/dshBridge.ts', 'main/dsh/dshEngine.ts', 'main/dsh/knowledgeService.ts',
    ])
    const calls = files(src).filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /(?<![.\w]|async )fetch\(|(\?\?|=) fetch\b|net\.request|from 'node:https?'|require\('https?'\)|new WebSocket|XMLHttpRequest|raw\.githubusercontent/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(src.length + 1).replaceAll('\\', '/'))
      // the home list pages through its own IPC call named fetch
      .filter((f) => f !== 'renderer/src/paging.ts')
    expect(calls.filter((f) => !allowed.has(f))).toEqual([])
  })
})
