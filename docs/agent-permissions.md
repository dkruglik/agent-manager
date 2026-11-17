# Agent permissions

**Status:** implemented, 2026-11-13 (Claude rule syntax not yet verified; see below)

Settings → General → **Agent permissions** sets allow and deny rules that apply
to every agent of one CLI. Rules are saved in `am-config.json` under
`agentPermissions` (`server/src/agent-permissions.js` holds the logic).

| CLI | Where the rules go | When they take effect |
|-----|--------------------|-----------------------|
| Claude Code | `--settings '<json>'` on each launch (`server/src/config.js`, `launchFlags`) | The next launch of any agent, including resumes. Running agents keep the rules they started with. |
| Cursor CLI | Merged into `$HOME/.cursor/cli-config.json` under `permissions` | On save, and again at boot |

## Rules

- Rule syntax belongs to each CLI, not to this app. The app only checks length
  (200 characters), count (100 per list) and control characters.
- Cursor: the app records what it wrote in `STATE_DIR/cursor-permissions-applied.json`.
  A rule you remove in the UI is removed from the file. Rules that cursor-agent
  or you added by hand are never touched.
- If `cli-config.json` cannot be parsed, nothing is written and the Settings page
  shows why. The file is never overwritten.
- The save response and `GET /api/config` both carry `cursorPermissions`
  (`{ok, changed?, error?}`).

## When `am-config.json` cannot be read

A missing file means no rules yet. A file that exists but cannot be read or
parsed never turns rules off: Claude launches keep the rules read last time
(logged as `[permissions]`), and at boot the Cursor file is left as it is and
the page shows why.

## Claude switches

Two on/off settings sit beside Claude's rules: `blockReadsOutsideWorkingDirectories`
and `blockWritesOutsideWorkingDirectories`. When on, they go into the same
`--settings` JSON as `permissions.<key>: true`. Claude Code 2.1.325 contains
both keys and the messages that name them; the page only has them for Claude,
and a save that sets them for Cursor is refused. A running agent keeps the
settings it started with.

## Not covered

- Claude's allow/deny rule syntax is not verified against Claude Code's schema
  yet. The two switches above are present in the installed binary, but their
  effect has not been run here.
- Claude's rules and switches are not checked against the boot default `bypassPermissions`.
- After a restart with an unreadable file and no earlier read, Claude launches have no rules.
