import { describe, expect, it } from 'vitest'
import { classifyMeetingWindows, extractMeetingCode } from '../src/main/meetingAutowatch'

const tencent = { ProcessName: 'wemeetapp', windowClass: 'BaseDialog' }

describe('local Windows meeting detection', () => {
  it('detects a confirmed meeting on its own and uses only that window’s code', () => {
    const rows = [
      { ...tencent, MainWindowTitle: '腾讯会议', windowId: '1', MeetingCode: '987654321' },
      { ...tencent, MainWindowTitle: '快速会议', windowId: '2', hasAudioGrid: true, MeetingCode: '123456789' },
      { ...tencent, MainWindowTitle: '等候室', windowId: '3', hasAudioGrid: true },
    ]
    expect(classifyMeetingWindows(rows, undefined, undefined, true)).toEqual([
      expect.objectContaining({ windowId: '2', meetingCode: '123-456-789', evidence: 'tencent-audio-grid' }),
    ])
  })

  it('does not interpret accessibility IDs or unlabeled digit strings as meeting codes', () => {
    expect(extractMeetingCode('Sprint ticket 123-456-789')).toBeUndefined()
    expect(extractMeetingCode('NXQtWindow:1907361278208')).toBeUndefined()
    expect(extractMeetingCode('Meeting ID: 1907361278208')).toBeUndefined()
    expect(extractMeetingCode('会议号：１２３－４５６－７８９')).toBe('123-456-789')
    expect(extractMeetingCode('Zoom Meeting (123 4567 8910)')).toBeUndefined()
  })
})
it('ignores corrupted window text while preserving independently confirmed in-call evidence', () => {
  const title = `Tencent ${'\uFFFD'.repeat(4)}`
  expect(classifyMeetingWindows([{ ...tencent, MainWindowTitle: title }], undefined, undefined, true)).toEqual([])
  const rooms = classifyMeetingWindows([{ ...tencent, MainWindowTitle: title, hasAudioGrid: true, windowId: '77' }], undefined, undefined, true)
  expect(rooms).toHaveLength(1)
  expect(rooms[0].windowTitle).not.toContain('\uFFFD')
  expect(rooms[0].evidence).toBe('tencent-audio-grid')
})
