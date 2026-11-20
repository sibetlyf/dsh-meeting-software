import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quickMeetingPrompt, readDesktopResult, readTencentQuickRoom } from './desktop-access.mjs';

test('hands off only a new Tencent window corroborated by the same window audio grid', () => {
	const state = {};
	const feed = (name, text) => readTencentQuickRoom({ name, message: { content: [{ type: 'text', text }] } }, new Map(), state);
	const grid = 'wemeetapp.exe — "测试用户的快速会议": 646 characters\nAudioGridWidget';
	assert.equal(feed('ui_elements', grid), undefined);
	feed('windows', 'hwnd=42 | wemeetapp.exe | "测试用户的快速会议" | FOREGROUND');
	assert.equal(feed('ui_elements', grid), undefined);
	feed('windows', 'hwnd=42 | wemeetapp.exe | "测试用户的快速会议" | FOREGROUND | opened during this task');
	assert.equal(feed('ui_elements', grid.replace('测试用户', '其他用户')), undefined);
	assert.deepEqual(feed('ui_elements', grid), { windowId: '42' });
});

test('requests permission for the native Tencent process before a click', () => {
	assert.match(quickMeetingPrompt('tencent'), /request_access.*apps=\["wemeetapp.exe"\]/);
});

test('recognizes native computer click results without counting screenshot or wait as clicks', () => {
	const calls = new Map([['call-1', { name: 'computer' }]]);
	const report = text => readDesktopResult({ message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text }] } }, calls);
	assert.deepEqual(report('left click at (227, 289).\nScreenshot 1366x768 attached.'), { denied: false, clicked: true });
	assert.deepEqual(report('Screenshot 1366x768 of display 0.'), { denied: false, clicked: false });
	assert.deepEqual(report('Waited 2.0s.'), { denied: false, clicked: false });
});

test('links real DSH tool results by toolCallId and recognizes refusals', () => {
	const calls = new Map([['call-1', { name: 'computer_batch' }]]);
	const report = text => readDesktopResult({ message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text }] } }, calls);
	assert.deepEqual(report('Stopped: #1 left_click failed: the app is not granted for this session.'), { denied: true, clicked: false });
	assert.deepEqual(report('All 2 actions done.\n#1 left click at (589, 265).\n#2 Waited 2.2s'), { denied: false, clicked: true });
	assert.deepEqual(report('All 1 actions done.\n#1 Waited 2.2s'), { denied: false, clicked: false });
});
