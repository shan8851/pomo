import { randomUUID } from 'node:crypto';

import blessed from 'neo-blessed';

import {
  appendHistoryRecord,
  clearRuntimeRecord,
  getStoragePaths,
  loadConfig,
  loadHistory,
  readLinuxProcessStartTicks,
  saveConfig,
  saveRuntimeRecord
} from './storage.js';
import {
  calculateTodayStats,
  formatClock,
  getRecentHistoryEntries
} from './stats.js';
import {
  createInitialRuntimeState,
  getProgressRatio,
  nextPhase,
  reconcileStateWithConfig,
  resetTimer,
  setCurrentLabel,
  skipBreak,
  tickTimer,
  toggleStartPause
} from './timer.js';
import {
  MODE_ACCENTS,
  MODE_LABELS,
  TIMER_TICK_INTERVAL_MS
} from './types.js';
import type {
  PomoConfig,
  RuntimeState,
  SessionRecord,
  TimerMode,
  TimerTransitionResult
} from './types.js';

interface LaunchTuiOptions {
  initialLabel?: string;
}

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

const BIG_DIGITS: Record<string, [string, string, string, string, string]> = {
  '0': [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  '1': ['  █  ', ' ██  ', '  █  ', '  █  ', ' ███ '],
  '2': [' ███ ', '    █', ' ███ ', '█    ', '█████'],
  '3': ['████ ', '    █', ' ███ ', '    █', '████ '],
  '4': ['█  █ ', '█  █ ', '█████', '   █ ', '   █ '],
  '5': ['█████', '█    ', '████ ', '    █', '████ '],
  '6': [' ███ ', '█    ', '████ ', '█   █', ' ███ '],
  '7': ['█████', '    █', '   █ ', '  █  ', '  █  '],
  '8': [' ███ ', '█   █', ' ███ ', '█   █', ' ███ '],
  '9': [' ███ ', '█   █', ' ████', '    █', ' ███ '],
  ':': ['     ', '  █  ', '     ', '  █  ', '     ']
};
const FALLBACK_GLYPH: [string, string, string, string, string] = [
  ' ███ ',
  '█   █',
  '█   █',
  '█   █',
  ' ███ '
];

const toNumber = (value: number | string): number =>
  typeof value === 'number' ? value : Number.parseInt(value, 10);

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

const createBigClock = (clockValue: string): string => {
  const glyphRows = [0, 1, 2, 3, 4].map(() => '');

  const mergedRows = clockValue.split('').reduce((rowsAccumulator, character) => {
    const glyph = BIG_DIGITS[character] ?? FALLBACK_GLYPH;

    return rowsAccumulator.map((existingRow, rowIndex) =>
      `${existingRow}${existingRow.length > 0 ? '  ' : ''}${glyph[rowIndex]}`
    );
  }, glyphRows);

  return mergedRows.join('\n');
};

const createProgressBar = (progressRatio: number, width: number = 28): string => {
  const clampedRatio = Math.max(0, Math.min(1, progressRatio));
  const filledCells = Math.round(clampedRatio * width);
  const emptyCells = Math.max(0, width - filledCells);
  const percent = Math.round(clampedRatio * 100)
    .toString()
    .padStart(3, ' ');

  return `[${'█'.repeat(filledCells)}${'░'.repeat(emptyCells)}] ${percent}%`;
};

const createProgressRing = (progressRatio: number): string => {
  const totalSegments = 12;
  const filledSegments = Math.round(Math.max(0, Math.min(1, progressRatio)) * totalSegments);

  return Array.from({ length: totalSegments }, (_, index) =>
    index < filledSegments ? '●' : '○'
  ).join('');
};

const FOOTER_COMMAND_BAR_HEIGHT = 3;
const FOOTER_STATUS_LINE_HEIGHT = 1;
const FOOTER_SUMMARY_HEIGHT = 4;
const RECENT_HISTORY_MODAL_LIMIT = 12;

const formatHistoryTimestamp = (timestamp: string): string => {
  const parsedTimestamp = new Date(timestamp);

  if (Number.isNaN(parsedTimestamp.getTime())) {
    return timestamp;
  }

  const year = parsedTimestamp.getFullYear();
  const month = String(parsedTimestamp.getMonth() + 1).padStart(2, '0');
  const day = String(parsedTimestamp.getDate()).padStart(2, '0');
  const hours = String(parsedTimestamp.getHours()).padStart(2, '0');
  const minutes = String(parsedTimestamp.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

const buildSessionRecordFromCompletion = (
  completionTimestampStart: string,
  completionTimestampEnd: string,
  label: string,
  durationMinutes: number
): SessionRecord => ({
  id: randomUUID(),
  timestampStart: completionTimestampStart,
  timestampEnd: completionTimestampEnd,
  mode: 'focus',
  label,
  durationMinutes,
  completed: true
});

const getSettingsItems = (config: PomoConfig, runtimeState: RuntimeState): string[] => [
  `Focus minutes: ${config.focusMinutes}`,
  `Short break: ${config.shortBreakMinutes}`,
  `Long break: ${config.longBreakMinutes}`,
  `Sessions/long break: ${config.sessionsBeforeLongBreak}`,
  `Task label: ${runtimeState.currentLabel || '(none)'}`
];

const getModeBorderColor = (mode: TimerMode): string => MODE_ACCENTS[mode];

export const launchTui = async (options: LaunchTuiOptions = {}): Promise<void> => {
  const storagePaths = getStoragePaths();
  const runtimeSessionId = randomUUID();
  const processStartTicks = await readLinuxProcessStartTicks(process.pid);
  const [loadedConfig, loadedHistory] = await Promise.all([
    loadConfig(storagePaths),
    loadHistory(storagePaths)
  ]);

  let currentConfig = loadedConfig;
  let historyRecords = loadedHistory;
  let runtimeState = createInitialRuntimeState(currentConfig, {
    currentLabel: options.initialLabel ?? ''
  });
  let selectedSettingsIndex = 0;
  let isPromptOpen = false;
  let isHistoryModalOpen = false;
  let latestStatusMessage = '';
  let latestStatusColor = 'white';
  let statusTimeoutId: NodeJS.Timeout | null = null;

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: 'pomo',
    dockBorders: true
  });

  const headerBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    border: 'line',
    tags: true,
    style: {
      border: { fg: 'white' },
      fg: 'white'
    }
  });

  const centerBox = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: '100%',
    bottom: FOOTER_COMMAND_BAR_HEIGHT + FOOTER_STATUS_LINE_HEIGHT + FOOTER_SUMMARY_HEIGHT,
    border: 'line',
    style: {
      border: { fg: 'white' },
      fg: 'white'
    }
  });

  const timerBox = blessed.box({
    parent: centerBox,
    top: 0,
    left: 0,
    bottom: 0,
    right: 34,
    border: 'line',
    tags: true,
    label: ' Timer '
  });

  const modeBox = blessed.box({
    parent: timerBox,
    top: 1,
    left: 2,
    right: 2,
    height: 1,
    align: 'center',
    tags: true
  });

  const clockBox = blessed.box({
    parent: timerBox,
    top: 'center',
    left: 2,
    right: 2,
    height: 7,
    align: 'center',
    tags: true
  });

  const progressBox = blessed.box({
    parent: timerBox,
    bottom: 3,
    left: 2,
    right: 2,
    height: 2,
    align: 'center',
    tags: true
  });

  const labelBox = blessed.box({
    parent: timerBox,
    bottom: 1,
    left: 2,
    right: 2,
    height: 1,
    align: 'center',
    tags: true
  });

  const settingsBox = blessed.box({
    parent: centerBox,
    top: 0,
    right: 0,
    bottom: 0,
    width: 34,
    border: 'line',
    label: ' Settings ',
    style: {
      border: { fg: 'white' },
      fg: 'white'
    }
  });

  const settingsList = blessed.list({
    parent: settingsBox,
    top: 1,
    left: 1,
    right: 1,
    bottom: 1,
    tags: true,
    keys: false,
    vi: false,
    mouse: false,
    style: {
      item: { fg: 'white' },
      selected: { fg: 'black', bg: 'cyan', bold: true }
    }
  });

  const summaryBox = blessed.box({
    parent: screen,
    bottom: FOOTER_COMMAND_BAR_HEIGHT + FOOTER_STATUS_LINE_HEIGHT,
    left: 0,
    width: '100%',
    height: FOOTER_SUMMARY_HEIGHT,
    border: 'line',
    tags: true,
    label: ' Daily Summary ',
    style: {
      border: { fg: 'white' },
      fg: 'white'
    }
  });

  const statusLineBox = blessed.box({
    parent: screen,
    bottom: FOOTER_COMMAND_BAR_HEIGHT,
    left: 0,
    width: '100%',
    height: FOOTER_STATUS_LINE_HEIGHT,
    tags: false,
    style: {
      fg: 'white'
    }
  });

  const commandBarBox = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: FOOTER_COMMAND_BAR_HEIGHT,
    border: 'line',
    tags: true,
    label: ' Commands ',
    style: {
      border: { fg: 'white' },
      fg: 'white'
    }
  });

  const prompt = blessed.prompt({
    parent: screen,
    border: 'line',
    width: '60%',
    height: 8,
    top: 'center',
    left: 'center',
    label: ' Edit ',
    tags: true,
    keys: true,
    vi: true,
    hidden: true
  });

  const historyModal = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '88%',
    height: '70%',
    border: 'line',
    tags: true,
    hidden: true,
    scrollable: true,
    alwaysScroll: true,
    label: ' Recent History ',
    style: {
      border: { fg: 'cyan' },
      fg: 'white',
      bg: 'black'
    }
  });

  const updateResponsiveLayout = (): void => {
    const screenWidth = toNumber(screen.width);
    const screenHeight = toNumber(screen.height);

    const settingsWidth = screenWidth >= 110 ? 34 : 28;
    settingsBox.width = settingsWidth;
    timerBox.right = settingsWidth;

    if (screenWidth < 86) {
      headerBox.height = 4;
      centerBox.top = 4;
    } else {
      headerBox.height = 3;
      centerBox.top = 3;
    }

    historyModal.width = Math.max(60, screenWidth - 10);
    historyModal.height = Math.max(12, screenHeight - 6);

    screen.render();
  };

  const setStatusLine = (message: string, color: string): void => {
    latestStatusMessage = message;
    latestStatusColor = color;

    if (statusTimeoutId !== null) {
      clearTimeout(statusTimeoutId);
    }

    renderEverything();

    statusTimeoutId = setTimeout(() => {
      latestStatusMessage = '';
      latestStatusColor = 'white';
      renderEverything();
    }, 3000);
  };

  const notifyDesktop = async (title: string, message: string): Promise<void> => {
    if (!currentConfig.notificationsEnabled) {
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

  const persistRuntimeState = (): void => {
    void saveRuntimeRecord(storagePaths, {
      pid: process.pid,
      source: 'tui',
      runtimeSessionId,
      processStartTicks,
      updatedAt: new Date().toISOString(),
      state: runtimeState
    }).catch(() => {
      // Runtime persistence is best-effort.
    });
  };

  const renderHeader = (): void => {
    const modeColor = getModeBorderColor(runtimeState.mode);
    const modeLabel = MODE_LABELS[runtimeState.mode];
    const stateLabel = runtimeState.status.toUpperCase();

    headerBox.style.border.fg = modeColor;
    headerBox.setContent(
      `{bold}pomo{/bold}  {${modeColor}-fg}${modeLabel}{/${modeColor}-fg}  [{bold}${stateLabel}{/bold}]`
    );
  };

  const renderTimerPanel = (): void => {
    const modeColor = getModeBorderColor(runtimeState.mode);
    const progressRatio = getProgressRatio(runtimeState, currentConfig);
    const clockText = formatClock(runtimeState.remainingSeconds);

    timerBox.style.border.fg = modeColor;

    modeBox.setContent(
      `{bold}{${modeColor}-fg}${MODE_LABELS[runtimeState.mode]}{/${modeColor}-fg}{/bold}`
    );
    clockBox.setContent(createBigClock(clockText));
    progressBox.setContent(
      `${createProgressRing(progressRatio)}\n${createProgressBar(progressRatio)}`
    );
    labelBox.setContent(`Task: {bold}${runtimeState.currentLabel || '(none)'}{/bold}`);
  };

  const renderSettings = (): void => {
    settingsList.setItems(getSettingsItems(currentConfig, runtimeState));
    settingsList.select(selectedSettingsIndex);
  };

  const renderDailySummary = (): void => {
    const todayStats = calculateTodayStats(historyRecords);
    const lastSession = getRecentHistoryEntries(historyRecords, 1)[0] ?? null;
    const lastSessionText =
      lastSession === null
        ? 'No completed sessions yet.'
        : `${formatHistoryTimestamp(lastSession.timestampEnd)}  ` +
          `${lastSession.label || '(no label)'}  ${lastSession.durationMinutes}m`;

    summaryBox.setContent(
      `Today sessions: {bold}${todayStats.completedFocusSessions}{/bold}  |  ` +
        `Focused minutes: {bold}${todayStats.totalFocusedMinutes}{/bold}\n` +
        `Last session: ${lastSessionText}`
    );
  };

  const renderStatusLine = (): void => {
    const fallbackStatusLine =
      `Status: ${MODE_LABELS[runtimeState.mode]} | ` +
      `${runtimeState.status.toUpperCase()} | ` +
      `${formatClock(runtimeState.remainingSeconds)}`;

    statusLineBox.style.fg = latestStatusMessage.length > 0 ? latestStatusColor : 'white';
    statusLineBox.setContent(latestStatusMessage.length > 0 ? latestStatusMessage : fallbackStatusLine);
  };

  const renderCommandBar = (): void => {
    commandBarBox.setContent(
      'space start/pause | r reset | n next | s skip | h history | j/k or arrows navigate | enter edit | q quit'
    );
  };

  const renderHistoryModal = (): void => {
    if (!isHistoryModalOpen) {
      historyModal.hide();
      return;
    }

    const recentHistory = getRecentHistoryEntries(historyRecords, RECENT_HISTORY_MODAL_LIMIT);
    const historyContent =
      recentHistory.length === 0
        ? 'No completed sessions yet.'
        : recentHistory
            .map(
              (record) =>
                `${formatHistoryTimestamp(record.timestampEnd)}  ${MODE_LABELS[record.mode]}  ` +
                `${record.label || '(no label)'}  ${record.durationMinutes}m`
            )
            .join('\n');

    historyModal.setContent(`${historyContent}\n\nPress h or Esc to close.`);
    historyModal.show();
    historyModal.setFront();
  };

  const renderEverything = (): void => {
    renderHeader();
    renderTimerPanel();
    renderSettings();
    renderDailySummary();
    renderStatusLine();
    renderCommandBar();
    renderHistoryModal();

    screen.render();
  };

  const updateFromTransition = (transitionResult: TimerTransitionResult): void => {
    runtimeState = transitionResult.nextState;
    persistRuntimeState();
    renderEverything();

    if (transitionResult.completionEvent === null) {
      return;
    }

    const completionModeColor = getModeBorderColor(transitionResult.completionEvent.completedMode);
    const completionModeLabel = MODE_LABELS[transitionResult.completionEvent.completedMode];

    screen.program.bel();
    setStatusLine(
      `${completionModeLabel} ended. Next: ${MODE_LABELS[transitionResult.completionEvent.nextMode]}`,
      completionModeColor
    );

    if (transitionResult.completionEvent.completedMode === 'focus') {
      const completedFocusRecord = buildSessionRecordFromCompletion(
        transitionResult.completionEvent.startedAt,
        transitionResult.completionEvent.completedAt,
        transitionResult.completionEvent.label,
        transitionResult.completionEvent.durationMinutes
      );

      historyRecords = [...historyRecords, completedFocusRecord];
      void appendHistoryRecord(storagePaths, completedFocusRecord).catch(() => {
        setStatusLine('Failed to save focus history.', 'red');
      });
    }

    void notifyDesktop(
      'pomo timer',
      `${completionModeLabel} finished. ${MODE_LABELS[transitionResult.completionEvent.nextMode]} is ready.`
    );

    renderEverything();
  };

  const editSetting = (promptLabel: string, initialValue: string): Promise<string | null> =>
    new Promise((resolve) => {
      isPromptOpen = true;
      prompt.input(promptLabel, initialValue, (_inputError, value) => {
        isPromptOpen = false;
        resolve(typeof value === 'string' ? value.trim() : null);
      });
    });

  const editSelectedSetting = async (): Promise<void> => {
    const selectedIndex = selectedSettingsIndex;

    if (selectedIndex === 0) {
      const value = await editSetting('Focus minutes', String(currentConfig.focusMinutes));

      if (value === null || value.length === 0) {
        renderEverything();
        return;
      }

      const nextValue = Number.parseInt(value, 10);

      if (!Number.isFinite(nextValue) || nextValue < 1) {
        setStatusLine('Focus minutes must be a positive integer.', 'red');
        return;
      }

      currentConfig = await saveConfig(storagePaths, {
        ...currentConfig,
        focusMinutes: nextValue
      });
      runtimeState = reconcileStateWithConfig(runtimeState, currentConfig);
      persistRuntimeState();
      renderEverything();
      setStatusLine('Updated focus minutes.', 'green');
      return;
    }

    if (selectedIndex === 1) {
      const value = await editSetting('Short break minutes', String(currentConfig.shortBreakMinutes));

      if (value === null || value.length === 0) {
        renderEverything();
        return;
      }

      const nextValue = Number.parseInt(value, 10);

      if (!Number.isFinite(nextValue) || nextValue < 1) {
        setStatusLine('Short break minutes must be a positive integer.', 'red');
        return;
      }

      currentConfig = await saveConfig(storagePaths, {
        ...currentConfig,
        shortBreakMinutes: nextValue
      });
      runtimeState = reconcileStateWithConfig(runtimeState, currentConfig);
      persistRuntimeState();
      renderEverything();
      setStatusLine('Updated short break minutes.', 'green');
      return;
    }

    if (selectedIndex === 2) {
      const value = await editSetting('Long break minutes', String(currentConfig.longBreakMinutes));

      if (value === null || value.length === 0) {
        renderEverything();
        return;
      }

      const nextValue = Number.parseInt(value, 10);

      if (!Number.isFinite(nextValue) || nextValue < 1) {
        setStatusLine('Long break minutes must be a positive integer.', 'red');
        return;
      }

      currentConfig = await saveConfig(storagePaths, {
        ...currentConfig,
        longBreakMinutes: nextValue
      });
      runtimeState = reconcileStateWithConfig(runtimeState, currentConfig);
      persistRuntimeState();
      renderEverything();
      setStatusLine('Updated long break minutes.', 'green');
      return;
    }

    if (selectedIndex === 3) {
      const value = await editSetting(
        'Focus sessions before long break',
        String(currentConfig.sessionsBeforeLongBreak)
      );

      if (value === null || value.length === 0) {
        renderEverything();
        return;
      }

      const nextValue = Number.parseInt(value, 10);

      if (!Number.isFinite(nextValue) || nextValue < 1) {
        setStatusLine('Sessions/long break must be a positive integer.', 'red');
        return;
      }

      currentConfig = await saveConfig(storagePaths, {
        ...currentConfig,
        sessionsBeforeLongBreak: nextValue
      });
      runtimeState = reconcileStateWithConfig(runtimeState, currentConfig);
      persistRuntimeState();
      renderEverything();
      setStatusLine('Updated sessions before long break.', 'green');
      return;
    }

    const value = await editSetting('Task label', runtimeState.currentLabel);

    if (value === null) {
      renderEverything();
      return;
    }

    runtimeState = setCurrentLabel(runtimeState, value).nextState;
    persistRuntimeState();
    renderEverything();
    setStatusLine('Updated task label.', 'green');
  };

  const isInteractionBlocked = (): boolean => isPromptOpen || isHistoryModalOpen;

  await new Promise<void>((resolve) => {
    let hasShutdown = false;

    const onSigint = (): void => {
      void shutdown();
    };
    const onSigterm = (): void => {
      void shutdown();
    };

    const tickInterval = setInterval(() => {
      const transitionResult = tickTimer(runtimeState, currentConfig, Date.now());

      if (transitionResult.nextState !== runtimeState || transitionResult.completionEvent !== null) {
        updateFromTransition(transitionResult);
      }
    }, TIMER_TICK_INTERVAL_MS);

    const shutdown = async (): Promise<void> => {
      if (hasShutdown) {
        return;
      }

      hasShutdown = true;
      clearInterval(tickInterval);

      if (statusTimeoutId !== null) {
        clearTimeout(statusTimeoutId);
      }

      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);

      await clearRuntimeRecord(storagePaths);
      screen.destroy();
      resolve();
    };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    screen.key(['q', 'C-c'], () => {
      void shutdown();
    });

    screen.key(['space'], () => {
      if (isInteractionBlocked()) {
        return;
      }

      const transitionResult = toggleStartPause(runtimeState, Date.now());
      updateFromTransition(transitionResult);

      if (transitionResult.nextState.status === 'running') {
        setStatusLine('Timer started.', getModeBorderColor(transitionResult.nextState.mode));
        return;
      }

      setStatusLine('Timer paused.', 'yellow');
    });

    screen.key(['r'], () => {
      if (isInteractionBlocked()) {
        return;
      }

      updateFromTransition(resetTimer(runtimeState, currentConfig));
      setStatusLine('Timer reset.', 'cyan');
    });

    screen.key(['n'], () => {
      if (isInteractionBlocked()) {
        return;
      }

      const transitionResult = nextPhase(runtimeState, currentConfig);
      updateFromTransition(transitionResult);
      setStatusLine(
        `Switched to ${MODE_LABELS[transitionResult.nextState.mode]}.`,
        getModeBorderColor(transitionResult.nextState.mode)
      );
    });

    screen.key(['s'], () => {
      if (isInteractionBlocked()) {
        return;
      }

      if (runtimeState.mode === 'focus') {
        setStatusLine('Skip works only during breaks.', 'yellow');
        return;
      }

      const transitionResult = skipBreak(runtimeState, currentConfig);
      updateFromTransition(transitionResult);
      setStatusLine('Skipped break. Back to Focus.', 'cyan');
    });

    screen.key(['h'], () => {
      if (isPromptOpen) {
        return;
      }

      isHistoryModalOpen = !isHistoryModalOpen;
      renderEverything();
      setStatusLine(isHistoryModalOpen ? 'Opened recent history.' : 'Closed recent history.', 'cyan');
    });

    screen.key(['escape'], () => {
      if (isPromptOpen || !isHistoryModalOpen) {
        return;
      }

      isHistoryModalOpen = false;
      renderEverything();
      setStatusLine('Closed recent history.', 'cyan');
    });

    screen.key(['j', 'down'], () => {
      if (isInteractionBlocked()) {
        return;
      }

      selectedSettingsIndex =
        (selectedSettingsIndex + 1) % getSettingsItems(currentConfig, runtimeState).length;
      renderEverything();
    });

    screen.key(['k', 'up'], () => {
      if (isInteractionBlocked()) {
        return;
      }

      const totalItems = getSettingsItems(currentConfig, runtimeState).length;
      selectedSettingsIndex = (selectedSettingsIndex - 1 + totalItems) % totalItems;
      renderEverything();
    });

    screen.key(['enter'], () => {
      if (isInteractionBlocked()) {
        return;
      }

      void editSelectedSetting();
    });

    screen.on('resize', () => {
      updateResponsiveLayout();
      renderEverything();
    });

    persistRuntimeState();
    updateResponsiveLayout();
    renderEverything();
  });
};
