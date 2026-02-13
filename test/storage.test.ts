import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendHistoryRecord,
  getStoragePaths,
  isRuntimeRecordActive,
  loadConfig,
  loadHistory,
  readLinuxProcessStartTicks,
  saveRuntimeRecord
} from '../src/storage.js';
import { createInitialRuntimeState } from '../src/timer.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { RuntimeStatusRecord } from '../src/types.js';

describe('storage', () => {
  it('loads config with safe fallbacks for invalid values', async () => {
    const tempHomePath = await mkdtemp(join(tmpdir(), 'pomo-config-'));
    const storagePaths = getStoragePaths(tempHomePath);
    await mkdir(storagePaths.configDirectoryPath, { recursive: true });

    await writeFile(
      storagePaths.configPath,
      JSON.stringify({ focusMinutes: '30', shortBreakMinutes: -4, notificationsEnabled: false }),
      'utf8'
    );

    const config = await loadConfig(storagePaths);

    expect(config.focusMinutes).toBe(30);
    expect(config.shortBreakMinutes).toBe(DEFAULT_CONFIG.shortBreakMinutes);
    expect(config.notificationsEnabled).toBe(false);
  });

  it('resets malformed history and creates a backup', async () => {
    const tempHomePath = await mkdtemp(join(tmpdir(), 'pomo-history-'));
    const storagePaths = getStoragePaths(tempHomePath);
    await mkdir(storagePaths.configDirectoryPath, { recursive: true });

    await writeFile(storagePaths.historyPath, '{"not":"an array"}', 'utf8');

    const history = await loadHistory(storagePaths);

    expect(history).toEqual([]);

    const files = await readdir(storagePaths.configDirectoryPath);
    const hasBackup = files.some((fileName) => fileName.startsWith('history.json.corrupt-'));
    expect(hasBackup).toBe(true);
  });

  it('recovers from invalid JSON history content', async () => {
    const tempHomePath = await mkdtemp(join(tmpdir(), 'pomo-history-json-'));
    const storagePaths = getStoragePaths(tempHomePath);
    await mkdir(storagePaths.configDirectoryPath, { recursive: true });

    await writeFile(storagePaths.historyPath, '{\"bad\"', 'utf8');

    const history = await loadHistory(storagePaths);
    expect(history).toEqual([]);
  });

  it('persists runtime payloads with strict validation', async () => {
    const tempHomePath = await mkdtemp(join(tmpdir(), 'pomo-runtime-'));
    const storagePaths = getStoragePaths(tempHomePath);
    const state = createInitialRuntimeState(DEFAULT_CONFIG);

    await expect(
      saveRuntimeRecord(storagePaths, {
        pid: process.pid,
        source: 'start',
        runtimeSessionId: 'runtime-test-session',
        processStartTicks: null,
        updatedAt: new Date().toISOString(),
        state
      })
    ).resolves.toBeUndefined();
  });

  it('serializes concurrent history appends without dropping records', async () => {
    const tempHomePath = await mkdtemp(join(tmpdir(), 'pomo-history-race-'));
    const storagePaths = getStoragePaths(tempHomePath);

    const baseSessionRecord = {
      timestampStart: '2026-02-13T00:00:00.000Z',
      timestampEnd: '2026-02-13T00:25:00.000Z',
      mode: 'focus' as const,
      label: 'race',
      durationMinutes: 25,
      completed: true
    };

    await Promise.all([
      appendHistoryRecord(storagePaths, {
        ...baseSessionRecord,
        id: 'session-a'
      }),
      appendHistoryRecord(storagePaths, {
        ...baseSessionRecord,
        id: 'session-b'
      })
    ]);

    const history = await loadHistory(storagePaths);
    const historyIds = history.map((historyRecord) => historyRecord.id).sort();

    expect(historyIds).toEqual(['session-a', 'session-b']);
  });

  it('treats stale running runtime records as inactive', async () => {
    const processStartTicks = await readLinuxProcessStartTicks(process.pid);
    const runtimeRecord: RuntimeStatusRecord = {
      pid: process.pid,
      source: 'tui',
      runtimeSessionId: 'stale-session',
      processStartTicks,
      updatedAt: '2020-01-01T00:00:00.000Z',
      state: createInitialRuntimeState(DEFAULT_CONFIG, {
        status: 'running'
      })
    };

    const isActive = await isRuntimeRecordActive(runtimeRecord, Date.parse('2026-01-01T00:00:00.000Z'));
    expect(isActive).toBe(false);
  });

  it('rejects runtime records when process identity does not match', async () => {
    const runtimeRecord: RuntimeStatusRecord = {
      pid: process.pid,
      source: 'start',
      runtimeSessionId: 'mismatch-session',
      processStartTicks: 1,
      updatedAt: new Date().toISOString(),
      state: createInitialRuntimeState(DEFAULT_CONFIG, {
        status: 'paused'
      })
    };

    const isActive = await isRuntimeRecordActive(runtimeRecord);
    expect(isActive).toBe(false);
  });
});
