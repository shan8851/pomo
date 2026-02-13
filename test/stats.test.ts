import { describe, expect, it } from 'vitest';

import {
  calculateTodayStats,
  filterHistoryForToday,
  formatClock
} from '../src/stats.js';
import type { SessionRecord } from '../src/types.js';

const createRecord = (
  id: string,
  timestampEnd: string,
  mode: SessionRecord['mode'],
  durationMinutes: number,
  completed: boolean
): SessionRecord => ({
  id,
  timestampStart: timestampEnd,
  timestampEnd,
  mode,
  label: '',
  durationMinutes,
  completed
});

describe('stats', () => {
  it('calculates local-day focus stats', () => {
    const referenceDate = new Date('2026-02-13T12:00:00');

    const historyRecords: SessionRecord[] = [
      createRecord('a', '2026-02-13T09:00:00.000Z', 'focus', 25, true),
      createRecord('b', '2026-02-13T10:00:00.000Z', 'shortBreak', 5, true),
      createRecord('c', '2026-02-12T23:55:00.000Z', 'focus', 25, true),
      createRecord('d', '2026-02-13T11:00:00.000Z', 'focus', 25, false)
    ];

    const todayStats = calculateTodayStats(historyRecords, referenceDate);

    expect(todayStats.completedFocusSessions).toBe(1);
    expect(todayStats.totalFocusedMinutes).toBe(25);
  });

  it('filters only todays records', () => {
    const referenceDate = new Date('2026-02-13T12:00:00');

    const historyRecords: SessionRecord[] = [
      createRecord('a', '2026-02-13T09:00:00.000Z', 'focus', 25, true),
      createRecord('b', '2026-02-12T09:00:00.000Z', 'focus', 25, true)
    ];

    const todaysRecords = filterHistoryForToday(historyRecords, referenceDate);

    expect(todaysRecords).toHaveLength(1);
    expect(todaysRecords[0]?.id).toBe('a');
  });

  it('formats a countdown clock safely', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(61)).toBe('01:01');
    expect(formatClock(-7)).toBe('00:00');
  });
});
