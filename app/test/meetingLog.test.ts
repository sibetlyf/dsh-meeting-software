import { describe, expect, it } from 'vitest'
import {
  foldMeetingLifecycle,
  foldSchedules,
  verifyStreamInvariants,
  type MeetingLogEnvelope,
} from '../src/shared/meetingLog'
import { parseMeetingInvitationText } from '../src/main/dsh/invitationParser'

describe('MeetingLog 纯函数折叠与不变量校验', () => {
  it('persists the latest attempt result without treating a schedule trigger as success', () => {
    const base = { stream: 'schedule', source: 'yogurt', v: 1 } as const
    const events: MeetingLogEnvelope[] = [
      { ...base, seq: 1, at: '2026-11-18T07:15:00Z', type: 'schedule/created', data: { id: 'quick', mode: 'quick' } },
      { ...base, seq: 2, at: '2026-11-18T07:17:00Z', type: 'schedule/triggered', data: { id: 'quick' } },
      { ...base, seq: 3, at: '2026-11-18T07:18:30Z', type: 'schedule/status', data: { id: 'quick', result: 'Not confirmed' } },
    ]
    expect(foldSchedules(events.slice(0, 2))[0].lastResult).toBeUndefined()
    expect(foldSchedules(events)[0].lastResult).toBe('Not confirmed')
  })
  it('按只追加事件流折叠日程增删改查与暂停/恢复', () => {
    const events: MeetingLogEnvelope[] = [
      {
        seq: 1,
        at: '2026-11-18T08:00:00Z',
        stream: 'schedule',
        source: 'user',
        type: 'schedule/created',
        data: { id: 's1', title: '每日站会', platform: 'tencent', meetingCode: '', cron: '30 9 * * *' },
        v: 1,
      },
      {
        seq: 2,
        at: '2026-11-18T08:01:00Z',
        stream: 'schedule',
        source: 'yogurt',
        type: 'schedule/edited',
        data: { id: 's1', meetingCode: '977-694-801', title: '早站会' },
        v: 1,
      },
      {
        seq: 3,
        at: '2026-11-18T08:02:00Z',
        stream: 'schedule',
        source: 'user',
        type: 'schedule/paused',
        data: { id: 's1' },
        v: 1,
      },
      {
        seq: 4,
        at: '2026-11-18T08:03:00Z',
        stream: 'schedule',
        source: 'import',
        type: 'schedule/imported',
        data: { id: 's2', title: '临时评审', platform: 'chinamobile', meetingCode: '123-456-789', runAt: '2026-11-18T14:00:00+08:00' },
        v: 1,
      },
      {
        seq: 5,
        at: '2026-11-18T08:04:00Z',
        stream: 'schedule',
        source: 'user',
        type: 'schedule/deleted',
        data: { id: 's2' },
        v: 1,
      },
    ]

    const list = foldSchedules(events, new Date('2026-11-18T09:00:00+08:00'))
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('s1')
    expect(list[0].title).toBe('早站会')
    expect(list[0].meetingCode).toBe('977-694-801')
    expect(list[0].enabled).toBe(false)
    expect(list[0].displayTime).toBe('每天 09:30')
    expect(verifyStreamInvariants(events)).toEqual([])
  })

  it('手动修改已触发日程的 runAt 时间后，自动重置 triggeredAt 并恢复启用状态', () => {
    const events: MeetingLogEnvelope[] = [
      {
        seq: 1,
        at: '2026-11-18T10:00:00Z',
        stream: 'schedule',
        source: 'user',
        type: 'schedule/created',
        data: { id: 's_manual', title: '测试单次会', platform: 'tencent', meetingCode: '430815855', runAt: '2026-11-18T10:05' },
        v: 1,
      },
      {
        seq: 2,
        at: '2026-11-18T10:05:01Z',
        stream: 'schedule',
        source: 'yogurt',
        type: 'schedule/triggered',
        data: { id: 's_manual', triggeredAt: '2026-11-18T10:05:01Z' },
        v: 1,
      },
      {
        seq: 3,
        at: '2026-11-18T10:05:02Z',
        stream: 'schedule',
        source: 'yogurt',
        type: 'schedule/paused',
        data: { id: 's_manual' },
        v: 1,
      },
      {
        seq: 4,
        at: '2026-11-18T10:10:00Z',
        stream: 'schedule',
        source: 'user',
        type: 'schedule/edited',
        data: { id: 's_manual', runAt: '2026-11-18T10:15' },
        v: 1,
      },
    ]

    const list = foldSchedules(events)
    expect(list).toHaveLength(1)
    expect(list[0].runAt).toBe('2026-11-18T10:15')
    expect(list[0].triggeredAt).toBeUndefined()
    expect(list[0].enabled).toBe(true)
  })

  it('从会议事件流折叠完整生命周期状态', () => {
    const events: MeetingLogEnvelope[] = [
      { seq: 1, at: '2026-11-18T09:00:00Z', stream: 'meeting:m1', source: 'yogurt', type: 'meeting/start', data: { meetingId: 'm1', title: '腾讯会议 · 站会', platform: '腾讯会议' }, v: 1 },
      { seq: 2, at: '2026-11-18T09:00:10Z', stream: 'meeting:m1', source: 'yogurt', type: 'meeting/code-discovered', data: { meetingId: 'm1', meetingCode: '977-694-801' }, v: 1 },
      { seq: 3, at: '2026-11-18T09:30:00Z', stream: 'meeting:m1', source: 'yogurt', type: 'meeting/end', data: { meetingId: 'm1' }, v: 1 },
      { seq: 4, at: '2026-11-18T09:30:05Z', stream: 'meeting:m1', source: 'host', type: 'processing/step-start', data: { meetingId: 'm1', step: 'summary' }, v: 1 },
      { seq: 5, at: '2026-11-18T09:30:10Z', stream: 'meeting:m1', source: 'host', type: 'processing/step-end', data: { meetingId: 'm1', step: 'summary', ok: true }, v: 1 },
      { seq: 6, at: '2026-11-18T09:30:12Z', stream: 'meeting:m1', source: 'host', type: 'artifact/published', data: { meetingId: 'm1', archiveName: '腾讯会议_977-694-801_站会', dir: '/tmp/a' }, v: 1 },
    ]
    const state = foldMeetingLifecycle('m1', events)
    expect(state.phase).toBe('archived')
    expect(state.meetingCode).toBe('977-694-801')
    expect(state.archiveName).toBe('腾讯会议_977-694-801_站会')
    expect(verifyStreamInvariants(events)).toEqual([])
  })

  it('捕获序号跳跃与孤儿结束事件不变量违规', () => {
    const broken: MeetingLogEnvelope[] = [
      { seq: 2, at: '2026-11-18T09:00:00Z', stream: 'meeting:m2', source: 'yogurt', type: 'meeting/end', data: { meetingId: 'm2' }, v: 1 },
    ]
    const violations = verifyStreamInvariants(broken)
    expect(violations.map((v) => v.code)).toEqual(['SEQ_NOT_MONOTONIC', 'ORPHAN_END'])
  })

  it('精确解析粘贴的腾讯会议邀请文本并生成内容哈希', () => {
    const invite = `李亚峰 邀请您参加腾讯会议
会议主题：李亚峰的快速会议
会议时间：2026/11/17 18:40-19:40 (GMT+08:00) 中国标准时间 - 北京

点击链接直接加入会议：
https://meeting.tencent.com/dm/W1jzNDWo9igo

#腾讯会议：977-694-801`

    const parsed = parseMeetingInvitationText(invite)
    expect(parsed).not.toBeNull()
    expect(parsed?.title).toBe('李亚峰的快速会议')
    expect(parsed?.platform).toBe('tencent')
    expect(parsed?.meetingCode).toBe('977-694-801')
    expect(parsed?.meetingUrl).toBe('https://meeting.tencent.com/dm/W1jzNDWo9igo')
    expect(parsed?.runAt).toBe('2026-11-17T18:40:00+08:00')
    expect(parsed?.rawTextHash).toHaveLength(16)
  })
})

