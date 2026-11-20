/**
 * DSH 会议助手宿主插件 (dsh-meeting-host)
 *
 * 100% 原生运行在 DSH Cordis 运行时内：
 * 1. 通过 ctx.tools.register 注册会议调度、腾讯/移动会议入会、制品查询工具
 * 2. 通过 ctx.webServer.register 注册 /api/dsh-meeting/* 前缀路由
 * 3. /v1/copilot/chat 100% 驱动真实 DSH sessionController（在 DSH Web 对话列表与制品栏同步留痕）
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { quickMeetingPrompt, readDesktopResult, readTencentQuickRoom } from './desktop-access.mjs';

export const name = 'dsh-meeting-host';
export const inject = ['tools', 'webServer'];

export const Config = z.object({
	path: z.string().default('/api/dsh-meeting'),
	artifactsDir: z.string().default(''),
	schedulesFile: z.string().default(''),
});

function resolveDshHome() {
	return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
}

function resolveArtifactsDir(config) {
	if (config.artifactsDir && config.artifactsDir.trim()) return config.artifactsDir.trim();
	return join(resolveDshHome(), 'artifacts', 'meetings');
}

function resolveSchedulesFile(config) {
	if (config.schedulesFile && config.schedulesFile.trim()) return config.schedulesFile.trim();
	return join(resolveDshHome(), 'meeting-schedules.json');
}

async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString('utf8').trim();
	return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, data) {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.end(JSON.stringify(data));
}

const TOOL_OUTPUT = {
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			ok: { type: 'boolean' },
			result: { type: 'string' },
			data: { type: 'object', additionalProperties: true },
		},
		required: ['ok', 'result'],
	},
	render: (_args, value) => [{ type: 'text', text: String(value.result ?? '') }],
};

const recentJoins = new Map();

/** 统一通过 DSH sessionController 创建会话，由 DSH Agent 调用 soulmirror 插件工具（meeting_join / meeting_open / meeting_ui）完成入会 */
async function delegateJoinToSoulmirror(ctx, { platform = 'tencent', meetingCode = '', meetingUrl = '', title = '', desktopQuick = false, onRoom }) {
	const appName = platform === 'chinamobile' ? '移动会议' : '腾讯会议';
	const cleanCode = String(meetingCode || '').trim();
	const rawUrl = String(meetingUrl || '').trim();
	const dedupKey = `${platform}:${cleanCode}:${rawUrl}:${desktopQuick}`;

	const existing = recentJoins.get(dedupKey);
	if (existing && Date.now() - existing.at < 15_000) {
		return existing.promise;
	}

	const promise = (async () => {
		const controller = ctx.get('sessionController');
		if (!controller || typeof controller.create !== 'function') {
			return { ok: false, error: 'DSH sessionController 尚未就绪' };
		}

		const sessionTitle = title ? `入会 · ${title}` : `${appName}自动入会`;
		const created = await controller.create({ cwd: process.cwd() });
		const sessionId = created?.sessionId || created?.id;
		if (!sessionId) {
			return { ok: false, error: '创建 DSH 会话失败' };
		}
		await controller.rename?.({ sessionId, title: sessionTitle }).catch(() => {});

		const promptText = desktopQuick
			? quickMeetingPrompt(platform)
			: cleanCode || rawUrl
			? `请立即调用 soulmirror 插件的 meeting_join 工具加入${appName}（参数：${cleanCode ? `code="${cleanCode}", ` : ''}${rawUrl ? `url="${rawUrl}", ` : ''}app="${appName}", confirm=true），随后调用 meeting_auto(action="start") 开启自动监听。执行完成后直接简短回复结果，不要反问。`
			: `请立即调用 soulmirror 插件的 meeting_open(app="${appName}") 启动客户端，随后调用 meeting_ui 工具点击“快速会议”或“发起会议”开启一场新会议，并调用 meeting_auto(action="start") 开启自动监听。执行完成后直接简短回复结果，不要反问。`;

		let finalText = '';
		let errorText = '';
		let toolResultText = '';
		let toolExplicitOk = null;
		let quickClickSucceeded = false;
		let quickPermissionDenied = false;
		const desktopCalls = new Map();
		const observedRoom = {};
		const debug = [];
		const addDebug = (stage, detail) => {
			if (desktopQuick && debug.length < 80) debug.push({ at: Date.now(), stage, detail });
		};
		const visibleTools = new Set(['request_access', 'open_application', 'windows', 'ui_elements', 'screen_observe', 'app_launch', 'computer', 'computer_click', 'computer_batch']);
		addDebug('创建 DSH 会话', sessionId);
		let ourTurn = 0;
		const toolsUsed = [];
		let settle;
		const donePromise = new Promise((r) => { settle = r; });

		const off = typeof ctx.on === 'function'
			? ctx.on('session/event', (sess, event) => {
				const sid = String(sess?.id ?? sess?.sessionId ?? '');
				if (sid !== sessionId) return;
				const type = String(event?.type ?? '');
				const data = event?.data ?? {};
				if (type === 'turn/start') {
					ourTurn = Number(data?.turn ?? 0) || ourTurn;
				} else if (type === 'tool/call') {
					if (data?.name) toolsUsed.push(String(data.name));
					if (desktopQuick && data?.callId && visibleTools.has(data.name)) {
						desktopCalls.set(data.callId, { name: data.name });
						addDebug('调用 ' + data.name);
					}
				} else if (type === 'tool/result') {
					const out = data?.output ?? data?.result ?? {};
					if (typeof out?.ok === 'boolean' && (data?.name === 'meeting_join' || data?.name === 'meeting_open')) {
						toolExplicitOk = out.ok;
					}
					if (desktopQuick) {
						const { denied, clicked } = readDesktopResult(data, desktopCalls);
						const call = desktopCalls.get(data?.callId ?? data?.message?.toolCallId ?? data?.message?.source?.callId);
						const name = call?.name ?? data?.name;
						if (visibleTools.has(name)) {
							const failed = data?.message?.isError === true || out?.ok === false;
							addDebug(name + ' 返回', denied ? '权限被拒绝' : clicked ? '点击已发送' : failed ? '工具报错' : '已收到回执');
						}
						if (denied) quickPermissionDenied = true;
						if (clicked) { quickClickSucceeded = true; quickPermissionDenied = false; }
						if (onRoom && platform === 'tencent' && quickClickSucceeded && !quickPermissionDenied) {
							const room = readTencentQuickRoom(data, desktopCalls, observedRoom);
							if (room) onRoom(room, debug.slice());
						}
					}
					if (typeof out?.result === 'string' && out.result.trim()) {
						toolResultText = out.result.trim();
					}
				} else if (type === 'assistant/message') {
					const content = data?.message?.content;
					if (typeof content === 'string' && content.trim()) {
						finalText = content.trim();
					} else if (Array.isArray(content)) {
						const t = content
							.filter((p) => typeof p === 'string' || p?.type === 'text' || p?.type === 'output_text')
							.map((p) => (typeof p === 'string' ? p : p?.text || ''))
							.join('')
							.trim();
						if (t) finalText = t;
					}
				} else if (type === 'turn/end') {
					const turn = Number(data?.turn ?? 0);
					if (ourTurn && turn && turn !== ourTurn) return;
					const kind = data?.reason?.kind;
					if (kind === 'error') {
						errorText = String(data?.reason?.error?.message || data?.reason?.message || '模型执行失败');
					}
					settle({ kind: kind || 'completed' });
				}
			})
			: () => {};

		const ac = new AbortController();
		const timer = setTimeout(() => {
			try { ac.abort(); } catch {}
			settle({ kind: 'timeout' });
		}, onRoom ? 110_000 : 45_000);

		try {
			const prompting = controller.prompt(
				{
					requestId: randomUUID(),
					sessionId,
					mode: 'queue',
					content: [{ type: 'text', text: promptText }],
				},
				ac.signal,
			);
			const outcome = await Promise.race([donePromise, prompting.then(() => donePromise)]);
			await new Promise((r) => setTimeout(r, 400));
			const summaryText = finalText || toolResultText || errorText || `DSH 会话执行完成 (${toolsUsed.join(' → ') || outcome?.kind})`;
			const ok = desktopQuick ? quickClickSucceeded && !quickPermissionDenied && outcome?.kind === 'completed'
				: toolExplicitOk !== null
				? toolExplicitOk
				: (outcome?.kind !== 'error' && outcome?.kind !== 'timeout' && toolsUsed.length > 0 && !/失败|未找到|拒绝|未开启|尚未确认/.test(summaryText));
			addDebug('DSH 会话结束', outcome?.kind === 'timeout' ? '执行超时' : outcome?.kind === 'error' ? '会话报错' : ok ? '有点击回执，等待会中确认' : '未确认提交');
			return {
				...(desktopQuick ? { debug } : {}),
				ok,
				...(desktopQuick && quickPermissionDenied ? { reason: 'permission-denied' } : {}),
				via: 'dsh:session',
				sessionId,
				tools: toolsUsed,
				result: summaryText,
				targetUrl: rawUrl || cleanCode || appName,
				needsQuickMeeting: !cleanCode && !rawUrl,
			};
		} catch (error) {
			if (!desktopQuick) throw error;
			addDebug('DSH 会话中断', quickPermissionDenied ? '权限被拒绝' : '会话执行未完成');
			return { ok: false, debug, ...(quickPermissionDenied ? { reason: 'permission-denied' } : {}) };
		} finally {
			clearTimeout(timer);
			if (typeof off === 'function') off();
		}
	})();

	recentJoins.set(dedupKey, { at: Date.now(), promise });
	return promise;
}

export function apply(ctx, config = {}) {
	const artifactsRoot = resolveArtifactsDir(config);
	const schedulesFile = resolveSchedulesFile(config);
	const prefix = String(config.path || '/api/dsh-meeting').replace(/\/+$/, '');
	const pendingTriggers = [];
	const sseClients = new Set();
	const sseHistory = [];
	let sseSeq = 0;

	function emitSseEvent(eventType, data) {
		sseSeq += 1;
		const record = { id: String(sseSeq), event: eventType, data };
		sseHistory.push(record);
		if (sseHistory.length > 500) sseHistory.shift();
		const frame = `id: ${record.id}\nevent: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`;
		for (const client of sseClients) {
			try {
				client.write(frame);
			} catch {
				sseClients.delete(client);
			}
		}
	}

	/** 检查一条 Cron ("M H * * *") 是否命中当前分钟 */
	function matchCron(cronExpr, now) {
		if (!cronExpr) return false;
		const parts = String(cronExpr).trim().split(/\s+/);
		if (parts.length < 5) return false;
		const [min, hour] = parts;
		const mMatch = min === '*' || Number(min) === now.getMinutes();
		const hMatch = hour === '*' || Number(hour) === now.getHours();
		return mMatch && hMatch;
	}

	// 后台真实日程轮询器：每 10 秒检查一次到点会议（runAt 单次预约 / cron 周期任务）
	const desktopScheduler = process.env.DSH_MEETING_DESKTOP_SCHEDULER === '1';
	const scheduleTimer = desktopScheduler ? undefined : setInterval(async () => {
		try {
			const list = await loadSchedules();
			if (!list.length) return;
			const now = new Date();
			const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`;
			let dirty = false;

			for (const item of list) {
				if (item.enabled === false) continue;
				let shouldFire = false;
				if (item.runAt) {
					const targetMs = Date.parse(item.runAt);
					if (Number.isFinite(targetMs) && Date.now() >= targetMs && !item.triggeredAt) {
						shouldFire = true;
						item.triggeredAt = new Date().toISOString();
						item.enabled = false;
						dirty = true;
					}
				} else if (item.cron && matchCron(item.cron, now) && item.lastMinuteKey !== minuteKey) {
					shouldFire = true;
					item.lastMinuteKey = minuteKey;
					dirty = true;
				}

				if (shouldFire) {
					console.log(`[dsh-meeting-host] 日程到点触发: ${item.title} (${item.id})`);
					const payload = { ...item, firedAt: new Date().toISOString() };
					pendingTriggers.push(payload);
					emitSseEvent('schedule/due', payload);
					if (item.meetingCode || item.meetingUrl) {
						void delegateJoinToSoulmirror(ctx, {
							platform: item.platform || 'tencent',
							meetingCode: item.meetingCode || '',
							meetingUrl: item.meetingUrl || '',
						});
					}
				}
			}
			if (dirty) await saveSchedules(list);
		} catch (err) {
			console.warn('[dsh-meeting-host] 日程轮询异常:', err);
		}
	}, 10_000);
	ctx.effect(() => () => clearInterval(scheduleTimer));

	async function loadSchedules() {
		try {
			if (!existsSync(schedulesFile)) return [];
			return JSON.parse(await readFile(schedulesFile, 'utf8'));
		} catch {
			return [];
		}
	}

	async function saveSchedules(list) {
		await mkdir(join(schedulesFile, '..'), { recursive: true });
		await writeFile(schedulesFile, JSON.stringify(list, null, 2), 'utf8');
	}

	function buildArchiveName(payload) {
		const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
		const appName = sanitize(payload.platform || '腾讯会议');
		const code = sanitize(payload.meetingCode || '无会议号');
		const topic = sanitize(payload.title || '未命名会议').slice(0, 60);
		return `${appName}_${code}_${topic}`;
	}

	async function publishArtifacts(payload) {
		const meetingId = String(payload.meetingId || `m_${Date.now()}`);
		const archiveName = buildArchiveName(payload);
		const dir = join(artifactsRoot, archiveName);
		await mkdir(dir, { recursive: true });

		const meta = {
			meetingId,
			archiveName,
			title: payload.title || '未命名会议',
			platform: payload.platform || '腾讯会议',
			meetingCode: payload.meetingCode || '',
			startedAt: payload.startedAt || Date.now(),
			endedAt: payload.endedAt || Date.now(),
			speakers: payload.speakers || [],
			updatedAt: new Date().toISOString(),
		};

		await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
		if (payload.notesMarkdown != null) {
			await writeFile(join(dir, 'notes.md'), String(payload.notesMarkdown), 'utf8');
		}
		if (payload.summaryMarkdown != null) {
			await writeFile(join(dir, 'summary.md'), String(payload.summaryMarkdown), 'utf8');
		}
		if (payload.quadrants != null) {
			await writeFile(join(dir, 'quadrants.json'), JSON.stringify(payload.quadrants, null, 2), 'utf8');
		}
		if (payload.transcript != null) {
			await writeFile(join(dir, 'transcript-labeled.json'), JSON.stringify(payload.transcript, null, 2), 'utf8');
		}
		return { meetingId, archiveName, dir, meta };
	}

	async function listArtifacts() {
		if (!existsSync(artifactsRoot)) return [];
		const entries = await readdir(artifactsRoot, { withFileTypes: true });
		const items = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const metaPath = join(artifactsRoot, entry.name, 'meta.json');
			try {
				if (existsSync(metaPath)) {
					items.push(JSON.parse(await readFile(metaPath, 'utf8')));
				}
			} catch { }
		}
		return items.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
	}

	async function getArtifactBundle(meetingId) {
		const dir = join(artifactsRoot, String(meetingId));
		if (!existsSync(dir)) return null;
		const readOpt = async (file, parseJson = false) => {
			const p = join(dir, file);
			if (!existsSync(p)) return null;
			const text = await readFile(p, 'utf8');
			return parseJson ? JSON.parse(text) : text;
		};
		return {
			meta: await readOpt('meta.json', true),
			summaryMarkdown: await readOpt('summary.md', false),
			quadrants: await readOpt('quadrants.json', true),
			transcript: await readOpt('transcript-labeled.json', true),
		};
	}

	// =========================================================================
	// 1. 注册 DSH 原生 Agent 工具（ctx.tools.register）
	// =========================================================================

	ctx.effect(() =>
		ctx.tools.register({
			name: 'meeting_schedule_create',
			description: '根据用户的自然语言创建一个定时或周期性会议任务（如每天早上九点半开站会）。若用户未指定平台，默认使用 tencent（腾讯会议），无需反问即可直接创建。',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string', description: '会议标题，如“每日站会”' },
					cron: { type: 'string', description: '周期性 Cron 表达式，如 "30 9 * * *"' },
					runAt: { type: 'string', description: '单次会议 ISO 时间戳' },
					platform: { type: 'string', enum: ['tencent', 'chinamobile', 'zoom', 'other'], description: '会议软件平台' },
					meetingCode: { type: 'string', description: '会议号（如有）' },
					meetingUrl: { type: 'string', description: '加入已有会议使用的官方邀请链接' },
					mode: { type: 'string', enum: ['join', 'quick'], description: '仅在用户明确授权发起新会议时使用 quick，否则使用 join' },
					autoRecord: { type: 'boolean', description: '入会后是否自动开始百炼流式转写' },
				},
				required: ['title'],
			},
			output: TOOL_OUTPUT,
			async execute(args) {
				const mode = args.mode === 'quick' ? 'quick' : 'join';
				const platform = args.platform || 'tencent';
				const hasTarget = Boolean(args.meetingCode?.trim() || args.meetingUrl?.trim());
				if (mode === 'quick' && (hasTarget || !['tencent', 'chinamobile'].includes(platform))) {
					return { ok: false, result: '快速会议仅支持腾讯会议和移动云会议，且不需要会议号或链接。' };
				}
				const list = await loadSchedules();
				const item = {
					id: `sched_${randomUUID().slice(0, 8)}`,
					title: args.title,
					cron: args.cron || null,
					runAt: args.runAt || null,
					platform,
					mode,
					meetingCode: args.meetingCode || '',
					meetingUrl: args.meetingUrl || '',
					autoRecord: args.autoRecord === true,
					enabled: true,
					createdAt: new Date().toISOString(),
				};
				list.push(item);
				await saveSchedules(list);
				return {
					ok: true,
					result: `已创建日程「${item.title}」。${mode === 'quick' ? '到点尝试发起快速会议。' : hasTarget ? '到点尝试加入已有会议。' : '请补充会议号或链接；此日程不会发起新会议。'}${item.autoRecord ? '确认入会后自动录音。' : ''}`,
					data: item,
				};
			},
		}),
	);

	ctx.effect(() =>
		ctx.tools.register({
			name: 'meeting_join_now',
			description: '立即加入指定的腾讯会议或中国移动云会议，并通知桌面端激活百炼流式语音转写。',
			parameters: {
				type: 'object',
				properties: {
					platform: { type: 'string', enum: ['tencent', 'chinamobile'], description: '会议平台' },
					meetingCode: { type: 'string', description: '会议号' },
					meetingUrl: { type: 'string', description: '入会链接' },
				},
			},
			output: TOOL_OUTPUT,
			async execute(args) {
				const res = await delegateJoinToSoulmirror(ctx, args);
				if (!res.ok) return { ok: false, result: `入会失败：${res.error}` };
				return {
					ok: true,
					result: `已委托 soulmirror 加入 ${args.platform === 'chinamobile' ? '移动云会议' : '腾讯会议'}（${res.targetUrl}），桌面端检测到会议窗口后将自动开启百炼流式 ASR 转写。`,
					data: res,
				};
			},
		}),
	);

	ctx.effect(() =>
		ctx.tools.register({
			name: 'meeting_artifacts_list',
			description: '列出最近已生成的会议纪要、四象限决策和带声纹说话人的转写制品。',
			parameters: {
				type: 'object',
				properties: {
					limit: { type: 'number', description: '返回最近几场会议' },
				},
			},
			output: TOOL_OUTPUT,
			async execute(args) {
				const items = (await listArtifacts()).slice(0, args.limit || 10);
				if (!items.length) return { ok: true, result: '暂无已留档的会议制品。', data: { items: [] } };
				const lines = items.map((m, i) => `${i + 1}. [${m.meetingId}] ${m.title}（参会人：${(m.speakers || []).join('、') || '未知'}）`);
				return {
					ok: true,
					result: `已检索到 ${items.length} 份会议制品：\n${lines.join('\n')}`,
					data: { items },
				};
			},
		}),
	);

	// =========================================================================
	// 2. 注册 HTTP 路由，100% 接入真实 DSH sessionController
	// =========================================================================

	ctx.webServer.register({
		kind: 'prefix',
		path: prefix,
		async handler(req, res) {
			if (req.method === 'OPTIONS') {
				res.statusCode = 204;
				res.setHeader('Access-Control-Allow-Origin', '*');
				res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
				res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
				return res.end();
			}

			const url = new URL(req.url || '/', 'http://127.0.0.1');
			const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;

			try {
				if (req.method === 'GET' && route === '/v1/health') {
					return sendJson(res, 200, { ok: true, plugin: name, version: 3, capabilities: ['sse', 'pending-triggers', 'meetings-join'], desktopScheduler, artifactsRoot, hasSessionController: !!ctx.get('sessionController') });
				}

				if (req.method === 'GET' && route === '/v1/events/stream') {
					res.writeHead(200, {
						'Content-Type': 'text/event-stream; charset=utf-8',
						'Cache-Control': 'no-cache, no-transform',
						Connection: 'keep-alive',
					});
					const lastId = Number(req.headers['last-event-id'] || url.searchParams.get('lastEventId') || 0);
					for (const ev of sseHistory) {
						if (Number(ev.id) > lastId) {
							res.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
						}
					}
					sseClients.add(res);
					const ping = setInterval(() => {
						try { res.write(': ping\n\n'); } catch { clearInterval(ping); sseClients.delete(res); }
					}, 20_000);
					req.on('close', () => {
						clearInterval(ping);
						sseClients.delete(res);
					});
					return;
				}

				if (req.method === 'POST' && route === '/v1/artifacts/publish') {
					const body = await readJsonBody(req);
					const published = await publishArtifacts(body);
					return sendJson(res, 200, { ok: true, data: published });
				}

				if (req.method === 'POST' && route === '/v1/knowledge/ingest') {
					const knowledge = ctx.get('dshKnowledge');
					if (typeof knowledge?.ingestRecord !== 'function') return sendJson(res, 503, { ok: false, error: 'DSH Knowledge 尚未就绪' });
					const input = await readJsonBody(req);
					if (typeof input?.title !== 'string' || !input.title.trim() || typeof input?.body !== 'string' || !input.body.trim()) {
						return sendJson(res, 400, { ok: false, error: '缺少会议标题或内容' });
					}
					const entry = await knowledge.ingestRecord({ title: input.title, body: input.body, tags: ['会议'], group: '会议记录' });
					return sendJson(res, 200, { ok: Boolean(entry?.id), docId: entry?.id });
				}

				if (req.method === 'GET' && route === '/v1/artifacts') {
					return sendJson(res, 200, { ok: true, data: await listArtifacts() });
				}

				if (req.method === 'GET' && route.startsWith('/v1/artifacts/')) {
					const meetingId = decodeURIComponent(route.slice('/v1/artifacts/'.length));
					const bundle = await getArtifactBundle(meetingId);
					if (!bundle) return sendJson(res, 404, { ok: false, error: '未找到该会议制品' });
					return sendJson(res, 200, { ok: true, data: bundle });
				}

				if (req.method === 'GET' && route === '/v1/schedules') {
					return sendJson(res, 200, { ok: true, data: await loadSchedules() });
				}
				if (req.method === 'GET' && route === '/v1/schedules/pending-triggers') {
					const items = pendingTriggers.splice(0, pendingTriggers.length);
					return sendJson(res, 200, { ok: true, data: items });
				}
				if (req.method === 'POST' && route === '/v1/schedules') {
					const body = await readJsonBody(req);
					const list = await loadSchedules();
					const item = { id: `sched_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), enabled: true, ...body };
					list.push(item);
					await saveSchedules(list);
					return sendJson(res, 200, { ok: true, data: item });
				}

				if (req.method === 'POST' && route === '/v1/meetings/quick') {
					const body = await readJsonBody(req);
					if (body?.confirm !== true || !['tencent', 'chinamobile'].includes(body.platform)) {
						return sendJson(res, 400, { ok: false, error: '发起会议需要明确授权并指定平台' });
					}
					let confirmRoom;
					const confirmed = new Promise(resolve => { confirmRoom = resolve; });
					const pending = delegateJoinToSoulmirror(ctx, {
						platform: body.platform, desktopQuick: true,
						onRoom: (room, debug) => confirmRoom({ ok: true, room, debug }),
					});
					const attempt = await Promise.race([pending, confirmed]);
					return sendJson(res, 200, { ok: attempt.ok, reason: attempt.reason, debug: attempt.debug, room: attempt.room });
				}

				if (req.method === 'POST' && route === '/v1/meetings/join') {
					const body = await readJsonBody(req);
					const platform = /chinamobile|移动/i.test(String(body.platform || '')) ? 'chinamobile' : 'tencent';
					const launch = await delegateJoinToSoulmirror(ctx, {
						platform,
						meetingCode: String(body.meetingCode || ''),
						meetingUrl: String(body.meetingUrl || ''),
						title: String(body.title || ''),
					});
					emitSseEvent('meeting/joining', { platform, meetingCode: body.meetingCode || '', targetUrl: launch.targetUrl });
					return sendJson(res, 200, { ok: launch.ok, data: launch });
				}

				// 核心：100% 走真实 DSH sessionController，创建/复用原生 DSH 会话并在 DSH Web 中留痕
				if (req.method === 'POST' && route === '/v1/copilot/chat') {
					const body = await readJsonBody(req);
					const controller = ctx.get('sessionController');
					if (!controller || typeof controller.create !== 'function') {
						return sendJson(res, 503, { ok: false, error: 'DSH sessionController 尚未就绪' });
					}
					const promptText = String(body.prompt || body.message || '').trim();
					if (!promptText) {
						return sendJson(res, 400, { ok: false, error: 'prompt 不能为空' });
					}

					let sessionId = body.sessionId ? String(body.sessionId) : '';
					if (!sessionId) {
						const created = await controller.create({
							cwd: String(body.cwd || process.cwd()),
						});
						sessionId = created?.sessionId;
						if (body.title && sessionId) {
							await controller.rename?.({ sessionId, title: String(body.title) }).catch(() => { });
						}
					}

					let finalText = '';
					let ourTurn = 0;
					const toolsUsed = [];
					let settle;
					const donePromise = new Promise((r) => {
						settle = r;
					});

					const off =
						typeof ctx.on === 'function'
							? ctx.on('session/event', (sess, event) => {
								const sid = String(sess?.id ?? sess?.sessionId ?? '');
								if (sid !== sessionId) return;
								const type = String(event?.type ?? '');
								const data = event?.data ?? {};
								if (type === 'turn/start') {
									ourTurn = Number(data?.turn ?? 0) || ourTurn;
								} else if (type === 'tool/call') {
									if (data?.name) toolsUsed.push(String(data.name));
									if (data?.name === 'ask_user_question') {
										const qs = data?.arguments?.questions;
										if (Array.isArray(qs) && qs.length) {
											finalText = qs.map((q) => q.question || '').filter(Boolean).join('\n');
										}
										settle({ kind: 'question' });
									}
								} else if (type === 'assistant/delta' || type === 'text/delta') {
									const d = String(data?.delta ?? data?.text ?? '');
									if (d) finalText += d;
								} else if (type === 'assistant/message') {
									const content = data?.message?.content;
									if (typeof content === 'string' && content.trim()) {
										finalText = content.trim();
									} else if (Array.isArray(content)) {
										const t = content
											.filter((p) => typeof p === 'string' || p?.type === 'text' || p?.type === 'output_text')
											.map((p) => (typeof p === 'string' ? p : p?.text || ''))
											.join('')
											.trim();
										if (t) finalText = t;
									}
								} else if (type === 'turn/end' || type === 'session/idle') {
									const turn = Number(data?.turn ?? 0);
									if (type === 'turn/end' && ourTurn && turn && turn !== ourTurn) return;
									const errMsg = data?.reason?.error?.message || data?.reason?.message || data?.error?.message || data?.error;
									if (!finalText && errMsg) finalText = `执行异常：${String(errMsg)}`;
									settle({ kind: data?.reason?.kind || 'completed' });
								}
							})
							: () => { };

					const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
					const effectivePrompt = body.sessionId
						? promptText
						: `[快捷指令模式 · 当前北京时间 ${nowStr}] 请直接调用可用会议工具（meeting_schedule_create、meeting_join_now、meeting_artifacts_list、tencent_meeting_*、dsh-knowledge）执行需求。若未指定会议平台，默认使用 tencent（腾讯会议）。若用户提供了会议号（6-12位数字），必须提取并写入 meetingCode；若用户要预约腾讯会议且未提供会议号，可先检查 tencent_meeting_discover(statusOnly=true)，若已配置凭据则可预约会议获取真实会议号后填入 meetingCode，若未配置则直接调用 meeting_schedule_create 创建。涉及“N分钟后”的相对时间，请基于当前时间计算精确 ISO 时间戳写入 runAt。一旦目标工具返回 ok:true，请立即停止调用后续工具并直接给出简短中文回复。禁止调用 ask_user_question、pwsh、glob。\n\n用户指令：${promptText}`;

					const ac = new AbortController();
					const timer = setTimeout(() => {
						ac.abort();
						settle({ kind: 'timeout' });
					}, Number(body.timeoutMs) || 45_000);
					try {
						await controller.prompt(
							{
								requestId: randomUUID(),
								sessionId,
								mode: 'queue',
								content: [{ type: 'text', text: effectivePrompt }],
							},
							ac.signal,
						);
						const outcome = await donePromise;
						const fallbackReply = toolsUsed.length
							? `已执行工具：${Array.from(new Set(toolsUsed)).join('、')}。可在 DSH 原生对话界面查看详细执行过程。`
							: `已完成处理（状态: ${outcome?.kind || 'done'}）`;
						return sendJson(res, 200, {
							ok: outcome?.kind !== 'error',
							sessionId,
							reply: finalText || fallbackReply,
							tools: toolsUsed,
						});
					} finally {
						clearTimeout(timer);
						if (typeof off === 'function') off();
					}
				}

				return sendJson(res, 404, { ok: false, error: `未知路由: ${route}` });
			} catch (err) {
				return sendJson(res, 500, { ok: false, error: err?.message || String(err), stack: err?.stack });
			}
		},
	});
}
