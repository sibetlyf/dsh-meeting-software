export function quickMeetingPrompt(platform) {
	const target = platform === 'tencent' ? '腾讯会议' : '移动会议';
	const processes = platform === 'tencent' ? 'wemeetapp.exe' : 'cloudmeeting.exe、cloudvideo.exe、ydmeeting.exe';
	const access = platform === 'tencent'
		? '第一步必须调用 request_access，参数 apps=["wemeetapp.exe"]，reason="发起腾讯会议快速会议"。不要用「腾讯会议」这个显示名申请授权。'
		: '先用 windows 确认实际进程名，再用 request_access 的 apps 参数只申请该进程，不要用显示名申请授权。';
	return `用户已明确授权发起一场${target}快速会议。${access} 只允许操作${target}客户端，实际进程必须是 ${processes} 之一；不得申请 Yogurt/electron 或其他应用的权限。客户端已由 DSH 预先启动，严禁调用 open_application 或 app_launch 重复拉起新进程（若 windows 未看到客户端窗口，可先调用 meeting_open 启动/唤醒）。若授权被拒绝或没有确认授权，停止操作并报告。先聚焦客户端，确认 windows 返回的前台进程和窗口，再获取新的完整桌面截图。优先使用有明确名称的可访问性控件；若首页无可见控件，定位「快速会议」蓝色闪电图标，只点击图标中心，不点击文字、边缘或下拉箭头。点击必须使用当前完整截图的屏幕坐标，且落在前台客户端窗口内；不要直接用裁剪图或缩放图的坐标。点击一次后重新观察窗口。有同一客户端的确认框时确认一次；没有界面变化则停止，不重复提交。若已经在会议中、无法确认目标窗口、未登录或需要密码，停止并报告。不运行命令，不调用 meeting_auto，不录音。Yogurt 独立确认是否进入会议。`;
}

export function readDesktopResult(data, calls) {
	const message = data?.message;
	const call = calls.get(data?.callId ?? message?.toolCallId ?? message?.source?.callId);
	const name = data?.name ?? call?.name;
	const output = data?.output ?? data?.result;
	const text = [output?.result, ...(Array.isArray(message?.content) ? message.content.filter(p => p?.type === 'text').map(p => p.text) : [])]
		.filter(p => typeof p === 'string').join('\n');
	const denied = /not granted for this session|permission denied|access denied|access (?:was )?refused|未授权|授权.*拒绝|拒绝.*授权/i.test(text)
		|| (name === 'request_access' && (message?.isError === true || output?.ok === false));
	const clicked = !denied && !message?.isError && (name === 'computer_click' && output?.ok === true
		|| name === 'computer' && /^left click at \(-?\d+,\s*-?\d+\)\./im.test(text)
		|| name === 'computer_batch' && /All \d+ actions? done\./i.test(text) && /^#\d+ left click\b/im.test(text));
	return { denied, clicked };
}

// Use desktop tool output, not the assistant's final prose, as the handoff evidence.
export function readTencentQuickRoom(data, calls, observed) {
	const message = data?.message;
	const name = calls.get(message?.toolCallId ?? data?.callId)?.name ?? data?.name;
	if (message?.isError || data?.output?.ok === false) return;
	const text = Array.isArray(message?.content) ? message.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
	if (name === 'windows') {
		observed.window = undefined;
		for (const line of text.split(/\r?\n/)) {
			const match = /^hwnd=(\d+)\s*\|\s*wemeetapp\.exe\s*\|\s*"([^"\r\n]+)"\s*\|.*\bopened during this task\b/i.exec(line);
			if (match && /(?:的快速会议|['’]s quick meeting)$/i.test(match[2]) && !/等候室|等待主持人|lobby|waiting|预览|preview/i.test(match[2])) {
				observed.window = { windowId: match[1], title: match[2] };
				break;
			}
		}
	} else if (name === 'ui_elements' && observed.window && /^\s*AudioGridWidget\s*$/im.test(text)) {
		const header = /^wemeetapp\.exe\s+[^\r\n]*?"([^"\r\n]+)"\s*:/i.exec(text);
		if (header?.[1] === observed.window.title) return { windowId: observed.window.windowId };
	}
}
