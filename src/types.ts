export type TimerMode = 'focus' | 'shortBreak' | 'longBreak';

export type TimerStatus = 'idle' | 'running' | 'paused';

export interface PomoConfig {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  sessionsBeforeLongBreak: number;
  notificationsEnabled: boolean;
}

export interface SessionRecord {
  id: string;
  timestampStart: string;
  timestampEnd: string;
  mode: TimerMode;
  label: string;
  durationMinutes: number;
  completed: boolean;
}

export interface RuntimeState {
  mode: TimerMode;
  status: TimerStatus;
  remainingSeconds: number;
  targetEndEpochMs: number | null;
  currentLabel: string;
  completedFocusCountInCycle: number;
  startedAt: string | null;
  pausedAt: string | null;
}

export interface RuntimeStatusRecord {
  pid: number;
  source: 'tui' | 'start';
  runtimeSessionId: string;
  processStartTicks: number | null;
  updatedAt: string;
  state: RuntimeState;
}

export interface TodayStats {
  completedFocusSessions: number;
  totalFocusedMinutes: number;
}

export interface StoragePaths {
  configDirectoryPath: string;
  configPath: string;
  historyPath: string;
  runtimePath: string;
}

export interface TimerCompletionEvent {
  completedMode: TimerMode;
  nextMode: TimerMode;
  completedAt: string;
  startedAt: string;
  completedFocusCountInCycle: number;
  label: string;
  durationMinutes: number;
}

export interface TimerTransitionResult {
  nextState: RuntimeState;
  completionEvent: TimerCompletionEvent | null;
}

export const DEFAULT_CONFIG: PomoConfig = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
  notificationsEnabled: true
};

export const CONFIG_DIRECTORY_RELATIVE_PATH = '.config/pomo';

export const MODE_LABELS: Record<TimerMode, string> = {
  focus: 'Focus',
  shortBreak: 'Short Break',
  longBreak: 'Long Break'
};

export const MODE_ACCENTS: Record<TimerMode, string> = {
  focus: 'cyan',
  shortBreak: 'green',
  longBreak: 'magenta'
};

export const TIMER_TICK_INTERVAL_MS = 250;
