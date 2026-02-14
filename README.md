# pomo

<img width="1426" height="1209" alt="pomo" src="https://github.com/user-attachments/assets/5f8a9409-a63a-4931-b54c-add4f6898408" />

`pomo` is a keyboard-first Pomodoro timer for the terminal, built with TypeScript + Node.js and a full-screen `neo-blessed` TUI.

## Requirements

- Linux (primary target)
- Node.js 20+
- npm 10+
- UTF-8 terminal with Unicode support

## Quick Start (Local Clone)

```bash
git clone <YOUR_REPO_URL>
cd pomo
npm ci
npm run build
npm run start -- tui
```

Notes:
- Use `npm ci` for clean installs from `package-lock.json`.
- `npm run start -- ...` runs the compiled CLI (`dist/cli.js`).

## Running Commands

Use one invocation path consistently so command behavior is unambiguous.

### 1) Development path (runs TypeScript directly)

```bash
npm run dev -- tui
npm run dev -- start "Write test plan"
npm run dev -- status
npm run dev -- stats --today
npm run dev -- reset-day
```

### 2) Built path (runs compiled JavaScript)

```bash
npm run build
npm run start -- tui
npm run start -- start "Write test plan"
npm run start -- status
npm run start -- stats --today
npm run start -- reset-day
```

### 3) CLI binary path (after linking this repo)

```bash
npm run build
npm link
pomo tui
pomo start "Write test plan"
pomo status
pomo stats --today
pomo reset-day
```

If `pomo` is not found, either run `npm link` first or use the built path (`npm run start -- ...`).

## Keybindings (TUI)

- `space`: start/pause timer
- `r`: reset current timer
- `n`: next phase (uses long-break cadence)
- `s`: skip break and return to focus
- `h`: toggle detailed recent-history modal (`Esc` also closes it)
- `j` / `k` or `↓` / `↑`: move through settings
- `enter`: edit selected setting
- `q` or `Ctrl+C`: quit

## TUI Layout

- Header with active mode + timer state
- Main panel with timer, progress ring/bar (with right-side percent), and settings
- Compact daily summary (today sessions, focused minutes, last completed session)
- Single-line status/toast feedback bar for actions and errors
- Fixed footer command bar with key hints
- Detailed recent history available in a modal via `h`

## Features

- Focus, short break, and long break modes
- Configurable long-break cadence (`sessionsBeforeLongBreak`, default `4`)
- Daily focus stats summary + modal recent history
- Terminal bell + in-app status line feedback + best-effort desktop notification

## Data + Runtime Files

`pomo` stores local state in:

- `~/.config/pomo/config.json`
- `~/.config/pomo/history.json`
- `~/.config/pomo/runtime.json`

`pomo status` reads `runtime.json` and validates that the recorded process is still active.

## Multi-Instance Behavior

`runtime.json` is a single shared status record. If you run multiple `pomo` processes:

- The most recently writing process is what `pomo status` will usually report.
- Status can briefly flip or show `idle` during process shutdown/startup overlap.

For consistent `status` output, run a single active instance.

## Linux Caveats and Troubleshooting

- Desktop notifications:
  - Notifications are best-effort and do not block timer execution.
  - Ensure a desktop notification service is available in your session.
  - On Debian/Ubuntu, install `libnotify-bin` for `notify-send` support.
- Unicode rendering:
  - If the big clock/progress glyphs look broken, confirm a UTF-8 locale (`locale` should include `UTF-8`).
  - Use a terminal font with solid block glyph coverage.
- Terminal bell:
  - Phase completion triggers a bell (`\a`); if you do not hear/see it, check terminal bell settings.
- Clipboard/system tools:
  - `pomo` does not require clipboard helpers (`xclip`/`xsel`).

## Development Commands

```bash
npm run build
npm run test
npm run lint
```
