/**
 * 会议邀请文本结构化解析器 (invitationParser.ts)
 *
 * 职责：将多行腾讯会议 / 移动云会议 / 飞书 / 钉钉 / Zoom 邀请文本解析为结构化日程事实，
 * 无 IO、无副作用，供 UI 与 DSH Agent 工具共用。
 */
import { createHash } from 'node:crypto';

export interface ParsedMeetingInvitation {
  title: string;
  platform: 'tencent' | 'chinamobile' | 'feishu' | 'dingtalk' | 'zoom';
  meetingCode: string;
  meetingUrl: string;
  runAt: string | null;
  rawTextHash: string;
}

export function parseMeetingInvitationText(raw: string): ParsedMeetingInvitation | null {
  const text = raw.trim();
  if (!text) return null;

  // 匹配入会链接，例如 https://meeting.tencent.com/dm/W1jzNDWo9igo
  const urlMatch = text.match(/https?:\/\/[^\s"'<>）)，。；、】]+/i);
  const meetingUrl = urlMatch?.[0] || '';

  // 匹配 9~11 位会议号，例如 #腾讯会议：977-694-801 或 977 694 801
  const codeMatch =
    text.match(/(?:#?腾讯会议|移动云会议|会议号|会议ID|Meeting\s*ID)[：:\s#]*([0-9]{3}[-\s]?[0-9]{3}[-\s]?[0-9]{3,4})/i) ||
    text.match(/\b(\d{3}[-\s]\d{3}[-\s]\d{3,4})\b/);
  const meetingCode = codeMatch ? codeMatch[1].replace(/\s+/g, '-') : '';

  const looksLikeInvite =
    Boolean(meetingCode || meetingUrl) &&
    /邀请您参加|会议主题|会议时间|#腾讯会议|meeting\.tencent\.com|cloudmeeting|点击链接直接加入/i.test(text);
  if (!looksLikeInvite) return null;

  let platform: ParsedMeetingInvitation['platform'] = 'tencent';
  if (/移动云会议|cloudmeeting/i.test(text)) platform = 'chinamobile';
  else if (/飞书|feishu|lark/i.test(text)) platform = 'feishu';
  else if (/钉钉|dingtalk/i.test(text)) platform = 'dingtalk';
  else if (/zoom/i.test(text)) platform = 'zoom';

  const topicMatch = text.match(/会议主题[：:]\s*([^\r\n]+)/);
  const inviteLineMatch = text.match(/^([^\r\n]*邀请您参加[^\r\n]*)/m);
  const title = (topicMatch?.[1] || inviteLineMatch?.[1] || '预约会议').trim();

  let runAt: string | null = null;
  const timeMatch = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const [, y, m, d, hh, mm] = timeMatch;
    runAt = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:00+08:00`;
  }

  const rawTextHash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  return { title, platform, meetingCode, meetingUrl, runAt, rawTextHash };
}

