/**
 * 只追加会议事件日志引擎 (meetingLogStore.ts)
 *
 * 职责：
 * 1. 管理本地 JSONL 只追加日志流（schedule.jsonl 与 meetings/<id>.jsonl），实现「先入日志，再可见」；
 * 2. 将旧版 meeting-schedules.json 一次性幂等导入为 schedule/created 事件，消除双写覆盖问题；
 * 3. 提供内存写队列 + 落盘屏障 flush()，并在开发/测试期运行不变量检查。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  foldMeetingLifecycle,
  foldSchedules,
  verifyStreamInvariants,
  type MeetingLogEnvelope,
  type MeetingLogSource,
  type ProjectedMeetingLifecycle,
  type ProjectedSchedule,
} from '../../shared/meetingLog';

export class MeetingLogStore {
  private readonly logRoot: string;
  private readonly cache = new Map<string, MeetingLogEnvelope[]>();
  private writeChain: Promise<void> = Promise.resolve();
  private legacyMigrated = false;

  constructor(logRoot: string) {
    this.logRoot = logRoot;
  }

  private streamFile(stream: string): string {
    if (stream === 'schedule') return join(this.logRoot, 'schedule.jsonl');
    const safe = stream.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return join(this.logRoot, 'streams', `${safe}.jsonl`);
  }

  async readStream(stream: string): Promise<MeetingLogEnvelope[]> {
    const cached = this.cache.get(stream);
    if (cached) return [...cached];

    const file = this.streamFile(stream);
    const events: MeetingLogEnvelope[] = [];
    if (existsSync(file)) {
      const raw = await readFile(file, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          events.push(JSON.parse(trimmed) as MeetingLogEnvelope);
        } catch (err) {
          console.warn(`[log] 跳过损坏的日志行 (${stream}):`, err);
        }
      }
    }

    const violations = verifyStreamInvariants(events);
    if (violations.length > 0) {
      console.warn(`[log] 流 ${stream} 检测到 ${violations.length} 条不变量告警:`, violations[0]);
    }
    this.cache.set(stream, events);
    return [...events];
  }

  async append<T extends string, D extends Record<string, unknown>>(
    stream: string,
    type: T,
    data: D,
    source: MeetingLogSource = 'yogurt',
    cause?: string,
  ): Promise<MeetingLogEnvelope<T, D>> {
    let created!: MeetingLogEnvelope<T, D>;
    const write = this.writeChain.then(async () => {
      const events = await this.readStream(stream);
      const nextSeq = events.length > 0 ? events[events.length - 1].seq + 1 : 1;
      created = {
        seq: nextSeq,
        at: new Date().toISOString(),
        stream,
        source,
        ...(cause ? { cause } : {}),
        type,
        data,
        v: 1,
      };
      const file = this.streamFile(stream);
      await mkdir(join(file, '..'), { recursive: true });
      await appendFile(file, `${JSON.stringify(created)}\n`, 'utf8');
      events.push(created);
      this.cache.set(stream, events);
    });
    this.writeChain = write.catch(() => {});
    await write;
    return created;
  }

  /** 显式落盘屏障：确保此前所有追加事件已完成磁盘写入 */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** 将 meeting-schedules.json 中新增的日程（如 DSH Agent 工具写入的日程）幂等同步进 schedule 事件流 */
  async ensureLegacySchedulesImported(legacyPaths: string[]): Promise<void> {
    const existing = await this.readStream('schedule');
    const knownIds = new Set(existing.map((e) => String((e.data as any)?.id || '')).filter(Boolean));

    for (const p of legacyPaths) {
      if (!existsSync(p)) continue;
      try {
        const arr = JSON.parse(await readFile(p, 'utf8'));
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (!item?.id || knownIds.has(item.id)) continue;
          knownIds.add(item.id);
          await this.append(
            'schedule',
            'schedule/created',
            {
              id: String(item.id),
              title: String(item.title || '未命名会议'),
              platform: String(item.platform || 'tencent'),
              meetingCode: String(item.meetingCode || ''),
              meetingUrl: String(item.meetingUrl || ''),
              cron: item.cron || null,
              runAt: item.runAt || null,
              autoRecord: item.autoRecord !== false,
              mode: item.mode === 'quick' ? 'quick' : 'join',
            },
            'import',
          );
          if (item.enabled === false) {
            await this.append('schedule', 'schedule/paused', { id: String(item.id) }, 'import');
          }
          if (item.triggeredAt) {
            await this.append(
              'schedule',
              'schedule/triggered',
              { id: String(item.id), triggeredAt: String(item.triggeredAt) },
              'import',
            );
          }
        }
      } catch (err) {
        console.warn(`[log] 导入旧日程文件失败 (${p}):`, err);
      }
    }
  }

  async getProjectedSchedules(legacyPaths: string[] = []): Promise<ProjectedSchedule[]> {
    await this.ensureLegacySchedulesImported(legacyPaths);
    const events = await this.readStream('schedule');
    return foldSchedules(events);
  }

  /** 把当前日程投影快照同步写回兼容 JSON（过渡期供外部脚本读取，不再作为事实源） */
  async syncScheduleProjectionSnapshot(targetPaths: string[]): Promise<void> {
    const events = await this.readStream('schedule');
    const projected = foldSchedules(events).filter(s => !s.detected).map((s) => ({
      id: s.id,
      title: s.title,
      cron: s.cron,
      runAt: s.runAt,
      platform: s.platformRaw,
      meetingCode: s.meetingCode,
      meetingUrl: s.meetingUrl,
      autoRecord: s.autoRecord,
      mode: s.mode,
      enabled: s.enabled,
      createdAt: s.createdAt,
      ...(s.triggeredAt ? { triggeredAt: s.triggeredAt } : {}),
    }));
    const payload = JSON.stringify(projected, null, 2);
    for (const p of targetPaths) {
      try {
        await mkdir(join(p, '..'), { recursive: true });
        await writeFile(p, payload, 'utf8');
      } catch {}
    }
  }

  async getProjectedLifecycle(meetingId: string): Promise<ProjectedMeetingLifecycle> {
    const events = await this.readStream(`meeting:${meetingId}`);
    return foldMeetingLifecycle(meetingId, events);
  }
}

