# Cursor CLI as an agent

**Status:** in place (image build and first boot not yet run), 2026-11-03.
Launch, per-pane resume, the model picker, the Reader and digest, the image
install, the state checkpoint, the needs-input badge and revive are in. What
is still open is under **Not done yet**.

Cursor's terminal agent (`cursor-agent`, also installed as `agent`) is
registered as the `cursor` CLI in `server/src/config.js`. Everything below was
measured on **cursor-agent 2026.10.22-27dcf5f**, run in a PTY the way
`runner.js` runs it, with a throwaway `CURSOR_CONFIG_DIR` and folder.

## Launch and resume

Every pane launches with the same line, first launch and restart alike:

```
cursor-agent --trust --resume <sessionUuid> [--model '<id>'] [-- '<queued first prompt>']
```

The positional prompt is appended only on the first launch, and only when a
prompt was queued. It follows `--`, so a prompt that reads `--yolo` or
`--version` reaches the model as text and is not parsed as a flag (checked on
2026.10.22). A malformed chat id launches unpinned and still carries the queued
prompt, after `--`. The registry entry also has a `withPrompt`, so a quickstart
prompt is queued as `pendingPrompt` and rides this line instead of being typed
into the booting pane. `withPrompt` itself is only the unpinned fallback:
`runner.commandFor` builds the pinned line above and returns before the generic
`withPrompt` use.

- **The pane's `sessionUuid` is its Cursor chat id.** `--resume` with an id
  that has never been used creates the chat under exactly that id. The same
  line later resumes it with its context, which was checked by asking about the
  previous turn. So no `create-chat` subprocess runs and no existence check is
  needed. `create-chat` is `crypto.randomUUID()` plus an empty `store.db`, and
  it hung for 60 s on exit in the test.
- **Never `--continue`.** It picks the folder's most recent chat, which is
  another pane's when two panes share a folder. The registry entry has no
  `cont`. A malformed id falls back to a plain unpinned `cursor-agent --trust`,
  which carries the queued prompt if there is one.
- **`--trust`** skips the per-folder trust dialog by writing
  `projects/<slug>/.workspace-trusted` (`trustMethod: "cli-flag"`). Workspaces
  are the operator's, as with the Claude and Codex answers in
  [first-run dialogs](first-run-dialogs.md). MCP servers are not auto-approved
  (`--approve-mcps` is not passed), and `--yolo`/`--force` never are, so shell
  commands outside the allowlist still ask in the pane.
- **Sign-in:** `CURSOR_API_KEY` (a Space secret), or a sign-in made in the pane,
  which Cursor keeps in `~/.config/cursor/auth.json`. Either one marks the CLI
  ready. Whether `cursor-agent login` completes from a Space was not checked,
  so the setup text recommends the key and says so.

## Model and effort

The account's list comes from `cursor-agent models` (about 1.4 s), as
`id - Label` lines under an `Available models` header. `auto` is left out,
because an empty choice already means the CLI's default. The effort tier is part
of the id (`grok-4.7-low`, `grok-4.7-high`), so there is no separate effort
control. The bracket form from `--help` (`grok-4.7[effort=low]`) was rejected:
`Cannot use this model`, because only listed ids are accepted.

## Where Cursor keeps things

| what | path | follows `CURSOR_CONFIG_DIR` |
|---|---|---|
| chat database | `chats/<md5(resolved cwd)>/<id>/store.db` (+ `-wal`, `-shm`), `meta.json` | yes |
| transcript | `$HOME/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, subagents in `…/<id>/subagents/` | **no**, always under HOME |
| sign-in | `$XDG_CONFIG_HOME/cursor/auth.json` (default `~/.config/cursor`) | no |
| folder trust, worker socket and log | `$HOME/.cursor/projects/<slug>/` | no |

The slug is the cwd with every non-alphanumeric run replaced by `-`. Long paths
are truncated and suffixed with a hash. The reader therefore never computes it:
it finds `projects/*/agent-transcripts/<id>/<id>.jsonl` by the pane's id. A
missing directory is a normal miss. Any other read error (permissions, I/O) is
logged once per error code and path, with the error message and the chat id. A
cached path survives a transient `stat` error (`EIO`, `EMFILE`, `ENFILE`,
`EAGAIN`, `EBUSY`); a lasting one (`EACCES`, `EPERM`, `ELOOP`, …) drops it and
rescans.

## Reader and digest

Transcript lines are `{"role": "user" | "assistant", "message": {"content":
[text | tool_use]}}` and `{"type": "turn_ended"}`.

- **Turn state:** `turn_ended` is only ever the last line, because the file is
  rewritten each turn. When the last line is anything else, a turn is running.
- **User messages:** each is wrapped in `<timestamp>…</timestamp>` and
  `<user_query>`. The reader strips both and takes the turn time from the
  timestamp. No other line carries a time, so the digest stamps a reply with the
  time of the latest prompt, which keeps Overview from showing "no reply yet".
  Every prompt resets that time, so a reply after a prompt whose stamp is
  missing or does not parse has no time rather than an older prompt's.
- **Not shareable:** Cursor transcripts are read for the Reader and the digest
  but are not in `SHAREABLE_CLIS`, so they cannot be shared.
- **Tool results:** the file has no `tool_result`. Tool outputs live only in
  `store.db`, so the Reader shows each call without its output.
- **Waiting for approval:** the tool call is not written to the transcript
  until the turn ends. It is not on disk while the call waits for approval.

## Image and state

- **Install.** The `Dockerfile` installs cursor-agent 2026.10.22-27dcf5f from
  `downloads.cursor.com` into `/opt/cursor-agent/<version>`. Cursor publishes no
  checksum, so the SHA-256 pins the tarball as downloaded on 2026-11-03. A
  mismatch fails the build, and so does a matching tarball that does not unpack
  or run `--version`. A failed download leaves the image without the agent. `entrypoint.sh` writes `cursor-agent` and `agent`
  wrappers in `$AM_LOCAL/bin`, which comes before `~/.local/bin` on PATH, so
  the pin wins over a hand install in the durable HOME. The hand install is
  left in place. The wrappers also keep Node's compile cache on local disk.
- **State.** `~/.cursor` and `~/.config/cursor` are links into
  `$AM_LOCAL/cursor-home` (`dot-cursor/`, `config/`), checkpointed to
  `$DATA_DIR/state/cursor`. See [state checkpoints](agent-state-checkpoints.md)
  for which files are copied, how chat databases are backed up, and the
  per-database throttle.
- **Migration.** On the first boot with this image, a real `~/.cursor` or
  `~/.config/cursor` is copied into the durable tree, its databases through
  SQLite's backup. The original is then kept as `*.pre-agent-state`. Expect the
  first boot to copy the whole existing tree (about 300 MB here) to the bucket.

## Not done yet

- **Hooks.** Cursor's bundle lists hook events (`sessionStart`,
  `notification`, `stop`, …), but this version fired none of them. That was
  checked with `hooks.json` in `$CURSOR_CONFIG_DIR` and in the workspace's
  `.cursor/`.
- **Confirmed submit.** `confirmSubmit` is not set. Its machinery reads the
  composer through the cursor position, and Cursor hides the terminal cursor
  (`ESC[?25l`) and draws its own, so the typed text cannot be read back that
  way (`sameComposer` calls the empty and the typed capture identical). No
  pasted-text placeholder has been captured either.
- **Logo.** The CLI package ships no icon file, so the UI uses the shell icon.
- **Not checked:** an image build and first boot (Docker was not available),
  whether the CLI updates itself, and whether `login` with `NO_OPEN_BROWSER`
  completes from a Space.

## Screen-based detection

Because hooks do not fire and the cursor is hidden, two things are read from
the visible text (`server/test/fixtures/cursor-screens.json`, captured at
120x40 on 2026.10.22):

- **Approval badge.** The input-required tracker's `native` poll is
  `runner.cursorNativePoll`: it reads the screen, keeps its last answer when a
  read throws, and logs the first failure. `runner.cursorApprovalOnScreen`
  matches the `Run this command?` row together with a `→ Run (once)` option row
  below it or the `Waiting for approval...` status, so the question quoted in a
  reply is not a hit. Its token hashes the `$  <command>` row, so a new command
  shows again after a dismissed one.
- **Empty composer** (`emptyCursorComposer`, so `promptDetector` is on). The
  bottom-most `→` row is the composer: `→ Plan, search, build anything` on a
  fresh chat and `→ Add a follow-up` after a turn mean empty. Typed text, the
  `ctrl+c to stop` marker on the row while it works, and the approval dialog
  all mean not empty. Cursor draws on the primary screen (no `?1049h`).
