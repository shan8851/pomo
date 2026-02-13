import { randomUUID } from 'node:crypto';
import { constants as fileSystemConstants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import {
  CONFIG_DIRECTORY_RELATIVE_PATH,
  DEFAULT_CONFIG
} from './types.js';
import type {
  PomoConfig,
  RuntimeStatusRecord,
  SessionRecord,
  StoragePaths
} from './types.js';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseIntegerWithFallback = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const parsedNumber = z.coerce.number().int().min(minimum).max(maximum).safeParse(value);
  return parsedNumber.success ? parsedNumber.data : fallback;
};

const parseBooleanWithFallback = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();

    if (normalizedValue === 'true') {
      return true;
    }

    if (normalizedValue === 'false') {
      return false;
    }
  }

  return fallback;
};

const sanitizeConfig = (rawConfig: unknown): PomoConfig => {
  const rawConfigObject = isPlainObject(rawConfig) ? rawConfig : {};

  return {
    focusMinutes: parseIntegerWithFallback(rawConfigObject.focusMinutes, DEFAULT_CONFIG.focusMinutes, 1, 360),
    shortBreakMinutes: parseIntegerWithFallback(
      rawConfigObject.shortBreakMinutes,
      DEFAULT_CONFIG.shortBreakMinutes,
      1,
      180
    ),
    longBreakMinutes: parseIntegerWithFallback(
      rawConfigObject.longBreakMinutes,
      DEFAULT_CONFIG.longBreakMinutes,
      1,
      240
    ),
    sessionsBeforeLongBreak: parseIntegerWithFallback(
      rawConfigObject.sessionsBeforeLongBreak,
      DEFAULT_CONFIG.sessionsBeforeLongBreak,
      1,
      12
    ),
    notificationsEnabled: parseBooleanWithFallback(
      rawConfigObject.notificationsEnabled,
      DEFAULT_CONFIG.notificationsEnabled
    )
  };
};

const sessionRecordSchema = z.object({
  id: z.string().min(1),
  timestampStart: z.string().datetime(),
  timestampEnd: z.string().datetime(),
  mode: z.enum(['focus', 'shortBreak', 'longBreak']),
  label: z.string(),
  durationMinutes: z.number().int().min(0).max(720),
  completed: z.boolean()
});

const runtimeStatusRecordSchema = z.object({
  pid: z.number().int().positive(),
  source: z.enum(['tui', 'start']),
  runtimeSessionId: z.string().min(1).optional(),
  processStartTicks: z.number().int().nonnegative().nullable().optional(),
  updatedAt: z.string().datetime(),
  state: z.object({
    mode: z.enum(['focus', 'shortBreak', 'longBreak']),
    status: z.enum(['idle', 'running', 'paused']),
    remainingSeconds: z.number().int().min(0),
    targetEndEpochMs: z.number().int().positive().nullable(),
    currentLabel: z.string(),
    completedFocusCountInCycle: z.number().int().min(0),
    startedAt: z.string().datetime().nullable(),
    pausedAt: z.string().datetime().nullable()
  })
});

const ensureParentDirectory = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

const INVALID_JSON_SYMBOL = Symbol('invalid-json');
const HISTORY_LOCK_WAIT_TIMEOUT_MS = 2_000;
const HISTORY_LOCK_RETRY_INTERVAL_MS = 40;
const RUNNING_RUNTIME_STALE_THRESHOLD_MS = 8_000;

const waitFor = async (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

const getHistoryLockPath = (paths: StoragePaths): string => `${paths.historyPath}.lock`;

const withFileLock = async <T>(
  lockPath: string,
  callback: () => Promise<T>,
  timeoutMs: number = HISTORY_LOCK_WAIT_TIMEOUT_MS
): Promise<T> => {
  await ensureParentDirectory(lockPath);

  const deadlineEpochMs = Date.now() + timeoutMs;
  let lockFileHandle: Awaited<ReturnType<typeof open>> | null = null;

  while (lockFileHandle === null) {
    try {
      lockFileHandle = await open(lockPath, 'wx');
    } catch (error) {
      const isLockContention =
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code === 'EEXIST';

      if (!isLockContention) {
        throw error;
      }

      if (Date.now() >= deadlineEpochMs) {
        throw new Error(`Timed out waiting for lock ${lockPath}`);
      }

      await waitFor(HISTORY_LOCK_RETRY_INTERVAL_MS);
    }
  }

  try {
    return await callback();
  } finally {
    await lockFileHandle.close();
    await rm(lockPath, { force: true });
  }
};

const writeJsonAtomic = async <T>(filePath: string, payload: T): Promise<void> => {
  await ensureParentDirectory(filePath);

  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const serializedPayload = JSON.stringify(payload, null, 2);

  await writeFile(temporaryPath, `${serializedPayload}\n`, 'utf8');
  await rename(temporaryPath, filePath);
};

const readJsonFile = async (filePath: string): Promise<unknown> => {
  try {
    const fileContents = await readFile(filePath, 'utf8');
    return JSON.parse(fileContents) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return INVALID_JSON_SYMBOL;
    }

    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code === 'ENOENT'
    ) {
      return null;
    }

    throw error;
  }
};

const backupInvalidFile = async (filePath: string): Promise<void> => {
  try {
    await access(filePath, fileSystemConstants.F_OK);
    const backupPath = `${filePath}.corrupt-${Date.now()}.json`;
    await copyFile(filePath, backupPath);
  } catch {
    // noop: backup is best-effort only.
  }
};

export const getStoragePaths = (homeDirectory: string = homedir()): StoragePaths => {
  const configDirectoryPath = join(homeDirectory, CONFIG_DIRECTORY_RELATIVE_PATH);

  return {
    configDirectoryPath,
    configPath: join(configDirectoryPath, 'config.json'),
    historyPath: join(configDirectoryPath, 'history.json'),
    runtimePath: join(configDirectoryPath, 'runtime.json')
  };
};

export const ensureStorageDirectory = async (paths: StoragePaths): Promise<void> => {
  await mkdir(paths.configDirectoryPath, { recursive: true });
};

export const loadConfig = async (paths: StoragePaths): Promise<PomoConfig> => {
  await ensureStorageDirectory(paths);

  const parsedConfig = await readJsonFile(paths.configPath);

  if (parsedConfig === INVALID_JSON_SYMBOL) {
    await backupInvalidFile(paths.configPath);
  }

  const sanitizedConfig = sanitizeConfig(parsedConfig);

  await writeJsonAtomic(paths.configPath, sanitizedConfig);

  return sanitizedConfig;
};

export const saveConfig = async (paths: StoragePaths, config: PomoConfig): Promise<PomoConfig> => {
  const sanitizedConfig = sanitizeConfig(config);
  await writeJsonAtomic(paths.configPath, sanitizedConfig);
  return sanitizedConfig;
};

export const loadHistory = async (paths: StoragePaths): Promise<SessionRecord[]> => {
  await ensureStorageDirectory(paths);

  const parsedHistory = await readJsonFile(paths.historyPath);

  if (parsedHistory === null) {
    await writeJsonAtomic(paths.historyPath, []);
    return [];
  }

  if (parsedHistory === INVALID_JSON_SYMBOL) {
    await backupInvalidFile(paths.historyPath);
    await writeJsonAtomic(paths.historyPath, []);
    return [];
  }

  const validationResult = z.array(sessionRecordSchema).safeParse(parsedHistory);

  if (validationResult.success) {
    return validationResult.data;
  }

  await backupInvalidFile(paths.historyPath);
  await writeJsonAtomic(paths.historyPath, []);
  return [];
};

export const saveHistory = async (paths: StoragePaths, history: SessionRecord[]): Promise<void> => {
  const validatedHistory = z.array(sessionRecordSchema).safeParse(history);

  if (!validatedHistory.success) {
    throw new Error('Cannot save history because records are invalid.');
  }

  await withFileLock(getHistoryLockPath(paths), async () => {
    await writeJsonAtomic(paths.historyPath, validatedHistory.data);
  });
};

export const appendHistoryRecord = async (
  paths: StoragePaths,
  sessionRecord: SessionRecord
): Promise<void> => {
  const validatedSessionRecord = sessionRecordSchema.safeParse(sessionRecord);

  if (!validatedSessionRecord.success) {
    throw new Error('Cannot append invalid history record.');
  }

  await withFileLock(getHistoryLockPath(paths), async () => {
    const existingHistory = await loadHistory(paths);
    await writeJsonAtomic(paths.historyPath, [...existingHistory, validatedSessionRecord.data]);
  });
};

export const loadRuntimeRecord = async (
  paths: StoragePaths
): Promise<RuntimeStatusRecord | null> => {
  await ensureStorageDirectory(paths);

  const parsedRuntimeRecord = await readJsonFile(paths.runtimePath);

  if (parsedRuntimeRecord === null) {
    return null;
  }

  if (parsedRuntimeRecord === INVALID_JSON_SYMBOL) {
    return null;
  }

  const validationResult = runtimeStatusRecordSchema.safeParse(parsedRuntimeRecord);

  if (!validationResult.success) {
    return null;
  }

  return {
    ...validationResult.data,
    runtimeSessionId:
      validationResult.data.runtimeSessionId ?? 'legacy-runtime-session',
    processStartTicks: validationResult.data.processStartTicks ?? null
  };
};

export const saveRuntimeRecord = async (
  paths: StoragePaths,
  runtimeRecord: RuntimeStatusRecord
): Promise<void> => {
  const validationResult = runtimeStatusRecordSchema.safeParse(runtimeRecord);

  if (!validationResult.success) {
    throw new Error('Cannot persist runtime record because the payload is invalid.');
  }

  await writeJsonAtomic(paths.runtimePath, validationResult.data);
};

export const clearRuntimeRecord = async (paths: StoragePaths): Promise<void> => {
  await rm(paths.runtimePath, { force: true });
};

export const isProcessRunning = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

export const readLinuxProcessStartTicks = async (
  processId: number
): Promise<number | null> => {
  if (process.platform !== 'linux') {
    return null;
  }

  try {
    const processStatPath = `/proc/${processId}/stat`;
    const processStatContent = await readFile(processStatPath, 'utf8');
    const lastClosingParenthesisIndex = processStatContent.lastIndexOf(')');

    if (lastClosingParenthesisIndex === -1) {
      return null;
    }

    const remainingFields = processStatContent
      .slice(lastClosingParenthesisIndex + 2)
      .trim()
      .split(' ');
    const startTicksText = remainingFields[19];

    if (startTicksText === undefined) {
      return null;
    }

    const startTicks = Number.parseInt(startTicksText, 10);
    return Number.isFinite(startTicks) ? startTicks : null;
  } catch {
    return null;
  }
};

export const isRuntimeRecordActive = async (
  runtimeRecord: RuntimeStatusRecord,
  referenceEpochMs: number = Date.now()
): Promise<boolean> => {
  if (!isProcessRunning(runtimeRecord.pid)) {
    return false;
  }

  if (runtimeRecord.state.status === 'running') {
    const updatedAtEpochMs = Date.parse(runtimeRecord.updatedAt);

    if (
      Number.isNaN(updatedAtEpochMs) ||
      referenceEpochMs - updatedAtEpochMs > RUNNING_RUNTIME_STALE_THRESHOLD_MS
    ) {
      return false;
    }
  }

  if (runtimeRecord.processStartTicks !== null) {
    const currentProcessStartTicks = await readLinuxProcessStartTicks(runtimeRecord.pid);

    if (currentProcessStartTicks === null) {
      return false;
    }

    if (currentProcessStartTicks !== runtimeRecord.processStartTicks) {
      return false;
    }
  }

  return true;
};
