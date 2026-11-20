/**
 * 会议制品与外部知识检索服务 (knowledgeService.ts)
 *
 * 职责：
 * 1. 统一管理会议归档制品（{软件}_{会议号}_{主题}）；
 * 2. 融合 DSH dsh-knowledge Markdown 文档与 Soulmirror 历史落地记录；
 * 3. 返回带内容哈希与来源类型的检索结果，支持「模型可见即入日志」的版本钉死。
 */
import { readableMeetingTitle } from '../titles';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface MeetingArtifactPayload {
  meetingId: string;
  title: string;
  platform?: string;
  meetingCode?: string;
  startedAt?: number;
  endedAt?: number;
  speakers?: string[];
  notesMarkdown?: string;
  summaryMarkdown?: string;
  quadrants?: {
    decisions?: string[];
    todos?: Array<{ owner?: string; task: string; due?: string }>;
    risks?: string[];
    questions?: string[];
  };
  transcript?: Array<{ speaker: string; startMs: number; endMs?: number; text: string; track?: string }>;
}

export interface ExternalKnowledgeItem {
  meetingId: string;
  sourceType: 'knowledge' | 'soulmirror';
  title: string;
  startedAt: number;
  atMs: number | null;
  text: string;
  score: number;
  contentHash: string;
}

export interface KnowledgeServiceDeps {
  baseUrl: string;
  dshHome: () => string;
  artifactsRoot: () => string;
  authHeaders: (extra?: Record<string, string>) => Record<string, string>;
  hasAuth: () => boolean;
}

function readableArtifact(payload: MeetingArtifactPayload): MeetingArtifactPayload {
  const title = readableMeetingTitle(payload)
  if (title === payload.title) return payload
  const heading = `# ${payload.title}`
  const summaryMarkdown = payload.summaryMarkdown?.split('\n').map(line => line.trim() === heading ? `# ${title}` : line).join('\n')
  return { ...payload, title, summaryMarkdown }
}

export function buildArchiveFolderName(payload: Pick<MeetingArtifactPayload, 'platform' | 'meetingCode' | 'title' | 'meetingId' | 'startedAt'>): string {
  const sanitize = (s: string) => s.replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const plat = sanitize(payload.platform || '腾讯会议');
  const code = sanitize(payload.meetingCode || '');
  const topic = sanitize(readableMeetingTitle(payload) || '未命名会议').slice(0, 48);
  const parts = [plat, code, topic].filter(Boolean);
  return parts.join('_') || payload.meetingId;
}

function parseKnowledgeMarkdown(raw: string, fallbackTitle: string): { title: string; body: string } {
  let body = raw;
  if (raw.startsWith('---')) {
    const endIdx = raw.indexOf('\n---', 3);
    if (endIdx !== -1) body = raw.slice(endIdx + 4).trimStart();
  }
  const headingMatch = body.match(/^#\s+(.+)$/m);
  const title = headingMatch?.[1]?.trim() || fallbackTitle.replace(/--[a-f0-9]+\.md$/i, '').replace(/\.md$/i, '');
  return { title, body };
}

async function collectKnowledgeDocuments(dshHomeDir: string) {
  const roots = [
    { prefix: 'kb:', dir: join(homedir(), '.dsh', 'knowledge', 'documents') },
    { prefix: 'kbhome:', dir: join(dshHomeDir, 'knowledge', 'documents') },
  ];
  const docs: Array<{ id: string; baseName: string; title: string; body: string; mtimeMs: number; contentHash: string }> = [];
  const seen = new Set<string>();

  for (const { prefix, dir } of roots) {
    if (!existsSync(dir)) continue;
    const walk = async (currentDir: string, baseName: string) => {
      try {
        const entries = await readdir(currentDir, { withFileTypes: true });
        for (const e of entries) {
          const full = join(currentDir, e.name);
          if (e.isDirectory()) {
            await walk(full, baseName === 'root' ? e.name : baseName);
          } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
            if (seen.has(full)) continue;
            seen.add(full);
            try {
              const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
              const parsed = parseKnowledgeMarkdown(raw, e.name);
              const rel = full.slice(dir.length + 1).replace(/\\/g, '/');
              docs.push({
                id: `${prefix}${rel}`,
                baseName: baseName === 'root' ? 'dsh-knowledge' : baseName,
                title: parsed.title,
                body: parsed.body,
                mtimeMs: st.mtimeMs || Date.now(),
                contentHash: createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12),
              });
            } catch {}
          }
        }
      } catch {}
    };
    await walk(dir, 'root');
  }
  return docs;
}

export async function publishMeetingArtifacts(
  deps: KnowledgeServiceDeps,
  payload: MeetingArtifactPayload,
): Promise<{ ok: boolean; meetingId: string; dir: string; archiveName: string }> {
  payload = readableArtifact(payload);
  const archiveName = buildArchiveFolderName(payload);
  if (deps.hasAuth()) {
    try {
      const res = await fetch(`${deps.baseUrl}/api/dsh-meeting/v1/artifacts/publish`, {
        method: 'POST',
        headers: deps.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        if (json?.ok && json?.data) {
          return { ok: true, meetingId: json.data.meetingId, dir: json.data.dir, archiveName: json.data.archiveName || archiveName };
        }
      }
    } catch (err) {
      console.warn('[knowledge] DSH 发布制品失败，降级本地落盘:', err);
    }
  }

  const dir = join(deps.artifactsRoot(), archiveName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        meetingId: payload.meetingId,
        archiveName,
        title: payload.title,
        platform: payload.platform || '腾讯会议',
        meetingCode: payload.meetingCode || '',
        startedAt: payload.startedAt || Date.now(),
        endedAt: payload.endedAt || Date.now(),
        speakers: payload.speakers || [],
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  if (payload.notesMarkdown != null) await writeFile(join(dir, 'notes.md'), payload.notesMarkdown, 'utf8');
  if (payload.summaryMarkdown != null) await writeFile(join(dir, 'summary.md'), payload.summaryMarkdown, 'utf8');
  if (payload.quadrants != null) await writeFile(join(dir, 'quadrants.json'), JSON.stringify(payload.quadrants, null, 2), 'utf8');
  if (payload.transcript != null) await writeFile(join(dir, 'transcript-labeled.json'), JSON.stringify(payload.transcript, null, 2), 'utf8');
  return { ok: true, meetingId: payload.meetingId, dir, archiveName };
}

export async function listMeetingArtifacts(deps: KnowledgeServiceDeps): Promise<any[]> {
  const list: any[] = [];
  const seen = new Set<string>();
  const pushItem = (item: any) => {
    if (!item?.meetingId || seen.has(item.meetingId)) return;
    seen.add(item.meetingId);
    list.push(item);
  };

  if (deps.hasAuth()) {
    try {
      const res = await fetch(`${deps.baseUrl}/api/dsh-meeting/v1/artifacts`, {
        headers: deps.authHeaders(),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        if (json?.ok && Array.isArray(json.data)) {
          for (const item of json.data) pushItem(item);
        }
      }
    } catch {}
  }

  const artifactDirs = Array.from(
    new Set([deps.artifactsRoot(), join(homedir(), '.dsh', 'artifacts', 'meetings'), join(homedir(), '.dsh', 'meeting-artifacts')]),
  );
  for (const root of artifactDirs) {
    if (!existsSync(root)) continue;
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const metaPath = join(root, e.name, 'meta.json');
        if (existsSync(metaPath)) {
          try {
            pushItem(JSON.parse(await readFile(metaPath, 'utf8')));
          } catch {}
        }
      }
    } catch {}
  }

  const smRoots = [
    { prefix: 'sm:', dir: join(homedir(), '.dsh', 'soulmirror') },
    { prefix: 'smhome:', dir: join(deps.dshHome(), 'soulmirror') },
  ];
  for (const { prefix, dir: smDir } of smRoots) {
    if (!existsSync(smDir)) continue;
    try {
      const smEntries = await readdir(smDir, { withFileTypes: true });
      for (const e of smEntries) {
        if (!e.isDirectory()) continue;
        const trPath = join(smDir, e.name, 'transcript.jsonl');
        const minPath = join(smDir, e.name, 'minutes.md');
        if (!existsSync(trPath) && !existsSync(minPath)) continue;
        // 过滤空录音或空转写的 Soulmirror 目录，避免污染知识库视图
        let hasValidContent = false;
        if (existsSync(minPath)) {
          try {
            if ((await readFile(minPath, 'utf8')).trim().length >= 20) hasValidContent = true;
          } catch {}
        }
        if (!hasValidContent && existsSync(trPath)) {
          try {
            const rawTr = await readFile(trPath, 'utf8');
            for (const line of rawTr.split(/\r?\n/)) {
              if (!line.trim().startsWith('{')) continue;
              try {
                const obj = JSON.parse(line);
                if (String(obj.text || '').trim().length >= 2) {
                  hasValidContent = true;
                  break;
                }
              } catch {}
            }
          } catch {}
        }
        if (!hasValidContent) continue;
        const parsedTs = Date.parse(e.name.slice(0, 19).replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3')) || Date.parse(e.name.slice(0, 10)) || 0;
        pushItem({
          meetingId: `${prefix}${e.name}`,
          title: `[Soulmirror] ${e.name}`,
          platform: 'soulmirror',
          startedAt: parsedTs,
          updatedAt: parsedTs ? new Date(parsedTs).toISOString() : undefined,
          speakers: ['Soulmirror 记录'],
        });
      }
    } catch {}
  }

  const kbDocs = await collectKnowledgeDocuments(deps.dshHome());
  for (const doc of kbDocs) {
    pushItem({
      meetingId: doc.id,
      title: `[知识库] ${doc.title}`,
      platform: 'dsh-knowledge',
      startedAt: doc.mtimeMs,
      updatedAt: new Date(doc.mtimeMs).toISOString(),
      speakers: [doc.baseName],
    });
  }

  return list.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
}

export async function getMeetingArtifactBundle(deps: KnowledgeServiceDeps, meetingId: string) {
  if (meetingId.startsWith('kb:') || meetingId.startsWith('kbhome:')) {
    const isHome = meetingId.startsWith('kbhome:');
    const rel = meetingId.slice(isHome ? 7 : 3);
    const root = isHome ? join(deps.dshHome(), 'knowledge', 'documents') : join(homedir(), '.dsh', 'knowledge', 'documents');
    const target = resolve(root, rel);
    if (!target.startsWith(resolve(root)) || !existsSync(target)) return null;
    const raw = await readFile(target, 'utf8');
    const parsed = parseKnowledgeMarkdown(raw, rel.split('/').pop() || rel);
    return { meta: { meetingId, title: `[知识库] ${parsed.title}`, platform: 'dsh-knowledge' }, summaryMarkdown: parsed.body, transcript: [] };
  }

  if (meetingId.startsWith('sm:') || meetingId.startsWith('smhome:')) {
    const isHome = meetingId.startsWith('smhome:');
    const folder = meetingId.slice(isHome ? 7 : 3);
    const dir = isHome ? join(deps.dshHome(), 'soulmirror', folder) : join(homedir(), '.dsh', 'soulmirror', folder);
    if (!existsSync(dir)) return null;
    const minPath = join(dir, 'minutes.md');
    const trPath = join(dir, 'transcript.jsonl');
    const summaryMarkdown = existsSync(minPath) ? await readFile(minPath, 'utf8') : undefined;
    const transcript: Array<{ speaker: string; startMs: number; text: string }> = [];
    if (existsSync(trPath)) {
      const raw = await readFile(trPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.text) {
            transcript.push({ speaker: obj.speaker || obj.who || '参会者', startMs: Number(obj.begin ?? obj.startMs ?? 0), text: String(obj.text) });
          }
        } catch {}
      }
    }
    return { meta: { meetingId, title: `[Soulmirror] ${folder}`, platform: 'soulmirror' }, summaryMarkdown, transcript };
  }

  const roots = Array.from(
    new Set([deps.artifactsRoot(), join(homedir(), '.dsh', 'artifacts', 'meetings'), join(homedir(), '.dsh', 'meeting-artifacts')]),
  );
  let dir = '';
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const direct = join(root, meetingId);
    if (existsSync(direct)) { dir = direct; break; }
    const entries = await readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaPath = join(root, e.name, 'meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf8'));
        if (meta?.meetingId === meetingId || meta?.archiveName === meetingId) { dir = join(root, e.name); break; }
      } catch {}
    }
    if (dir) break;
  }
  if (!dir || !existsSync(dir)) return null;
  const readOpt = async (f: string, json = false) => {
    const p = join(dir, f);
    if (!existsSync(p)) return null;
    const txt = await readFile(p, 'utf8');
    return json ? JSON.parse(txt) : txt;
  };
  return {
    meta: await readOpt('meta.json', true),
    notesMarkdown: await readOpt('notes.md', false),
    summaryMarkdown: await readOpt('summary.md', false),
    quadrants: await readOpt('quadrants.json', true),
    transcript: await readOpt('transcript-labeled.json', true),
  };
}

export async function ingestToKnowledgeBase(
  deps: KnowledgeServiceDeps,
  payload: MeetingArtifactPayload,
): Promise<{ ok: boolean; detail: string; contentHash: string }> {
  payload = readableArtifact(payload);
  const validTranscriptChars = (payload.transcript || []).reduce((sum, s) => sum + String(s.text || '').trim().length, 0);
  const validNotesChars = String(payload.notesMarkdown || '').trim().length;
  const validSummaryChars = String(payload.summaryMarkdown || '').trim().length;
  if (validTranscriptChars < 4 && validNotesChars < 4 && validSummaryChars < 10) {
    return { ok: false, detail: '空录音或失败的录音无有效内容，已跳过入库', contentHash: '' };
  }

  const transcriptText = (payload.transcript || [])
    .map((s) => `[${new Date(s.startMs).toISOString().slice(11, 19)}] ${s.speaker}: ${s.text}`)
    .join('\n');

  const mdContent = [
    `# ${payload.title || '会议纪要'}`,
    '',
    `- 会议平台：${payload.platform || '腾讯会议'}`,
    ...(payload.meetingCode ? [`- 会议号：${payload.meetingCode}`] : []),
    ...(payload.speakers?.length ? [`- 参会人：${payload.speakers.join('、')}`] : []),
    '',
    payload.summaryMarkdown || '',
    ...(payload.notesMarkdown ? ['', '## 我的手写笔记', payload.notesMarkdown] : []),
    ...(transcriptText ? ['', '## 完整会议逐字稿', transcriptText] : []),
  ].join('\n');
  const contentHash = createHash('sha256').update(mdContent, 'utf8').digest('hex').slice(0, 12);

  const url = `${deps.baseUrl}/api/dsh-meeting/v1/knowledge/ingest`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: deps.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title: payload.title || '会议纪要', body: mdContent }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const receipt = await res.json();
      if (receipt?.ok === true && typeof receipt.docId === 'string' && receipt.docId) {
        return { ok: true, detail: '已通过 DSH Knowledge 写入知识库', contentHash };
      }
    }
  } catch {}
  return { ok: false, detail: '知识库未确认入库，会议制品仍保留', contentHash };
}

export async function searchExternalKnowledge(
  dshHomeDir: string,
  question: string,
  limit = 6,
): Promise<ExternalKnowledgeItem[]> {
  const q = question.trim().toLowerCase();
  if (!q) return [];
  const rawTokens = q.split(/[\s,，。？！?!;；:：、/\\()（）\[\]【】]+/).filter((t) => t.length >= 2);
  const tokens = new Set<string>(rawTokens);
  for (const tk of rawTokens) {
    if (/[\u4e00-\u9fa5]{3,}/.test(tk)) {
      for (let i = 0; i <= tk.length - 2; i++) tokens.add(tk.slice(i, i + 2));
    }
  }
  const tokenList = [...tokens];

  const scoreText = (title: string, body: string) => {
    const tLow = title.toLowerCase();
    const bLow = body.toLowerCase();
    let score = 0;
    if (tLow.includes(q)) score += 12;
    if (bLow.includes(q)) score += 8;
    for (const tk of tokenList) {
      if (tLow.includes(tk)) score += 4;
      if (bLow.includes(tk)) score += 2;
    }
    return score;
  };

  const extractBestSnippet = (body: string, maxLen = 1400) => {
    const lines = body.split(/\r?\n/);
    let bestIdx = 0;
    let bestHits = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      let hits = 0;
      for (const tk of tokenList) if (l.includes(tk)) hits++;
      if (hits > bestHits) { bestHits = hits; bestIdx = i; }
    }
    const slice = lines.slice(Math.max(0, bestIdx - 4), Math.max(0, bestIdx - 4) + 35).join('\n');
    return slice.length > maxLen ? `${slice.slice(0, maxLen)}…` : slice;
  };

  const candidates: ExternalKnowledgeItem[] = [];
  for (const doc of await collectKnowledgeDocuments(dshHomeDir)) {
    const score = scoreText(doc.title, doc.body);
    if (score > 0) {
      candidates.push({
        meetingId: doc.id,
        sourceType: 'knowledge',
        title: `[知识库] ${doc.title}`,
        startedAt: doc.mtimeMs,
        atMs: null,
        text: extractBestSnippet(doc.body),
        score,
        contentHash: doc.contentHash,
      });
    }
  }

  for (const { prefix, dir: smDir } of [
    { prefix: 'sm:', dir: join(homedir(), '.dsh', 'soulmirror') },
    { prefix: 'smhome:', dir: join(dshHomeDir, 'soulmirror') },
  ]) {
    if (!existsSync(smDir)) continue;
    try {
      for (const e of await readdir(smDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const minPath = join(smDir, e.name, 'minutes.md');
        const trPath = join(smDir, e.name, 'transcript.jsonl');
        if (!existsSync(minPath) && !existsSync(trPath)) continue;
        let combined = '';
        if (existsSync(minPath)) try { combined += `${await readFile(minPath, 'utf8')}\n\n`; } catch {}
        if (existsSync(trPath)) {
          try {
            const raw = await readFile(trPath, 'utf8');
            combined += raw.split(/\r?\n/).map((l) => {
              if (!l.trim().startsWith('{')) return '';
              try { const o = JSON.parse(l); return o.text ? `${o.speaker || o.who || '参会者'}: ${o.text}` : ''; } catch { return ''; }
            }).filter(Boolean).join('\n');
          } catch {}
        }
        if (!combined.trim()) continue;
        const score = scoreText(e.name, combined);
        if (score > 0) {
          const parsedTs = Date.parse(e.name.slice(0, 19).replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3')) || Date.parse(e.name.slice(0, 10)) || Date.now();
          candidates.push({
            meetingId: `${prefix}${e.name}`,
            sourceType: 'soulmirror',
            title: `[Soulmirror] ${e.name}`,
            startedAt: parsedTs,
            atMs: null,
            text: extractBestSnippet(combined),
            score,
            contentHash: createHash('sha256').update(combined, 'utf8').digest('hex').slice(0, 12),
          });
        }
      }
    } catch {}
  }

  return candidates.sort((a, b) => b.score - a.score || b.startedAt - a.startedAt).slice(0, limit);
}

