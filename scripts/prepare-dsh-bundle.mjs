/**
 * 打包前置脚本：组装自包含的 Windows DSH 运行时与全部 5 个会议插件到 app/resources/dsh-bundle/
 *
 * 目录结构（利用 Node.js 原生向上解析，零重复依赖、零符号链接）：
 *   app/resources/dsh-bundle/
 *     node.exe
 *     node_modules/            <- @deepseek-ai/dsh 的完整依赖
 *     dsh/
 *       package.json
 *       lib/
 *     profile-template/
 *       package.json
 *       cordis.yml
 *       cordis.patch.yml       <- 干净模板（不含本机路径与个人凭证）
 *       node_modules/
 *         @copylee/dsh-computer-use/
 *         dsh-knowledge/
 *         dsh-meeting-host/
 *         dsh-plugin-tencent-meeting/
 *         soulmirror/
 *     soulmirror/
 *       uimap.json
 */
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const root = resolve('.');
const appResources = join(root, 'app', 'resources');
const bundleDir = join(appResources, 'dsh-bundle');

const nodeExe = process.env.NODE_BIN || (existsSync('E:\\NodeJS\\node.exe') ? 'E:\\NodeJS\\node.exe' : process.execPath);
const dshPkgDir = resolve(
  process.env.DSH_PKG_DIR || 'E:\\NodeJS\\node_global\\node_modules\\@deepseek-ai\\dsh',
);
const meetingProfile = join(root, '.dsh-home', 'profiles', 'meeting');

if (!existsSync(nodeExe)) throw new Error(`未找到 node.exe: ${nodeExe}`);
if (!existsSync(join(dshPkgDir, 'lib', 'bin.js'))) throw new Error(`未找到 DSH CLI: ${dshPkgDir}`);

console.log('[bundle] 清理旧的 dsh-bundle 目录...');
rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(join(bundleDir, 'dsh'), { recursive: true });
mkdirSync(join(bundleDir, 'profile-template', 'node_modules', '@copylee'), { recursive: true });
mkdirSync(join(bundleDir, 'soulmirror'), { recursive: true });

// 确保 electron-builder extraResources 声明的目录存在
for (const dir of ['bin', 'vad', 'dict']) {
  mkdirSync(join(appResources, dir), { recursive: true });
}

// 1. 复制 node.exe
console.log('[bundle] 复制 Node.js 运行时...');
copyFileSync(nodeExe, join(bundleDir, 'node.exe'));

// 2. 复制 @deepseek-ai/dsh 核心代码与 node_modules
console.log('[bundle] 复制 @deepseek-ai/dsh 核心与依赖...');
copyFileSync(join(dshPkgDir, 'package.json'), join(bundleDir, 'dsh', 'package.json'));
cpSync(join(dshPkgDir, 'lib'), join(bundleDir, 'dsh', 'lib'), {
  recursive: true,
  dereference: true,
  filter: (src) => !/[\\/](?:\.git|tests?)[\\/]?$/i.test(src) && !src.endsWith('.map'),
});
cpSync(join(dshPkgDir, 'node_modules'), join(bundleDir, 'node_modules'), {
  recursive: true,
  dereference: true,
  filter: (src) => !/[\\/](?:\.git)[\\/]?$/i.test(src) && !src.endsWith('.map'),
});

// 3. 写入干净的 meeting Profile 配置模板（不含个人凭证、不含本机硬编码路径）
const profilePackageJson = {
  name: 'dsh-profile-meeting',
  private: true,
  dependencies: {
    '@copylee/dsh-computer-use': '^0.8.0',
    'dsh-knowledge': '^1.0.0',
    'dsh-meeting-host': '^1.0.0',
    'dsh-plugin-tencent-meeting': '^1.0.0',
    soulmirror: '^1.0.0',
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        'dsh-knowledge',
        'soulmirror',
        '@copylee/dsh-computer-use',
        'dsh-plugin-tencent-meeting',
        'dsh-meeting-host',
      ],
    },
  },
};
writeFileSync(
  join(bundleDir, 'profile-template', 'package.json'),
  JSON.stringify(profilePackageJson, null, 2) + '\n',
  'utf8',
);
writeFileSync(join(bundleDir, 'profile-template', 'cordis.yml'), '[]\n', 'utf8');

const cleanPatchYml = `# 内置 DSH 会议助手默认 Profile 配置（安装后只需在软件设置中填写模型 API Key 即可直接使用）
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      bailian:
        apiKeyEnv: DASHSCOPE_API_KEY
        api: openai-completions
        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
        models:
          - id: qwen3.5-plus
            name: qwen3.5-plus
            input:
              - text
              - image
            contextWindow: 131072
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: danger-full-access
- id: dsh-meeting-host
  name: "dsh-meeting-host"
  config:
    path: /api/dsh-meeting
    artifactsDir: ""
    schedulesFile: ""
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
`;
writeFileSync(join(bundleDir, 'profile-template', 'cordis.patch.yml'), cleanPatchYml, 'utf8');

// 4. 复制全部 5 个插件（解引用真实文件，剔除 .git / 体积庞大的离线 whisper 模型 / 符号链接 node_modules）
const nmTarget = join(bundleDir, 'profile-template', 'node_modules');

function resolveReal(p) {
  return existsSync(p) ? realpathSync(p) : '';
}

console.log('[bundle] 复制插件: dsh-meeting-host...');
cpSync(join(root, 'dsh-plugin'), join(nmTarget, 'dsh-meeting-host'), {
  recursive: true,
  dereference: true,
  filter: (src) => !/[\\/](?:\.git|node_modules)[\\/]?$/i.test(src),
});

const computerUseSrc = resolveReal(join(meetingProfile, 'node_modules', '@copylee', 'dsh-computer-use'));
if (!computerUseSrc) throw new Error('未找到 @copylee/dsh-computer-use 插件');
console.log('[bundle] 复制插件: @copylee/dsh-computer-use...');
cpSync(computerUseSrc, join(nmTarget, '@copylee', 'dsh-computer-use'), {
  recursive: true,
  dereference: true,
  filter: (src) => !/[\\/](?:\.git|tests?)[\\/]?$/i.test(src),
});

const tencentSrc = resolveReal(join(meetingProfile, 'plugins', 'dsh-plugin-tencent-meeting'));
if (!tencentSrc) throw new Error('未找到 dsh-plugin-tencent-meeting 插件');
console.log('[bundle] 复制插件: dsh-plugin-tencent-meeting...');
cpSync(tencentSrc, join(nmTarget, 'dsh-plugin-tencent-meeting'), {
  recursive: true,
  dereference: true,
  filter: (src) => !/[\\/](?:\.git|tests?)[\\/]?$/i.test(src),
});

const soulmirrorSrc = resolveReal(join(meetingProfile, 'plugins', 'soulmirror'));
if (!soulmirrorSrc) throw new Error('未找到 soulmirror 插件');
console.log('[bundle] 复制插件: soulmirror（保留 mbridge.exe 与 ui.ps1，跳过 whisper 离线模型与重复 node_modules 软链）...');
cpSync(soulmirrorSrc, join(nmTarget, 'soulmirror'), {
  recursive: true,
  dereference: true,
  filter: (src) => {
    const rel = src.slice(soulmirrorSrc.length).replace(/\\/g, '/');
    if (/^\/(?:\.git|node_modules|tests|docs|tools\/whisper)(?:\/|$)/i.test(rel)) return false;
    if (rel.endsWith('.bak')) return false;
    return true;
  },
});

// 同步一份 mbridge.exe 到 app/resources/bin/ 兜底
const mbridgeSrc = join(nmTarget, 'soulmirror', 'tools', 'mbridge.exe');
if (existsSync(mbridgeSrc)) {
  copyFileSync(mbridgeSrc, join(appResources, 'bin', 'mbridge.exe'));
}

const knowledgeSrc = resolveReal(join(meetingProfile, 'plugins', 'dsh-knowledge'));
if (!knowledgeSrc) throw new Error('未找到 dsh-knowledge 插件');
console.log('[bundle] 复制插件: dsh-knowledge...');
cpSync(knowledgeSrc, join(nmTarget, 'dsh-knowledge'), {
  recursive: true,
  dereference: true,
  filter: (src) => {
    const rel = src.slice(knowledgeSrc.length).replace(/\\/g, '/');
    if (/^\/(?:\.git|test|docs|worklog|scripts)(?:\/|$)/i.test(rel)) return false;
    if (src.endsWith('.map')) return false;
    return true;
  },
});

// 5. 复制预校准的腾讯会议按钮坐标（uimap.json）
const uiMapCandidates = [
  join(root, '.dsh-home', 'soulmirror', 'uimap.json'),
  join(homedir(), '.dsh', 'soulmirror', 'uimap.json'),
];
const uiMapSrc = uiMapCandidates.find((p) => existsSync(p));
if (uiMapSrc) {
  copyFileSync(uiMapSrc, join(bundleDir, 'soulmirror', 'uimap.json'));
}

console.log('[bundle] 全部内置运行时与 5 个插件打包准备完成 ->', bundleDir);
