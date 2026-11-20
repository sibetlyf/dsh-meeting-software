# DSH 会议助手 (Yogurt + DSH Embedded)

基于 Electron + React 19 与内置 DSH（DeepSeek Harness）`meeting` Profile 深度融合的全自动 AI 会议助手桌面软件。

## 开箱即用（Windows）

从本仓库 **Releases** 下载 `Yogurt-windows-x64.exe`，双击即可直接运行。

安装包已完整内置以下运行时与全部 5 个核心插件，**无需提前安装 Node.js 或 DSH CLI**：
- 内置 `Node.js` 运行时与 `@deepseek-ai/dsh` 核心
- `soulmirror`（会议窗口自动化、双轨 WASAPI 录音采集 `mbridge.exe`、实时转写、会后精转与纪要）
- `dsh-knowledge`（本地知识库检索与会后自动归档）
- `@copylee/dsh-computer-use`（桌面 UI 视觉定位与快速会议发起）
- `dsh-plugin-tencent-meeting`（腾讯会议生态能力）
- `dsh-meeting-host`（日程调度、事件流 SSE 推送、DSH 会话桥接）

### 首次使用配置
1. 启动软件后，进入左侧 **设置**（Settings）。
2. 填写你的大模型 / 百炼（DashScope）API Key 并保存，即可开始：
   - **今日日程**：自然语言或表单预约腾讯会议 / 移动云会议，到点由 DSH 自动拉起并入会、进入笔记页自动开启双轨录音与实时字幕。
   - **知识库**：统一检索历史会议纪要、`dsh-knowledge` 文档与 `Soulmirror` 会议归档。
   - **会后全自动整理**：会议结束后自动精转、提取纪要并同步归档。

## 从源码开发与打包

```powershell
pnpm install
pnpm build
pnpm start
```

构建自包含 Windows 可执行程序（自动组装 Node.js + DSH + 全部 5 个插件）：
```powershell
pnpm pack:win
```
产物位于 `app/dist/Yogurt-windows-x64.exe`。
