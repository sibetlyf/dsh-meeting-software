/**
 * 基于 soulmirror mbridge.exe 的 Windows WASAPI 双轨音频采集适配器 (mbridgeCapture.ts)
 *
 * 当未本地编译 Rust yogurt-audio-win.exe 时，自动使用内置的 mbridge.exe：
 * - device 模式：采集本地麦克风 ('me')
 * - loopback 模式：采集系统扬声器输出 ('them')
 * 输出标准 16kHz Float32 PCM 事件与实时电平 ('level')，并同步落盘为 me.wav / them.wav。
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, openSync, writeSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { tell, type Track } from './capture';
import { getDshHome } from './dsh/dshBridge';

export function listMbridgeMics(): Promise<Array<{ id: string; name: string; isDefault: boolean }>> {
  const exe = findMbridgeExe();
  if (!exe) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(exe, ['devices'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const mics: Array<{ id: string; name: string; isDefault: boolean }> = [];
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.split('\t');
        if (parts[0] === 'CAPTURE' && parts.length >= 3) {
          const idx = parts[1].trim();
          const name = parts[2].trim();
          const isRealMic = !/CABLE|Virtual|虚拟音频/i.test(name);
          mics.push({ id: idx, name, isDefault: isRealMic && mics.every((m) => !m.isDefault) });
        }
      }
      if (mics.length > 0 && mics.every((m) => !m.isDefault)) mics[0].isDefault = true;
      resolve(mics);
    });
  });
}

export function findMbridgeExe(): string | null {
  const resPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const dshHome = getDshHome();
  const candidates = [
    process.env.MBRIDGE_EXE,
    resPath ? join(resPath, 'dsh-bundle', 'profile-template', 'node_modules', 'soulmirror', 'tools', 'mbridge.exe') : '',
    resPath ? join(resPath, 'bin', 'mbridge.exe') : '',
    join(dshHome, 'profiles', 'meeting', 'node_modules', 'soulmirror', 'tools', 'mbridge.exe'),
    join(dshHome, 'profiles', 'meeting', 'plugins', 'soulmirror', 'tools', 'mbridge.exe'),
    join(homedir(), '.dsh', 'profiles', 'web', 'plugins', 'soulmirror', 'tools', 'mbridge.exe'),
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function writeWavHeader(fd: number, dataBytes: number, sampleRate = 16000) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  writeSync(fd, buf, 0, 44, 0);
}

export class MbridgeCapture extends EventEmitter {
  private procs: ChildProcess[] = [];
  private fds: Record<Track, { fd: number; bytes: number } | null> = { me: null, them: null };
  private levels: Record<Track, number> = { me: 0, them: 0 };
  private levelTimer: NodeJS.Timeout | null = null;
  private paused = false;
  private stopped = false;
  private startedAt = Date.now();
  private end = 0;

  constructor(private meetingDir: string, private mbridgeExe: string, private startMsOffset = 0) {
    super();
    mkdirSync(meetingDir, { recursive: true });
    this.end = startMsOffset;
    this.startTrack('me', 'device');
    this.startTrack('them', 'loopback');
    queueMicrotask(() => this.emit('mic', { uid: null, name: '系统默认麦克风 (WASAPI)' }));
    this.levelTimer = setInterval(() => {
      if (this.stopped || this.paused) return;
      tell({ t: 'level', me: this.levels.me, them: this.levels.them });
      this.emit('level', { me: this.levels.me, them: this.levels.them });
      this.levels.me *= 0.4;
      this.levels.them *= 0.4;
    }, 100);
  }

  get endMs(): number {
    return Math.round(this.end);
  }

  private startTrack(track: Track, mode: 'device' | 'loopback') {
    const wavPath = join(this.meetingDir, `${track}.wav`);
    let existingBytes = 0;
    let fd: number;
    if (this.startMsOffset > 0 && existsSync(wavPath)) {
      const sz = statSync(wavPath).size;
      existingBytes = Math.max(0, sz - 44);
      fd = openSync(wavPath, 'r+');
    } else {
      fd = openSync(wavPath, 'w');
      writeWavHeader(fd, 0);
    }
    this.fds[track] = { fd, bytes: existingBytes };

    const proc = spawn(this.mbridgeExe, ['capture-stream', '--mode', mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (this.stopped || this.paused || !chunk.length) return;
      const evenLen = chunk.length - (chunk.length % 2);
      if (evenLen <= 0) return;
      const aligned = chunk.subarray(0, evenLen);

      const entry = this.fds[track];
      if (entry) {
        try {
          writeSync(entry.fd, aligned, 0, aligned.length, 44 + entry.bytes);
          entry.bytes += aligned.length;
        } catch {}
      }

      const sampleCount = evenLen / 2;
      const samples = new Float32Array(sampleCount);
      let sumSq = 0;
      for (let i = 0; i < sampleCount; i++) {
        const s = aligned.readInt16LE(i * 2) / 32768;
        samples[i] = s;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / sampleCount);
      this.levels[track] = Math.min(1, rms * 5);

      const ms = this.startMsOffset + (Date.now() - this.startedAt);
      this.end = Math.max(this.end, ms);
      this.emit('pcm', track, ms, samples);
    });

    proc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString('utf8').trim();
      if (msg) console.warn(`[mbridge][${track}]`, msg);
    });

    this.procs.push(proc);
  }

  pause(): boolean {
    this.paused = true;
    return true;
  }

  resume(): boolean {
    this.paused = false;
    return true;
  }

  setMic(): boolean {
    return true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    for (const p of this.procs) {
      try {
        if (!p.killed) p.kill();
      } catch {}
    }
    for (const track of ['me', 'them'] as const) {
      const entry = this.fds[track];
      if (entry) {
        try {
          writeWavHeader(entry.fd, entry.bytes);
          closeSync(entry.fd);
        } catch {}
        this.fds[track] = null;
      }
    }
    this.emit('exit', 0, null);
  }
}

