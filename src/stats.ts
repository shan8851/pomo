import type { SessionRecord, TodayStats } from './types.js';

interface DayRange {
  startEpochMs: number;
  endEpochMs: number;
}

const getDayRange = (referenceDate: Date): DayRange => {
  const startDate = new Date(referenceDate);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 1);

  return {
    startEpochMs: startDate.getTime(),
    endEpochMs: endDate.getTime()
  };
};

const isTimestampInRange = (timestampIso: string, dayRange: DayRange): boolean => {
  const timestampEpochMs = Date.parse(timestampIso);

  if (Number.isNaN(timestampEpochMs)) {
    return false;
  }

  return timestampEpochMs >= dayRange.startEpochMs && timestampEpochMs < dayRange.endEpochMs;
};

export const calculateTodayStats = (
  historyRecords: SessionRecord[],
  referenceDate: Date = new Date()
): TodayStats => {
  const dayRange = getDayRange(referenceDate);

  const todayFocusSessions = historyRecords.filter(
    (historyRecord) =>
      historyRecord.mode === 'focus' &&
      historyRecord.completed &&
      isTimestampInRange(historyRecord.timestampEnd, dayRange)
  );

  const totalFocusedMinutes = todayFocusSessions.reduce(
    (minutesAccumulator, historyRecord) => minutesAccumulator + historyRecord.durationMinutes,
    0
  );

  return {
    completedFocusSessions: todayFocusSessions.length,
    totalFocusedMinutes
  };
};

export const filterHistoryForToday = (
  historyRecords: SessionRecord[],
  referenceDate: Date = new Date()
): SessionRecord[] => {
  const dayRange = getDayRange(referenceDate);

  return historyRecords.filter((historyRecord) =>
    isTimestampInRange(historyRecord.timestampEnd, dayRange)
  );
};

export const getRecentHistoryEntries = (
  historyRecords: SessionRecord[],
  limit: number = 3
): SessionRecord[] => historyRecords.slice(-limit).reverse();

export const formatClock = (totalSeconds: number): string => {
  const clampedSeconds = Math.max(0, totalSeconds);
  const minutesPortion = Math.floor(clampedSeconds / 60)
    .toString()
    .padStart(2, '0');
  const secondsPortion = Math.floor(clampedSeconds % 60)
    .toString()
    .padStart(2, '0');

  return `${minutesPortion}:${secondsPortion}`;
};

export const formatTime = (timestampIso: string): string => {
  const parsedDate = new Date(timestampIso);

  if (Number.isNaN(parsedDate.getTime())) {
    return '--:--';
  }

  return parsedDate.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
};
