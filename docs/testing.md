# Testing

Every test is a plain `*.test.mjs` file in `server/test/`, `web/test/`, or the
root of `server/`. There is no list to edit: `scripts/run-suites.mjs` finds the
files. Some suites use `node:test`; others are scripts that print their checks
and exit non-zero on a failure. Either kind runs the same way.

One-time setup: `npm ci` in both `server/` and `web/`. The browser suites drive
Playwright's Chromium (`npx playwright install chromium` from `web/`, or a
browser already under `PLAYWRIGHT_BROWSERS_PATH`).

## Run everything

From the repository root:

```bash
npm test
```

This runs every server and web suite plus the web typecheck (`tsc --noEmit`) in
one pool, one job per free core (cores minus the load average, at least 3).
How long it takes depends on how busy the machine is. Measured on the shared
8-core Space:

| Machine | Jobs | Full run |
|---|---:|---:|
| fairly quiet | 8 | 107–140 s |
| load 7–12, some runs with 2 extra CPU burners | 3 | 273–286 s |
| load ~6–7 (a second measurement) | 3 | 360–362 s |

For comparison, running every suite one at a time takes about 13–14 minutes.
Each finished suite prints one line. A failing suite prints its whole output.
The run doesn't stop at a failure: it finishes everything, then lists every
failed suite and exits non-zero.

`cd server && npm test` and `cd web && npm test` run one package the same way.

Options (after `--`, e.g. `npm test -- --jobs 4`):

| Option | Effect |
|---|---|
| `<substring> …` | only suites whose path (`server/test/pin.test.mjs`) contains one of them |
| `--jobs N` / `-j N` | N suites at a time (default: one per free core, at least 3; also `AM_TEST_JOBS`) |
| `--serial` | one at a time, output streamed live (same as `--jobs 1`) |
| `--verbose` | print every suite's output, not only failures |
| `--manual` | with a substring, also run matching suites marked manual |

`AM_SUITE_TIMEOUT` (seconds, default 600) kills a hung suite and its children
and counts it as failed.

Every suite runs with `AM_CLAUDE_MODEL_PROBE=0`, so a test server never opens
the signed-in Claude Code to read its model picker (see
[launch-model-effort.md](launch-model-effort.md)). The probe is off anyway
unless the variable is `1`, which only the Docker entrypoint sets, and only
for the server, not its sessions.

## Run one suite

```bash
cd server && node test/pin.test.mjs          # directly
cd web && node test/lazyPanels.test.mjs
node --test --test-reporter=tap test/pin.test.mjs   # the same, TAP output
npm test -- pin                              # through the runner
```

A suite that serves the production build (`lazyPanels`, `framing.browser`, the
UI suites) builds the web app itself when run directly. Set `AM_TEST_DIST` to
an existing build to skip that step (`npx vite build --outDir /tmp/dist` from
`web/`). The runner builds once per run and passes the folder to every suite
that needs it.

## Writing a suite that runs in parallel

Suites run side by side, so a suite must not take anything another suite could
also take:

- **Ports:** never a fixed number. Use `freePort()` from
  `server/test/free-port.mjs`, or `listen(0)` and read the port back.
  `startFixtureServer()` in `web/test/helpers/` picks a free port when it isn't
  given one.
- **Files:** scratch state goes in `fs.mkdtempSync(path.join(os.tmpdir(), …))`,
  never a fixed path. Under `web/node_modules/.test-build/`, use a file name no
  other suite uses.
- **The web build:** use `buildWeb()` from `web/test/helpers/fixture-server.mjs`,
  which returns `AM_TEST_DIST` when it's set. A suite that writes into the
  build must copy it first.
- **Waiting:** wait for a condition, not a fixed time. A 20 ms wait that always
  passes on an idle machine fails when 8 suites share the CPU.

If a suite really needs the machine to itself, put `am-test: serial` and the
reason in its header. It then runs alone after the parallel ones. Two do today:
`server/test/loop-offload` (it measures event-loop lag in milliseconds) and
`web/test/dispatchPreviewScroll` (real wheel and touch gestures).

The runner records how long each suite took in
`web/node_modules/.cache/am-suite-times.json` and starts the longest ones first.
Deleting that file only changes the order.

## Manual and live suites

A suite with `am-test: manual — <reason>` in its first 4 KB is left out of the
default run. Every run lists what it skipped and why. To run one, name it and
add `--manual`:

```bash
npm test -- codex-creation-live --manual
```

| Suite | Why it's manual | Run with |
|---|---|---|
| `server/terminal-ui`, `screenshot-input`, `reader-info` | Chromium against a full web build; long | `cd server && npm run test:ui` |
| `server/mobile` | the same, at phone sizes | `cd server && npm run test:mobile` |
| `server/visibility-ui` | the same, with a fake Hub | `npm test -- visibility-ui --manual` |
| `web/test/*.render` (5 of them) | Chromium render checks | `cd web && npm run test:render` |
| `web/test/codexShared.render` | Chromium and a local HTTP listener | `npm test -- codexShared --manual` |
| `server/test/codex-*-live`, `codex-shared-pilot` | need an installed Codex CLI and local sockets; isolated homes, no model calls | `npm test -- codex- --manual` |
| `server/test/delegation-live` | **real model calls**: needs the operator's explicit authorization | by hand only |
| `server/test/claude-screens-live` | drives the installed Claude Code CLI with a set-up `HOME`; no model calls | `npm test -- claude-screens-live --manual` (see [Claude screens](#claude-screens)) |

Live suites start real CLIs. Run them under `env -i` with an explicit allowlist
and scratch `HOME`/`TMPDIR`, never with a shell that exports a live
`CODEX_HOME`, `CLAUDE_CONFIG_DIR` or `*_DURABLE`:

```bash
H=$(mktemp -d)
env -i PATH="$PATH" HOME="$H" TMPDIR="$H" LANG=C.UTF-8 \
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" npm test
```

The same applies to the default run on a machine that hosts live agents.

## Claude screens

AM decides from the screen whether a Claude Code pane may take a pasted prompt
(`readiness()` and `paneView()` in `server/src/runner.js`). It recognizes two of
Claude's views by phrases in their footer, listed in `CLAUDE_CONFIRM.views` in
`server/src/config.js`:

| View | How it is opened | Phrase | What it does with a paste |
|---|---|---|---|
| detailed transcript | ctrl+o | `Showing detailed transcript` | drops it |
| agents | left arrow twice | `enter to create` / `enter to return` | its composer's Enter starts a **new session** |

The phrases were captured from Claude Code 2.1.325, and the image installs
`@anthropic-ai/claude-code@latest`. If a newer Claude rewords them, nothing
fails: sends behave as before this check existed, and a message sent while the
operator looks at the agents list becomes a stray session. The default suites
replay recorded screens (`server/test/fixtures/claude-screens.json`), so they
cannot notice. `claude-screens-live` checks the installed Claude instead.

### When to run it

- after Claude Code is updated: a new image, or **Update CLIs** in Settings,
  which installs the latest release in place without a rebuild;
- before a deploy that rebuilds the image.

It cannot run inside `docker build`: there Claude has no set-up home and stops
at its first-run screens (theme, login). Run it on a machine or container where
`claude` is installed and has been started and logged in once.

### How to run it

From the repository root, as the user whose `HOME` has the logged-in Claude:

```bash
claude --version                                  # the version under test
npm test -- claude-screens-live --manual --verbose
```

Inside the Agent Manager container, the same from `/app`, with the container's
persistent `HOME`. It takes about 15 seconds. It starts `claude` in a scratch
folder and walks the screens without submitting anything: the trust dialog, the
empty composer, typed text, a pasted `[Pasted text #N +3 lines]`, the transcript
view and the agents view, with and without a paste in its composer. Nothing goes
to a model. The only side effect is a trust entry for the deleted scratch folder
in `~/.claude.json`.

Unlike the other live suites it does **not** run under a scratch `HOME`: with an
empty home Claude never reaches its composer.

### Reading the result

Passing: the last line is `claude-screens-live: all checks passed`.

Failing: each failed check names the screen, what `readiness()` returned and what
it expected, and prints the screen. The two that matter:

```
FAIL left arrow twice: the agents view is named
     readiness() is ready, expected agents-view
FAIL a paste in the agents composer is still the agents view, never a placeholder of ours
     readiness() is placeholder-shown, expected agents-view
```

This means the agents view is no longer recognized. Do not deploy that Claude
version until the phrases are fixed, or pin the previous version in
`scripts/cli-allowlist.sh`. A pin covers the image only: **Update CLIs** in
Settings still installs the latest release. A failure that says `the screen never showed …`
means a step did not reach its screen at all (a changed key binding, a login
prompt, a first-run notice). Read the printed screen.

### Updating the phrases

1. Save what the installed Claude shows:
   ```bash
   AM_CLAUDE_SCREENS_SAVE=/tmp/claude-screens.json \
     npm test -- claude-screens-live --manual
   ```
   Scratch paths are replaced with `/data/workspaces/claude-fixture`.
2. Read the footer rows of `transcript`, `agents` and `agentsPlaceholder` in that
   file, and update `CLAUDE_CONFIRM.views` in `server/src/config.js`. Match only a
   row below the screen's lowest rule, the way `paneView` reads it.
3. Review the file and replace `server/test/fixtures/claude-screens.json` with it.
   The agents view lists this home's other sessions by title: replace those rows
   with neutral text before committing.
4. Run `npm test -- claude-` (the replayed screens) and the live suite again.

