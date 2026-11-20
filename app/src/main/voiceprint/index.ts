/**
 * 本地 ONNX 声纹识别与说话人标注引擎 (voiceprint/index.ts)
 *
 * 复用 DSH soulmirror 插件的 CAM++ / WeSpeaker ONNX 声纹能力：
 * - 麦克风轨 (track: 'me') 固定标注为 "我 (本人)"
 * - 扬声器轨 (track: 'them') 按时间切片提取声纹向量，与 ~/.dsh/soulmirror/voiceprint/library.json 比对余弦相似度
 * - 命中已注册人员时标注真实姓名；未命中时基于局部余弦相似度聚类为 "发言人 1"、"发言人 2"
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDshHome } from '../dsh/dshBridge';
import type { AsrSentence } from '../asr/bailianProvider';

export interface LabeledSentence extends AsrSentence {
  speaker: string;
  confidence?: number;
}

function resolveSoulmirrorRoot(): string | null {
  const dshHome = getDshHome();
  const candidates = [
    join(dshHome, 'profiles', 'meeting', 'plugins', 'soulmirror'),
    join(dshHome, 'profiles', 'web', 'plugins', 'soulmirror'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'lib', 'voiceprint', 'service.js'))) return dir;
  }
  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** 从 16kHz 16-bit WAV 中裁剪指定时间段 [startMs, endMs] 的 Float32 采样 */
function sliceWavSamples(wavBuf: Buffer, startMs: number, endMs: number): Float32Array {
  const headerSize = wavBuf.length > 44 && wavBuf.subarray(0, 4).toString('ascii') === 'RIFF' ? 44 : 0;
  const sampleRate = 16000;
  const startSample = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
  const endSample = Math.max(startSample + sampleRate * 0.4, Math.floor((endMs / 1000) * sampleRate));
  const startByte = headerSize + startSample * 2;
  const endByte = Math.min(wavBuf.length, headerSize + endSample * 2);

  const count = Math.max(0, Math.floor((endByte - startByte) / 2));
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = wavBuf.readInt16LE(startByte + i * 2) / 32768;
  }
  return out;
}

/**
 * 对会后重新转写出的语句列表进行声纹识别与说话人标注
 */
export async function labelSpeakersWithVoiceprint(
  wavPath: string,
  sentences: AsrSentence[],
  threshold = 0.72,
): Promise<{ sentences: LabeledSentence[]; speakers: string[] }> {
  if (!sentences.length) return { sentences: [], speakers: [] };

  const smRoot = resolveSoulmirrorRoot();
  const wavBuf = existsSync(wavPath) ? await readFile(wavPath) : null;

  let extractEmbedding: ((samples: Float32Array, sampleRate: number) => Promise<number[] | null>) | null = null;
  let enrolledList: Array<{ name: string; embedding: number[] }> = [];

  if (smRoot && wavBuf) {
    try {
      const embedMod = await import(pathToFileURL(join(smRoot, 'lib', 'voiceprint', 'embed.js')).href);
      const storeMod = await import(pathToFileURL(join(smRoot, 'lib', 'voiceprint', 'store.js')).href);
      if (typeof embedMod.extractVoiceprintEmbedding === 'function') {
        extractEmbedding = embedMod.extractVoiceprintEmbedding;
      } else if (typeof embedMod.computeEmbedding === 'function') {
        extractEmbedding = embedMod.computeEmbedding;
      }

      if (typeof storeMod.loadLibrary === 'function') {
        const lib = await storeMod.loadLibrary();
        enrolledList = Array.isArray(lib?.speakers) ? lib.speakers : [];
      }
    } catch (err) {
      console.warn('[voiceprint] 加载 soulmirror 声纹引擎失败，降级使用基础双轨标注:', err);
    }
  }

  const clusters: Array<{ label: string; centroid: number[] }> = [];
  const speakerSet = new Set<string>();
  const labeled: LabeledSentence[] = [];

  for (const s of sentences) {
    if (s.track === 'me') {
      const speaker = '我 (本人)';
      speakerSet.add(speaker);
      labeled.push({ ...s, speaker, confidence: 1.0 });
      continue;
    }

    let speaker = '参会者';
    let confidence = 0;

    if (extractEmbedding && wavBuf) {
      try {
        const samples = sliceWavSamples(wavBuf, s.startMs, s.endMs);
        if (samples.length >= 6400) {
          const emb = await extractEmbedding(samples, 16000);
          if (emb && emb.length > 0) {
            // 1. 先与已注册声纹库比对
            let bestName = '';
            let bestSim = -1;
            for (const person of enrolledList) {
              if (!Array.isArray(person.embedding)) continue;
              const sim = cosineSimilarity(emb, person.embedding);
              if (sim > bestSim) {
                bestSim = sim;
                bestName = person.name;
              }
            }

            if (bestSim >= threshold && bestName) {
              speaker = bestName;
              confidence = Number(bestSim.toFixed(3));
            } else {
              // 2. 未命中声纹库时，在本次会议中进行未知说话人聚类
              let matchedCluster = -1;
              let clusterSim = -1;
              for (let i = 0; i < clusters.length; i++) {
                const sim = cosineSimilarity(emb, clusters[i].centroid);
                if (sim > clusterSim) {
                  clusterSim = sim;
                  matchedCluster = i;
                }
              }
              if (matchedCluster >= 0 && clusterSim >= threshold) {
                speaker = clusters[matchedCluster].label;
                confidence = Number(clusterSim.toFixed(3));
              } else {
                const label = `发言人 ${clusters.length + 1}`;
                clusters.push({ label, centroid: emb });
                speaker = label;
                confidence = 1.0;
              }
            }
          }
        }
      } catch {
        // 单段提取失败时回退默认名称
      }
    }

    speakerSet.add(speaker);
    labeled.push({ ...s, speaker, confidence });
  }

  return {
    sentences: labeled,
    speakers: Array.from(speakerSet),
  };
}

