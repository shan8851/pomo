import type {
  PomoConfig,
  RuntimeState,
  TimerCompletionEvent,
  TimerMode,
  TimerTransitionResult
} from './types.js';

const getModeDurationMinutes = (mode: TimerMode, config: PomoConfig): number => {
  if (mode === 'focus') {
    return config.focusMinutes;
  }

  if (mode === 'shortBreak') {
    return config.shortBreakMinutes;
  }

  return config.longBreakMinutes;
};

export const getModeDurationSeconds = (mode: TimerMode, config: PomoConfig): number =>
  getModeDurationMinutes(mode, config) * 60;

const transitionToMode = (
  mode: TimerMode,
  config: PomoConfig,
  completedFocusCountInCycle: number,
  currentLabel: string
): RuntimeState => ({
  mode,
  status: 'idle',
  remainingSeconds: getModeDurationSeconds(mode, config),
  targetEndEpochMs: null,
  currentLabel,
  completedFocusCountInCycle,
  startedAt: null,
  pausedAt: null
});

const resolveBreakMode = (completedFocusCountInCycle: number, config: PomoConfig): TimerMode => {
  const shouldTriggerLongBreak =
    completedFocusCountInCycle > 0 &&
    completedFocusCountInCycle % config.sessionsBeforeLongBreak === 0;

  return shouldTriggerLongBreak ? 'longBreak' : 'shortBreak';
};

const buildCompletionEvent = (
  state: RuntimeState,
  config: PomoConfig,
  nowEpochMs: number,
  nextMode: TimerMode,
  completedFocusCountInCycle: number
): TimerCompletionEvent => {
  const completedAtIso = new Date(nowEpochMs).toISOString();
  const fallbackStartedAtEpoch = nowEpochMs - getModeDurationSeconds(state.mode, config) * 1000;

  return {
    completedMode: state.mode,
    nextMode,
    completedAt: completedAtIso,
    startedAt: state.startedAt ?? new Date(fallbackStartedAtEpoch).toISOString(),
    completedFocusCountInCycle,
    label: state.currentLabel,
    durationMinutes: getModeDurationMinutes(state.mode, config)
  };
};

const maybeTransitionOnCompletion = (
  state: RuntimeState,
  config: PomoConfig,
  nowEpochMs: number
): TimerTransitionResult => {
  if (state.status !== 'running' || state.targetEndEpochMs === null) {
    return {
      nextState: state,
      completionEvent: null
    };
  }

  const nextRemainingSeconds = Math.max(0, Math.ceil((state.targetEndEpochMs - nowEpochMs) / 1000));

  if (nextRemainingSeconds > 0) {
    if (nextRemainingSeconds === state.remainingSeconds) {
      return {
        nextState: state,
        completionEvent: null
      };
    }

    return {
      nextState: {
        ...state,
        remainingSeconds: nextRemainingSeconds
      },
      completionEvent: null
    };
  }

  const nextCompletedFocusCountInCycle =
    state.mode === 'focus'
      ? state.completedFocusCountInCycle + 1
      : state.completedFocusCountInCycle;

  const nextMode =
    state.mode === 'focus'
      ? resolveBreakMode(nextCompletedFocusCountInCycle, config)
      : 'focus';

  return {
    nextState: transitionToMode(
      nextMode,
      config,
      nextCompletedFocusCountInCycle,
      state.currentLabel
    ),
    completionEvent: buildCompletionEvent(
      state,
      config,
      nowEpochMs,
      nextMode,
      nextCompletedFocusCountInCycle
    )
  };
};

export const createInitialRuntimeState = (
  config: PomoConfig,
  overrides: Partial<RuntimeState> = {}
): RuntimeState => {
  const runtimeMode = overrides.mode ?? 'focus';

  return {
    mode: runtimeMode,
    status: overrides.status ?? 'idle',
    remainingSeconds:
      overrides.remainingSeconds ?? getModeDurationSeconds(runtimeMode, config),
    targetEndEpochMs: overrides.targetEndEpochMs ?? null,
    currentLabel: overrides.currentLabel ?? '',
    completedFocusCountInCycle: overrides.completedFocusCountInCycle ?? 0,
    startedAt: overrides.startedAt ?? null,
    pausedAt: overrides.pausedAt ?? null
  };
};

export const startTimer = (
  state: RuntimeState,
  nowEpochMs: number = Date.now()
): TimerTransitionResult => {
  if (state.status === 'running') {
    return {
      nextState: state,
      completionEvent: null
    };
  }

  return {
    nextState: {
      ...state,
      status: 'running',
      targetEndEpochMs: nowEpochMs + state.remainingSeconds * 1000,
      startedAt: state.startedAt ?? new Date(nowEpochMs).toISOString(),
      pausedAt: null
    },
    completionEvent: null
  };
};

export const pauseTimer = (
  state: RuntimeState,
  nowEpochMs: number = Date.now()
): TimerTransitionResult => {
  if (state.status !== 'running' || state.targetEndEpochMs === null) {
    return {
      nextState: state,
      completionEvent: null
    };
  }

  const nextRemainingSeconds = Math.max(0, Math.ceil((state.targetEndEpochMs - nowEpochMs) / 1000));

  return {
    nextState: {
      ...state,
      status: 'paused',
      remainingSeconds: nextRemainingSeconds,
      targetEndEpochMs: null,
      pausedAt: new Date(nowEpochMs).toISOString()
    },
    completionEvent: null
  };
};

export const resetTimer = (state: RuntimeState, config: PomoConfig): TimerTransitionResult => ({
  nextState: {
    ...state,
    status: 'idle',
    remainingSeconds: getModeDurationSeconds(state.mode, config),
    targetEndEpochMs: null,
    startedAt: null,
    pausedAt: null
  },
  completionEvent: null
});

export const nextPhase = (state: RuntimeState, config: PomoConfig): TimerTransitionResult => {
  if (state.mode === 'focus') {
    const nextCompletedFocusCountInCycle = state.completedFocusCountInCycle + 1;
    const nextMode = resolveBreakMode(nextCompletedFocusCountInCycle, config);

    return {
      nextState: transitionToMode(
        nextMode,
        config,
        nextCompletedFocusCountInCycle,
        state.currentLabel
      ),
      completionEvent: null
    };
  }

  const nextMode: TimerMode = 'focus';

  return {
    nextState: transitionToMode(
      nextMode,
      config,
      state.completedFocusCountInCycle,
      state.currentLabel
    ),
    completionEvent: null
  };
};

export const skipBreak = (state: RuntimeState, config: PomoConfig): TimerTransitionResult => {
  if (state.mode === 'focus') {
    return {
      nextState: state,
      completionEvent: null
    };
  }

  return {
    nextState: transitionToMode(
      'focus',
      config,
      state.completedFocusCountInCycle,
      state.currentLabel
    ),
    completionEvent: null
  };
};

export const setCurrentLabel = (
  state: RuntimeState,
  label: string
): TimerTransitionResult => ({
  nextState: {
    ...state,
    currentLabel: label
  },
  completionEvent: null
});

export const tickTimer = (
  state: RuntimeState,
  config: PomoConfig,
  nowEpochMs: number = Date.now()
): TimerTransitionResult => maybeTransitionOnCompletion(state, config, nowEpochMs);

export const toggleStartPause = (
  state: RuntimeState,
  nowEpochMs: number = Date.now()
): TimerTransitionResult =>
  state.status === 'running' ? pauseTimer(state, nowEpochMs) : startTimer(state, nowEpochMs);

export const reconcileStateWithConfig = (
  state: RuntimeState,
  config: PomoConfig
): RuntimeState => {
  if (state.status !== 'idle') {
    return state;
  }

  return {
    ...state,
    remainingSeconds: getModeDurationSeconds(state.mode, config)
  };
};

export const getProgressRatio = (state: RuntimeState, config: PomoConfig): number => {
  const totalSeconds = getModeDurationSeconds(state.mode, config);

  if (totalSeconds <= 0) {
    return 0;
  }

  return Math.min(1, Math.max(0, (totalSeconds - state.remainingSeconds) / totalSeconds));
};
