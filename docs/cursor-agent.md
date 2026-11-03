# Cursor CLI as an agent

**Status:** partial, 2026-11-03. Launch, per-pane resume, the model picker and
the Reader/digest are in. The image install, the state checkpoint, the
needs-input badge and revive are not, for the reasons under **Not done yet**.

Cursor's terminal agent (`cursor-agent`, also installed as `agent`) is
registered as the `cursor` CLI in `server/src/config.js`. Everything below was
measured on **cursor-agent 2026.10.22-27dcf5f**, run in a PTY the way
`runner.js` runs it, with a throwaway `CURSOR_CONFIG_DIR` and folder.

## Launch and resume

Every pane launches with the same line, first launch and restart alike:

```
cursor-agent --trust --resume <sessionUuid> [--model '<id>'] ['<queued first prompt>']
```

The positional prompt is appended only on the first launch, and only when a
prompt was queued. The registry entry also has a `withPrompt`, so a quickstart
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
logged once per error code, and a cached path survives a transient `stat` error.

## Reader and digest

Transcript lines are `{"role": "user" | "assistant", "message": {"content":
[text | tool_use]}}` and `{"type": "turn_ended"}`.

- **Turn state:** `turn_ended` is only ever the last line, because the file is
  rewritten each turn. When the last line is anything else, a turn is running.
- **User messages:** each is wrapped in `<timestamp>…</timestamp>` and
  `<user_query>`. The reader strips both and takes the turn time from the
  timestamp. No other line carries a time, so the digest stamps a reply with the
  time of the latest prompt, which keeps Overview from showing "no reply yet".
- **Not shareable:** Cursor transcripts are read for the Reader and the digest
  but are not in `SHAREABLE_CLIS`, so they cannot be shared.
- **Tool results:** the file has no `tool_result`. Tool outputs live only in
  `store.db`, so the Reader shows each call without its output.
- **Waiting for approval:** the tool call is not written to the transcript
  until the turn ends. It is not on disk while the call waits for approval.

## Not done yet

- **Image install and state checkpoint.** The image does not install the
  binary (the registry says so). Today it is the hand install
  in `~/.local/bin`, and Cursor's state is on the durable HOME. What is needed:
  - a pinned, checksum-verified build in the `Dockerfile`, a 558 MB Node tree
    rather than one binary;
  - local live state for `chats/`, the HOME `projects/` tree and the sign-in;
  - a `cursor` adapter in `scripts/agent-state.sh` that copies each
    `store.db` with `sqlite3 .backup` and leaves out `*.sock`, `-wal`/`-shm`,
    `worker.log` and `statsig-cache.json`;
  - `NODE_COMPILE_CACHE`, which the wrapper puts under `$HOME/.cache`, moved off
    the bucket;
  - a one-time migration of the existing state.

  These touch `Dockerfile`, `entrypoint.sh` and user data under `DATA_DIR`, so
  they are left for a reviewed change.
- **Needs-input badge.** Cursor's bundle lists hook events (`sessionStart`,
  `notification`, `stop`, …), but this version fired none of them. That was
  checked with `hooks.json` in `$CURSOR_CONFIG_DIR` and in the workspace's
  `.cursor/`. The approval dialog is plain screen text, `Run this command?`
  with `Waiting for approval...`, which a screen-based detector could match
  later.
- **Revive and confirmed submit.** Both need a captured empty composer in
  `server/test/fixtures/input-lines.json` (see the rule above `CLIS` in
  `config.js`), and none was taken. Cursor draws on the primary screen (no
  `?1049h`). While it works it shows `ctrl+c to stop`.
- **Not checked:** whether the CLI updates itself, and whether
  `login` with `NO_OPEN_BROWSER` completes from a Space.
