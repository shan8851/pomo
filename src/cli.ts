#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

import {
  appendHistoryRecord,
  clearRuntimeRecord,
  getStoragePaths,
  isRuntimeRecordActive,
  loadConfig,
  loadHistory,
  loadRuntimeRecord,
  readLinuxProcessStartTicks,
  saveHistory,
  saveRuntimeRecord
} from './storage.js';
import {
  calculateTodayStats,
  filterHistoryForToday,
  formatClock
} from './stats.js';
import {
  createInitialRuntimeState,
  tickTimer,
  toggleStartPause
} from './timer.js';
import { launchTui } from './tui.js';
import { MODE_LABELS, TIMER_TICK_INTERVAL_MS } from './types.js';
import type {
  RuntimeState,
  SessionRecord,
  TimerCompletionEvent
} from './types.js';

interface NotifierShape {
  notify: (
    payload: {
      title: string;
      message: string;
      wait?: boolean;
      sound?: boolean;
    },
    callback?: () => void
  ) => void;
}

const getNotifier = async (): Promise<NotifierShape | null> => {
  try {
    const notifierModule: unknown = await import('node-notifier');

    if (
      typeof notifierModule === 'object' &&
      notifierModule !== null &&
      'default' in notifierModule
    ) {
      const notifierCandidate = Reflect.get(notifierModule, 'default');

      if (
        typeof notifierCandidate === 'object' &&
        notifierCandidate !== null &&
        'notify' in notifierCandidate
      ) {
        const notifyMethod = Reflect.get(notifierCandidate, 'notify');

        if (typeof notifyMethod === 'function') {
          return {
            notify: notifyMethod.bind(notifierCandidate) as NotifierShape['notify']
          };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
};

const notifyDesktop = async (
  enabled: boolean,
  title: string,
  message: string
): Promise<void> => {
  if (!enabled) {
    return;
  }

  const notifier = await getNotifier();

  if (notifier === null) {
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      notifier.notify({
        title,
        message,
        sound: false,
        wait: false
      }, () => {
        resolve();
      });
    } catch {
      resolve();
    }

    setTimeout(resolve, 200);
  });
};

const printUsage = (): void => {
  const usage = [
    'Usage:',
    '  pomo',
    '  pomo tui',
    '  pomo start "task name"',
    '  pomo status',
    '  pomo stats --today',
    '  pomo reset-day'
  ];

  console.log(usage.join('\n'));
};

const toStatusLine = (runtimeState: RuntimeState): string => {
  const labelText = runtimeState.currentLabel.length > 0 ? runtimeState.currentLabel : '(none)';

  return `${MODE_LABELS[runtimeState.mode]} | ${runtimeState.status} | ${formatClock(runtimeState.remainingSeconds)} | label: ${labelText}`;
};

const buildCompletedFocusRecord = (
  completionEvent: TimerCompletionEvent
): SessionRecord => {
  return {
    id: randomUUID(),
    timestampStart: completionEvent.startedAt,
    timestampEnd: completionEvent.completedAt,
    mode: 'focus',
    label: completionEvent.label,
    durationMinutes: completionEvent.durationMinutes,
    completed: true
  };
};

const runStartCommand = async (taskLabel: string): Promise<void> => {
  const storagePaths = getStoragePaths();
  const config = await loadConfig(storagePaths);
  const runtimeSessionId = randomUUID();
  const processStartTicks = await readLinuxProcessStartTicks(process.pid);

  let runtimeState = createInitialRuntimeState(config, {
    mode: 'focus',
    currentLabel: taskLabel
  });

  runtimeState = toggleStartPause(runtimeState).nextState;

  await new Promise<void>((resolve) => {
    let lastRenderedSecond = runtimeState.remainingSeconds;
    let isShuttingDown = false;
    let tickInterval: NodeJS.Timeout | null = null;

    const onSigint = (): void => {
      void cleanup();
    };
    const onSigterm = (): void => {
      void cleanup();
    };

    const persistRuntimeState = (): void => {
      void saveRuntimeRecord(storagePaths, {
        pid: process.pid,
        source: 'start',
        runtimeSessionId,
        processStartTicks,
        updatedAt: new Date().toISOString(),
        state: runtimeState
      });
    };

    const cleanup = async (): Promise<void> => {
      if (isShuttingDown) {
        return;
      }

      isShuttingDown = true;

      if (tickInterval !== null) {
        clearInterval(tickInterval);
      }

      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      await clearRuntimeRecord(storagePaths);
      process.stdout.write('\n');
      resolve();
    };

    persistRuntimeState();

    process.stdout.write(
      `Starting focus timer (${config.focusMinutes}m)${taskLabel.length > 0 ? `: ${taskLabel}` : ''}\n`
    );

    tickInterval = setInterval(() => {
      const transitionResult = tickTimer(runtimeState, config, Date.now());
      runtimeState = transitionResult.nextState;

      if (runtimeState.remainingSeconds !== lastRenderedSecond) {
        lastRenderedSecond = runtimeState.remainingSeconds;
        process.stdout.write(`\r${toStatusLine(runtimeState)}   `);
        persistRuntimeState();
      }

      const completionEvent = transitionResult.completionEvent;

      if (completionEvent === null) {
        return;
      }

      process.stdout.write('\x07');

      if (completionEvent.completedMode !== 'focus') {
        void cleanup();
        return;
      }

      void (async () => {
        const completedRecord = buildCompletedFocusRecord(completionEvent);
        await appendHistoryRecord(storagePaths, completedRecord);
        process.stdout.write('\nFocus complete. Session saved to history.\n');
        await notifyDesktop(
          config.notificationsEnabled,
          'pomo timer',
          'Focus session complete. Break is ready.'
        );
        await cleanup();
      })().catch(async () => {
        process.stdout.write('\nFocus complete, but saving history failed.\n');
        await cleanup();
      });
    }, TIMER_TICK_INTERVAL_MS);

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  });
};

const runStatusCommand = async (): Promise<void> => {
  const storagePaths = getStoragePaths();
  const [history, runtimeRecord] = await Promise.all([
    loadHistory(storagePaths),
    loadRuntimeRecord(storagePaths)
  ]);
  const todayStats = calculateTodayStats(history);

  if (runtimeRecord !== null && (await isRuntimeRecordActive(runtimeRecord))) {
    console.log(`Status: ${toStatusLine(runtimeRecord.state)}`);
  } else {
    if (runtimeRecord !== null) {
      await clearRuntimeRecord(storagePaths);
    }

    console.log('Status: idle');
  }

  console.log(`Today focus sessions: ${todayStats.completedFocusSessions}`);
  console.log(`Today focused minutes: ${todayStats.totalFocusedMinutes}`);
};

const runStatsCommand = async (flags: string[]): Promise<void> => {
  if (flags.length > 0 && !flags.includes('--today')) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const storagePaths = getStoragePaths();
  const history = await loadHistory(storagePaths);
  const todayStats = calculateTodayStats(history);

  console.log(`Focus sessions today: ${todayStats.completedFocusSessions}`);
  console.log(`Focused minutes today: ${todayStats.totalFocusedMinutes}`);
};

const runResetDayCommand = async (): Promise<void> => {
  const storagePaths = getStoragePaths();
  const history = await loadHistory(storagePaths);
  const todaysHistory = filterHistoryForToday(history);
  const todaySessionIds = new Set(todaysHistory.map((historyRecord) => historyRecord.id));

  const nextHistory = history.filter((historyRecord) => !todaySessionIds.has(historyRecord.id));
  await saveHistory(storagePaths, nextHistory);

  const todayStats = calculateTodayStats(nextHistory);
  console.log(`Removed ${todaysHistory.length} records for today.`);
  console.log(`Focus sessions today: ${todayStats.completedFocusSessions}`);
  console.log(`Focused minutes today: ${todayStats.totalFocusedMinutes}`);
};

const main = async (): Promise<void> => {
  const [, , command, ...args] = process.argv;

  if (command === undefined || command === 'tui') {
    await launchTui();
    return;
  }

  if (command === 'start') {
    const taskLabel = args.join(' ').trim();
    await runStartCommand(taskLabel);
    return;
  }

  if (command === 'status') {
    await runStatusCommand();
    return;
  }

  if (command === 'stats') {
    await runStatsCommand(args);
    return;
  }

  if (command === 'reset-day') {
    await runResetDayCommand();
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    return;
  }

  printUsage();
  process.exitCode = 1;
};

void main().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error(`pomo failed: ${errorMessage}`);
  process.exitCode = 2;
});
