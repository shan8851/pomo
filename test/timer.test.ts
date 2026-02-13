import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/types.js';
import {
  createInitialRuntimeState,
  getModeDurationSeconds,
  nextPhase,
  pauseTimer,
  reconcileStateWithConfig,
  skipBreak,
  startTimer,
  tickTimer,
  toggleStartPause
} from '../src/timer.js';

describe('timer', () => {
  it('starts, ticks, and pauses without losing state', () => {
    const startEpochMs = 1_000_000;
    const initialState = createInitialRuntimeState(DEFAULT_CONFIG);
    const started = startTimer(initialState, startEpochMs).nextState;

    expect(started.status).toBe('running');
    expect(started.targetEndEpochMs).toBe(startEpochMs + getModeDurationSeconds('focus', DEFAULT_CONFIG) * 1000);

    const ticked = tickTimer(started, DEFAULT_CONFIG, startEpochMs + 4_500).nextState;
    expect(ticked.remainingSeconds).toBe(getModeDurationSeconds('focus', DEFAULT_CONFIG) - 4);

    const paused = toggleStartPause(ticked, startEpochMs + 5_000).nextState;
    expect(paused.status).toBe('paused');
    expect(paused.targetEndEpochMs).toBeNull();
  });

  it('switches to long break on configured cycle', () => {
    const startEpochMs = 2_000_000;
    const runningFocusState = {
      ...createInitialRuntimeState(DEFAULT_CONFIG, {
        mode: 'focus',
        completedFocusCountInCycle: 3,
        status: 'running',
        remainingSeconds: 1,
        targetEndEpochMs: startEpochMs + 1_000,
        startedAt: new Date(startEpochMs - 1_000).toISOString()
      })
    };

    const transition = tickTimer(runningFocusState, DEFAULT_CONFIG, startEpochMs + 1_100);

    expect(transition.completionEvent).not.toBeNull();
    expect(transition.completionEvent?.nextMode).toBe('longBreak');
    expect(transition.nextState.mode).toBe('longBreak');
    expect(transition.nextState.completedFocusCountInCycle).toBe(4);
  });

  it('skip break always returns to focus mode', () => {
    const shortBreakState = createInitialRuntimeState(DEFAULT_CONFIG, {
      mode: 'shortBreak',
      status: 'running',
      remainingSeconds: 10,
      targetEndEpochMs: Date.now() + 10_000
    });

    const skipped = skipBreak(shortBreakState, DEFAULT_CONFIG).nextState;

    expect(skipped.mode).toBe('focus');
    expect(skipped.status).toBe('idle');
    expect(skipped.remainingSeconds).toBe(DEFAULT_CONFIG.focusMinutes * 60);
  });

  it('reconciles idle state remaining seconds when config changes', () => {
    const idleFocusState = createInitialRuntimeState(DEFAULT_CONFIG, {
      mode: 'focus',
      status: 'idle',
      remainingSeconds: 999
    });

    const reconciled = reconcileStateWithConfig(idleFocusState, {
      ...DEFAULT_CONFIG,
      focusMinutes: 30
    });

    expect(reconciled.remainingSeconds).toBe(30 * 60);
  });

  it('uses overridden mode duration when initial remaining seconds are omitted', () => {
    const shortBreakInitialState = createInitialRuntimeState(DEFAULT_CONFIG, {
      mode: 'shortBreak'
    });
    const longBreakInitialState = createInitialRuntimeState(DEFAULT_CONFIG, {
      mode: 'longBreak'
    });

    expect(shortBreakInitialState.remainingSeconds).toBe(
      DEFAULT_CONFIG.shortBreakMinutes * 60
    );
    expect(longBreakInitialState.remainingSeconds).toBe(
      DEFAULT_CONFIG.longBreakMinutes * 60
    );
  });

  it('completes immediately after large wall-clock jumps', () => {
    const startEpochMs = 5_000_000;
    const runningFocusState = startTimer(
      createInitialRuntimeState(DEFAULT_CONFIG, {
        mode: 'focus',
        currentLabel: 'jump test'
      }),
      startEpochMs
    ).nextState;

    const afterLargeJump = tickTimer(
      runningFocusState,
      DEFAULT_CONFIG,
      startEpochMs + DEFAULT_CONFIG.focusMinutes * 60 * 1_000 + 90_000
    );

    expect(afterLargeJump.completionEvent?.completedMode).toBe('focus');
    expect(afterLargeJump.nextState.mode).toBe('shortBreak');
    expect(afterLargeJump.nextState.status).toBe('idle');
  });

  it('pauses near zero boundary without underflow', () => {
    const startEpochMs = 7_000_000;
    const runningState = startTimer(
      createInitialRuntimeState(DEFAULT_CONFIG, {
        remainingSeconds: 1
      }),
      startEpochMs
    ).nextState;

    const pausedAtBoundary = pauseTimer(runningState, startEpochMs + 999).nextState;
    const pausedAfterBoundary = pauseTimer(runningState, startEpochMs + 1_001).nextState;

    expect(pausedAtBoundary.remainingSeconds).toBe(1);
    expect(pausedAfterBoundary.remainingSeconds).toBe(0);
    expect(pausedAfterBoundary.status).toBe('paused');
  });

  it('manual next phase from focus advances cadence to long break boundary', () => {
    const next = nextPhase(
      createInitialRuntimeState(DEFAULT_CONFIG, {
        mode: 'focus',
        completedFocusCountInCycle: 3
      }),
      DEFAULT_CONFIG
    ).nextState;

    expect(next.mode).toBe('longBreak');
    expect(next.status).toBe('idle');
    expect(next.completedFocusCountInCycle).toBe(4);
  });

  it('manual next phase from focus uses short break when not on long-break boundary', () => {
    const next = nextPhase(
      createInitialRuntimeState(DEFAULT_CONFIG, {
        mode: 'focus',
        completedFocusCountInCycle: 1
      }),
      DEFAULT_CONFIG
    ).nextState;

    expect(next.mode).toBe('shortBreak');
    expect(next.completedFocusCountInCycle).toBe(2);
  });
});
