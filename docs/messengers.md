# Messengers: Slack (and others) as a two-way channel

**Status:** phase 2 implemented — Slack adapter, typed answers for shared Codex,
Claude Code permission prompts and questions answered from chat (opt-in per
binding), free-text prompts for every agent CLI (2026-10-29). Saved channels
and users (2026-11-03).

Connect a chat channel to one agent or to a whole group. The channel then gets a
card when an agent **needs input** and when it **finishes a turn**, and you can
answer from the chat:

| In the chat | What happens in Agent Manager |
| --- | --- |
| Click an option on a question card | The question is answered through the CLI's typed API |
| Reply in a question card's thread | While the question is open, your text answers the first open question. Once the card is closed, a reply is a normal prompt to that card's agent |
| Click **Approve once / Deny** (only with *allow approvals*) | The permission request is decided |
| Reply in a finished card's thread | Sent to that agent as a normal prompt |
| `agent-name: text`, `@agent-name text` or `@agent-name: text` at the top level of the channel | Sent to that agent as a normal prompt; the name is a whole word, case-insensitive, and a bare first word is not an address |
| A top-level message without a name, in a channel that reaches one agent | Sent to that agent as a normal prompt. A group of one counts, and so do two bindings that reach the same agent |
| A top-level message without a name, in a channel that reaches several agents | Not delivered. An allowed sender gets one ephemeral line, "Not delivered. Address an agent with `name:`.", at most once an hour per user and channel; nobody else sees it. A sender who is on none of the channel's allowed-users lists gets nothing in the channel. The log records `refused` with reason `no-agent-named` (or `user-not-allowed`) |
| Reply in the agent's own thread, or under a message that was delivered | Sent to that agent as a normal prompt. A name prefix inside a thread does not re-address it |
| `/am status` | Lists agents in scope and their state |

## Threads and routing

Each agent gets one **bot-owned thread** per channel. The bot posts the root,
`🧵 name · cli`, plus the **Open in Agent Manager** link when `AM_PUBLIC_URL` is
set; a person's message is never the root. A top-level message that an agent
accepted is quoted under its root (the sender's Slack id in bold, not a
mention, so nobody is pinged; then up to five lines of the text with `>`, after the
2 KB cut; `<`, `>` and `&` in the text are escaped, so mentions and `@channel` in
it stay inert). There is no "Sent to …" notice: the quote
is the confirmation. The `finished` card and question and approval cards stay
**top-level** channel posts, as before (the optional `transcript` event posts into the thread, see below), so their notifications do not change.
An open question is therefore answered at the top level, in the card's thread.

A message is routed in this order:

1. **A card's thread.** An open question card takes the reply as its answer. A
   closed question card or a finished card takes it as a normal prompt to that
   card's agent. A card record is pruned after 7 days; until then its thread
   routes, and afterwards a reply there goes nowhere.
2. **A bot thread.** A reply under a root still among the agent's last 20 roots,
   or under a top-level message the bridge delivered (the newest 50 per channel
   are kept), goes to that agent. A name prefix in such a reply is part of the
   text. A root that fell out of the list no longer routes.
3. **A name** at the top level: `name: text`, `@name text` or `@name: text`.
4. **The channel's only agent.** "One agent" means one distinct session that the
   channel's bindings reach now.
5. Otherwise the message is not delivered, with the ephemeral notice above.

The binding that applies is the first binding in the channel that reaches the
agent and lists the sender in its allowed users; approvals and events come from
that binding. A card is the exception: a reply or button press that answers an
open question or approval is judged by the binding that posted the card, as
long as that binding still exists and reaches the agent. A user who is allowed
only by another binding on the same agent cannot answer it; if the card's
binding is gone, the first-binding rule applies. If no binding in the channel reaches the agent any more (it was
removed from the group, or its binding was deleted), the message is refused
with `not-in-channel`, whatever thread it was in. Then the usual refusals run
(allowed users, a missing agent, the privacy lock).

A root takes at most **200** bridge messages (the quote, plus each delivered
reply in the thread). Once it is full, or when a top-level message arrives
after the root was idle for **12 hours**, the next message opens a new root. The
agent keeps its **20** newest roots; older ones drop out and stop routing.

When a channel that reached one agent starts to reach two or more, the bridge
posts one top-level notice that plain messages now need a name. The last count
is stored, so a restart does not repeat it.

A prompt from chat carries a request id: a version 8 UUID derived from the
adapter, the channel, and the message `ts`. The same message keeps the same id
even after a restart or once the in-memory list of handled event ids has
dropped it, so shared Codex, which takes only a UUID and records one receipt
per id, treats it as the same request. Codex's app-server takes
`clientUserMessageId` as a plain string (checked against codex-cli 0.166.0's
generated schema). A message with text but without a `ts` is not sent; the log
records `refused` with reason `no-ts`. A blank message is ignored without a
log.

A card closes itself when its dialog is answered anywhere else (terminal,
reader, another chat). A closed card loses its buttons; a late click gets
"This request is already closed."

### Delivery per runtime

The host's `deliver(session, { text, requestId })` ends in one of three
states and never throws for a classified case. The reason is an error code,
never message text. The rules are in `server/src/delivery-outcome.js`.

- **delivered**: shared Codex accepted the turn (`sessionRuntime.send`
  resolved); `sendInput` or `deliver` resolved for a local pane (Claude Code
  and Codex also need `confirmSubmit` to see the prompt submitted); the
  remote's `append` returned; for a session that never started, the
  `store.update` that writes `pendingPrompt` committed.
- **pending** (try again later): Codex answered `codex-task-busy` or
  `codex-send-busy`; a pane threw an error that carries no `typed` flag
  (`input-line-busy`, or `input-not-ready` before the first byte); the privacy
  lock aborted the send; the session has a `pendingPrompt` the web composer
  stored and has not started (it is never overwritten or extended, and the
  prompt waits until the session has started); a remote has no name.
- **submitted** (never replayed): Codex answered `codex-send-uncertain` (which
  an existing `sending` receipt also produces) or `codex-request-conflict`;
  `typeAndSubmit` marked the error `typed` because the first byte already went
  to the terminal, including `input-not-ready` after that byte,
  `input-not-confirmed` and `input-not-submitted`; the remote's `append`
  threw.

A Slack prompt to a remote agent longer than the remote message limit
(32 KB) is cut and ends with a line `[truncated: the Slack message was longer
than 32 KB]`; the remote's other callers still cut silently.

An unexpected error with no code resolves `pending` with reason `error` and is
logged once, without the text.

Known limits: Gemini, OpenClaw and fx have no `promptDetector`, so their
prompts are typed into whatever is on screen, including an open dialog.
A first launch that fails after `pendingPrompt` was written leaves the Slack
text in the web composer; it counts as delivered and is not sent again from
Slack.

### Outbox: persist, then ack, then deliver

A chat message that is a prompt becomes a row file before Slack is told it
arrived. `onReply` resolves once that file is durable (written, fsynced, and
the directory fsynced). The Slack adapter acks a message event only then: if
the write fails, the envelope stays unacked and Slack redelivers it. A button
press is still acked first, and a slash command is answered in its ack.
Answers to an open question card keep their direct path and have no row.

Rows live in `DATA_DIR/messenger-outbox/<requestId>.json` (directory `0700`,
files `0600`, opened with `O_NOFOLLOW`, written like Codex receipts). The
directory is read at startup into memory; a tick does not list it again. If that read
fails, nothing is accepted (the Slack event stays unacked) and each drain tries
the read again until it succeeds (`outbox-unreadable`). A file
that is malformed, a symlink or unreadable is skipped with one `row-malformed`
log line and left in place. A row is `pending` or `submitted`:

- `pending`: not yet delivered. The drain tries it on every tick, one send at
  a time per agent and in `ts` order; a held row holds the later rows of its
  agent only. While a **real** privacy lock is active nothing is sent (see
  [The privacy lock](#the-privacy-lock) below).
- `submitted`: the host reported text may already have reached the agent. It is
  never sent again.

Immediately before the host send, the request id is added to the channel's
delivered-id set (500 at most, oldest dropped). A crash during the send leaves
the id there, so a restart deletes the row instead of sending the same bytes
again (`already-delivered`). A send that stays `pending` removes the id, so the
next drain tries again. A `delivered` outcome then deletes the row file, quotes
a top-level message into the agent's root and advances the watermarks, the
delivered top-level `ts` set and the agent's last 3 texts. The id is recorded
before the delete so a crash or a failed delete cannot send the text again.
A row that becomes `submitted` is likewise recorded
first in a `submittedIds` set (never evicted; losing an id could replay a prompt),
so it stays `submitted` after a
restart even if rewriting its file failed; the rewrite is retried on later
ticks. A session already sending is skipped on a tick while others proceed,
and the 24-hour expiry runs even while a send is stuck. A temp file left in
the directory by a crash is deleted at startup; a symlinked directory is
refused (`outbox-unsafe`, messages stay unacked) and a looser than `0700` one
is tightened. If a row write fails after the file was created, the file is
removed so the redelivery can write it. Only the first of several waiting rows
of an agent carries the preamble. The set is checked before a
row is written, so a Slack retry of a delivered or still-waiting message
writes nothing (log `duplicate`, nothing is sent twice).

Before each send the sender and scope are checked again. If the sender is no
longer allowed, or no binding in the channel reaches the agent any more, the
row is deleted, the message's thread gets "Not delivered — <reason>." and the
log records `refused`. A `pending` row older than 24 hours is deleted and its
thread gets "Not delivered — still waiting after 24h."; a `submitted` row older
than 24 hours is deleted with one `expired` log line and nothing is posted. A
reply under a top-level message that is still waiting routes to its agent.
Removing a binding deletes an agent's rows only when no other binding in the
channel still reaches it.

#### After a restart

Rows survive a restart (`messengers.json` and the outbox index are loaded when
the bridge is built, before any socket connects). Before the first send of a
session after the process started, the drain waits for the host's `ready(session)`:
it resolves once that boot's revive result for the session
(`sent`, `skipped` or `gave-up`, see [session-revive.md](session-revive.md))
has settled. For a CLI with a prompt detector whose pane is running, and
unless revive gave up, it then waits (30 s at most, and not past a lock) for an
empty prompt. Gemini, OpenClaw and fx never wait on the prompt. Antigravity
waits, like the other CLIs that have a prompt detector. If the prompt is still
not empty when the 30 s ends, the row stays `pending` and a later drain waits
again (`ready-timeout`). The drain never
sends the continue text and never races it; a session revive did not include
resolves `skipped` (including sessions over the 32-session cap, which resolve
`gave-up` instead), so a pending row starts it through `deliver` as usual. The wait is
once per pane launch (`runId`), not once per process: stopping the pane and
starting it again waits again. It does not hold other sessions or the 24-hour
expiry. If the
Space is locked at boot, revive is skipped and every session resolves
`skipped`. A `submitted` row is never sent again after a restart.

#### The privacy lock

The bridge reaches the lock only through the host: `lockState()` gives
`{ locked, reason }`, `onLock(fn)` calls `fn` with the new state, and
`lockScope()` opens a scope whose signal aborts when a lock lands. A **real
lock** is any lock whose reason is not `checking`.

- **Real lock.** A new prompt writes no row: the sender gets "Agent Manager is
  locked; nothing was sent." and the event is acked. When a real lock lands
  (from unlocked, from `checking`, or already in place when the bridge starts)
  every `pending` row is deleted, and nothing is sent after the unlock. Once
  the manager unlocks, each affected thread gets one line, "Not delivered
  (locked)." The thread list is kept in memory only: a restart during a real
  lock loses the line, because the rows are already gone. `submitted` rows are
  kept.
- **`checking`** (the first privacy verdict is still in flight). A prompt from
  an allowed sender is saved like any other and waits; the drain sends nothing
  and nothing is deleted, so a restart keeps the rows. Answers to question and
  approval cards are refused during either lock, as before. Outbound **input-required**
  and **finished** cards are not posted during `checking` either (only `transcript`
  mirroring runs until unlock).
- **Every send** holds a `lockScope()` and passes its signal to `host.deliver`.
  A lock landing aborts a send still inside the host; an abort without the
  typed flag is `pending`, and the landing then deletes the row.

A full wipe is: stop the server, then delete `messengers.json` and
`messenger-outbox/`.

#### Frozen text

The row's `text` is fixed when the row is written, and a retry sends exactly
those bytes (shared Codex hashes the text into its receipt, and a different
text under the same id is `codex-request-conflict`). It has up to two parts
before the message:

- A preamble, when the agent's source changed. If the host's `sourceKey` for
  the agent differs from the stored `lastSrc`, the stored last 3 delivered
  texts are put first, as
  `Earlier messages from Slack (the conversation restarted since):`, each
  line quoted with `> `, then a blank line. It is added only when the row is
  first written. The transcript is never searched. `sourceKey` changes when
  a pinned id changes (Codex rollout, OpenCode session, Antigravity
  conversation). Claude compaction in the same JSONL, and following a
  `continued-in` file, keep the same `sourceKey`, so no preamble is attached
  for them. That is a known limit.
- A sender prefix, `Slack user U123: `, when more than one user is allowed
  across the bindings in the channel that reach the agent. Agent Manager does
  not call `users.info` (the manifest has no `users:read`). The form cannot be
  mistaken for the `[Agent Manager:]` restart notice.

## Agent output to Slack: `finished` and `transcript`

A binding has up to three events. `input-required` and `finished` are on by
default; `transcript` is **off by default** and a binding opts in (Settings:
"full transcript"; or `events` on the API).

- **`finished`** is the clipped card described above: the latest assistant text,
  posted as a **top-level** channel post once the session has settled, skipped
  when the web read mark covers it.
- **`transcript`** mirrors every assistant message into the agent's own thread
  (the bot-owned root). **It suppresses `finished` for that binding**: a binding
  with both events posts the transcript only. Question and approval cards stay
  top-level and are not touched by it, so an open question is answered at the top
  level, in the card's thread, while the agent's replies go to the session thread.

**Warning: `transcript` sends agent output to Slack.** That includes file
contents and command output that the finished card used to clip away. Anyone in
the channel can read it. Turn it on only for channels that may see what the agent
sees.

### What the mirror posts

- Only assistant messages. User messages, including the `CONTINUE_TEXT` that
  revive sends, are never echoed.
- A first look at a session is a baseline: the current end is stored and nothing
  is posted. A session that already has a stored cursor is not baselined again
  after a restart; the messages strictly after the cursor are posted.
- It waits for the same settle delay as `finished`
  (`MESSENGER_FINISHED_DELAY_MS`), so a streaming answer is posted once.
- At most **5 messages per tick and session**. Older ones collapse into one line,
  "N earlier messages — open in Agent Manager." (with the link when
  `AM_PUBLIC_URL` is set). The collapsed messages are not posted later.
- At most 12 Slack calls per session and tick, so one backlog cannot stall other
  channels. A message that does not fit the rest of the budget waits for the next
  tick.
- Text past Slack's block limit is **split** into successive thread messages
  (the limit is counted after Slack's escaping, and a split prefers a newline).
  A message of more than 8 parts is cut with a final "… N more characters" line.
- If the last posted message grows (same position, new text), its **last part is
  edited in place** with `chat.update`. Earlier parts and older messages are never
  rewritten. A restart or collapse line is not edited.
- A turn that only called tools posts one line, "Used tools: Bash, Edit".
- When the conversation changes (a different transcript, or the transcript is
  shorter than the cursor) it posts one line, "Conversation restarted.", stores the
  new end, and continues from there. A compaction inside the same Claude file is
  not detected as a restart unless the message count drops.
- **Nothing is posted under a real privacy lock, and the cursor does not move.**
  The messages are posted after unlock (under the 5-message cap). The startup
  `checking` state is not a lock for this purpose.
- Slack's HTTP 429 is honoured: the call waits `Retry-After` seconds (at most 60)
  and retries, twice at most, then fails like any Slack error and the binding backs
  off.

### Credential filter

Every text posted by `transcript`, the body of every `finished` card, and the
`details` field of every input/approval card, goes
through `createCredentialFilter` (`audit-credentials.js`) with the values this
process holds, read in `config.js` (`knownSecretValues`): `SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN`, `HF_TOKEN` (also `HUGGING_FACE_HUB_TOKEN`, `HF_API_TOKEN`),
`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY`, `GOOGLE_API_KEY`, and every provider
key the CLI catalog lists (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `NOUS_API_KEY`, `AI_GATEWAY_API_KEY`).
They are read once when the bridge starts; values shorter than 8 characters are
ignored. The filter replaces a value with `[redacted]`, and the text is filtered
before it is split, so a secret cannot straddle two parts.

**This is not a general secret scanner.** Without a known value it catches only
documented token shapes, complete private key blocks and labeled assignments
(`password=…`). A secret printed by a command, or a key this process does not
hold, passes through.

### The transcript reader and the cursor

The mirror reads the whole transcript with the trace reader (every harness,
including OpenCode's SQLite) and **only when the trace revision changed**: an idle
session costs a stat. A message is identified by its place among the assistant
messages (`seq`) and a hash of its text and tool names, both checked against the
current transcript (`src`).

The cursor is one record per adapter, channel and session in `messengers.json`
(`outbound`): `{ src, seq, hash, refs }`, for the last posted message only, where
`refs` are the Slack `ts` values of its parts. It is written once per tick, after
the posts returned. A crash between a post and that write **can repost the last
message once**; that is accepted. The same record holds the id of the last
`finished` card announced (`finished`), which replaced the old `seen` map.

### The `seen` migration

Older versions kept the last announced reply per binding and session in `seen`.
On start, a session with a `seen` entry and no `outbound` record gets one that
carries the old id as its `finished` mark and no cursor. The next `finished`
check therefore announces nothing old, and the first `transcript` look is a
baseline that posts nothing. `seen` is no longer written. Two bindings in one
channel that reach the same session share one mark.

## What can be answered from chat

The bridge never types keystrokes into a TUI dialog, for the reasons in
[tui-input-required.md](tui-input-required.md). A dialog is answerable only
where the CLI offers a typed answer path:

| CLI | Needs-input card | Answer from chat |
| --- | --- | --- |
| Codex (shared) | Yes, with the questions and options | Questions; approvals when opted in. Secret questions are never sent to chat. |
| Claude Code | Yes, with the tool call or the questions, for bindings with *allow approvals* | Permission prompts (approve once / deny) and single-select `AskUserQuestion`, when opted in — see [Claude Code approvals](#claude-code-approvals). Otherwise the kind only, with a terminal link. |
| Gemini, OpenCode | Yes (kind only) | Not yet — the card links to the terminal. |
| Hermes, OpenClaw | No signal exists | — |
| Every agent CLI | Finished cards | Free-text follow-ups |

## Set up Slack

The adapter uses **Socket Mode**: the server dials out to Slack. No public URL,
reverse proxy or inbound port is needed, so the same setup works on a VPS, on a
laptop and in a private Space.

1. Create an app at <https://api.slack.com/apps> → **From a manifest**, and paste:

   ```yaml
   display_information:
     name: Agent Manager
   features:
     bot_user:
       display_name: Agent Manager
       always_online: true
     slash_commands:
       - command: /am
         description: Agent Manager status
         usage_hint: status
         should_escape: false
   oauth_config:
     scopes:
       bot: [chat:write, channels:history, groups:history, commands]
   settings:
     event_subscriptions:
       bot_events: [message.channels, message.groups]
     interactivity:
       is_enabled: true
     socket_mode_enabled: true
   ```

2. **Basic Information → App-Level Tokens**: create one with the
   `connections:write` scope. This is `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** to the workspace. The bot token is `SLACK_BOT_TOKEN` (`xoxb-…`).
4. Give both tokens to the server as `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
   ([configuration table](development.md#configuration)) and restart it:
   - **VPS / local**: export them in the service environment, e.g. in a systemd
     unit `Environment=SLACK_BOT_TOKEN=xoxb-…` and `Environment=SLACK_APP_TOKEN=xapp-…`.
   - **Space**: add them as Space secrets.
5. Optional: set `AM_PUBLIC_URL` (e.g. `https://am.example.com`) so cards carry
   an **Open in Agent Manager** link to the agent (`/#session=<id>`).
6. In Slack, `/invite @Agent Manager` to the channel. Copy the channel ID
   (channel details → bottom of the About tab) and your member ID
   (profile → ⋮ → Copy member ID).
7. For [Claude Code approvals](#claude-code-approvals), make sure
   `CLAUDE_CONFIG_DIR` is set and `jq` and `curl` are on `PATH`.
8. In **Settings → General → Messengers**, connect the channel to an agent or a
   group, list the allowed user IDs, and press **Send test**.

To connect more agents without pasting the same IDs again, save them once:
**Save channel** stores the typed channel ID (with an optional name), and **Save
users** stores the typed user IDs. Saved entries then appear in the *Saved
channel* and *Add saved user* pickers of the connect form. Typing IDs by hand
still works. A saved entry is only a shortcut: it is not a binding, connects
nothing by itself, and removing a binding leaves it in place.

## Claude Code approvals

Claude Code exposes no typed answer path into a running TUI, but it does run
*blocking* hooks before it shows a dialog. Agent Manager installs
`scripts/am-claude-approval-hook.sh` as a `PermissionRequest` hook and as a
`PreToolUse` hook for `AskUserQuestion`, next to its existing lifecycle hooks.

The server writes these hooks into `$CLAUDE_CONFIG_DIR/settings.json` when it
starts, and only when `CLAUDE_CONFIG_DIR` is set (the container image sets it).
On a VPS or a local install, set it yourself, for example to `~/.claude`, before
starting the server ([configuration table](development.md#configuration)).
Without `CLAUDE_CONFIG_DIR` no hook is installed. The installed hook script
needs `jq` and `curl` on `PATH`; without either it exits at once and prints
nothing. Either way prompts stay in the terminal. When the request to Agent Manager fails (unreachable, or refused with
an HTTP error), the hook prints nothing on stdout, so the terminal dialog stays,
and writes one line on stderr, which Claude shows only in verbose mode; the
server logs every refusal as `hook-rejected` with its status and reason.

1. Claude runs the hook with the pending tool call (or the questions).
2. The hook — only in the pane's own `claude` process (the same entrypoint and
   `CLAUDE_PID`/`AM_PANE_PID` guard as the input-required hook, and only with
   `AM_PORT` set and `AM_CLI=claude`) — calls
   `POST /api/messengers/claude-hook?from=$AM_ID` with the payload and the
   pane's `AM_RUN_ID`. Only that pane's live launch is answered.
3. If no connected binding with *allow approvals* and the *input-required*
   event covers the session, the
   server answers `{output:null}` at once and the hook prints nothing, so
   Claude shows its normal dialog. Sessions without such a binding see no
   change apart from that one local request.
4. Otherwise a card goes to every such binding (one that only sends
   *finished* cards gets none). The first allowed answer
   becomes Claude's decision: approve once / deny with a message for a
   permission, or `updatedInput.answers` for a question. The other channels'
   cards close.
5. With no answer within **120 s**, the cards say *No answer in time — answer
   in the terminal*; if the hook is stopped (Claude moved on, or the terminal
   answered), they say *Stopped waiting — answer in the terminal*; if Agent
   Manager stops (SIGTERM or SIGINT; it waits up to 2 s for this), they say
   *Agent Manager is stopping — answer in the terminal*; if a card cannot be
   posted, the cards already posted say *Could not be posted*. In each case the
   hook prints nothing and Claude falls back to its dialog. A card whose post
   finishes after the decision was settled is closed with the same text (*No
   longer waiting — answer in the terminal* if there is none), and a press on a
   card whose hook is gone gets *This request is no longer waiting — answer in
   the terminal*. The hook's own timeout is 150 s.

Limits:

- Multi-select questions stay in the terminal: Claude does not document the
  answer format for them.
- While the hook waits, the terminal shows no dialog. That is why it is opt-in
  per binding and bounded.
- Background subagents of the same `claude` process share its `CLAUDE_PID`, so
  their permission requests reach chat too. Claude denies those when no hook
  decides, so a chat answer can only add an approval that would otherwise not
  happen.
- "Approve once" never adds a permission rule; the next call asks again.

## Security model

- **Allowed users only.** A click or reply from anyone not on the binding's
  list is refused and logged. Being in the channel is not enough.
- **Approvals are opt-in per binding.** Without it, permission cards show no
  buttons and a forged button value is refused, and Claude's blocking hook
  returns at once without a decision.
- **An approval shows the whole request.** Invisible and reordering
  characters in a tool call (Unicode format characters such as U+202E or
  U+200B, and U+2028/U+2029) are shown as `\uXXXX`, so the card cannot read
  differently from the call. Details longer than 1800 characters as shown, or
  containing a code fence, get no buttons and a pressed one is refused.
- **The privacy lock stops cards and deliveries.** No card is posted and no
  reply, answer or approval is delivered to an agent while the instance is
  locked; refusal notices and `/am status` still reply in the channel, and
  `/am status` lists no agents. Transcript mirroring still runs during the
  startup `checking` state.
- **Tokens live in the environment**, never in `messengers.json`.
- **Audit.** Binding changes go through the API and appear in the API log.
  Posted cards, answers, prompts and refusals are written to
  `DATA_DIR/messengers.log.jsonl` (message text is never logged): `posted`,
  `skipped-read`, `answered`, `prompted`, `refused` (every refusal, with a `reason` such as
  `user-not-allowed`, `no-agent-named`, `no-session`, `not-in-channel`, `locked`, `closed`, `untyped`,
  `approvals-off`, `too-long`, `unknown-option`, `nothing-open`),
  `hook-rejected`, `hook-response-lost`, `stopping` (on shutdown), and the failures `tick-failed`,
  `reply-failed`, `outbox-unsafe`, `outbox-dir-stat-failed`, `already-delivered`, `persist-failed` (a prompt row could not be written; the message stays unacked), `deliver-failed`, `duplicate`, `expired`, `held`, `row-malformed`, `thread-failed` (a root or quote that could not be posted; the prompt was still delivered), `thread-queue-failed`, `forget-failed`, `notice-failed`, `update-failed`, `close-failed`,
  `hook-post-failed`, `digest-failed`, `requests-failed`, `submitted`, `edited`, `edit-ignored`,
  `deleted-dropped`, `lock-landed`, `row-delete-failed`, `row-rewrite-failed`,
  `drain-failed`, `backfill`, `backfill-failed`, `backfill-accept-failed`,
  `outbox-unreadable`, `connect-hook-failed`, `ready-timeout`, `transcript-unread`,
  `delivery-error`, plus the Slack
  socket's `bad-frame`, `frame-failed`, `ping-failed`, `socket-error`,
  `socket-silent` and `command-failed` (a `/am` command that failed is still
  answered, with a generic line).
- Agent Manager still has no login of its own: anything that can reach the API
  can change bindings. The messenger does not widen that boundary — the bridge
  only answers dialogs and sends prompts for sessions a binding covers.

## Data

`DATA_DIR/messengers.json` holds the bindings plus delivery state: which cards
are in which channel (so a restart neither re-posts nor loses the ability to
answer) and, per channel and agent, the outbound record: the last finished card announced and the transcript cursor (so connecting a
channel does not replay old answers). Card records expire after 7 days. It also
holds the thread state: each agent's roots (`{ts, at, count}`, 20 at most), a
watermark per agent and thread (the last delivered reply `ts`), a watermark per
channel (the last delivered top-level `ts`); a watermark never moves backwards, the delivered top-level `ts` set
per channel (50 at most, oldest dropped, each pointing at its agent), the
channel's last agent count, the delivered request ids per channel (500 at most,
oldest dropped), and per agent the last 3 delivered texts with the
`lastSrc` they were delivered under. **These texts are Slack user content kept
in `messengers.json`**, each cut at 2 KB (2048 characters). A file from an
older version, without these keys, loads as empty state; malformed entries are
dropped without a warning. Removing a binding deletes an agent's thread state
only when no other binding in the channel still reaches that agent. It also
holds the saved channels and users per messenger,
`saved: {slack: {channels: [{id, name}], users: [{id, name}]}}`; malformed saved
entries are dropped on load without setting the file aside.

A `messengers.json` that cannot be read or parsed is moved (or, failing that,
copied) to `messengers.json.corrupt-<ms>` and the bridge starts empty. If it
can be neither moved nor copied, nothing is saved until it is moved by hand,
so the file is never overwritten. Malformed bindings in a readable file are
ignored, and the original is first copied to `messengers.json.dropped-<ms>`,
under the same rule.

## API

| Route | |
| --- | --- |
| `GET /api/messengers` | Adapters (configured / connected / error) and bindings; each binding carries `lastError`, `null` unless its posts or dialog lookups keep failing, then the adapter's public error, such as `slack chat.postMessage: channel_not_found`, or a generic "see the server log" line — never a path or network detail; such a binding is retried after 5 s, doubling to 5 min |
| `POST /api/messengers/bindings` | `{adapter, target:{channel}, scope:{type:"session"\|"group", id}, events?, allowedUsers, approvals?}` |
| `PUT /api/messengers/saved` | `{adapter, channels:[{id, name?}], users:[{id, name?}]}` replaces **both** of that messenger's saved lists; it is not a partial update, so an omitted list is stored empty. Ids match `^[A-Za-z0-9_.:-]{1,128}$`, at most 100 entries per list (`400 invalid-input` otherwise), names are cut to 64 characters, and a repeated id keeps its first entry. Returns every messenger's `saved`; `GET /api/messengers` returns the same map as `saved` |
| `PUT /api/messengers/bindings/:id` | Partial update; `adapter` cannot change |
| `DELETE /api/messengers/bindings/:id` | |
| `POST /api/messengers/bindings/:id/test` | Posts a test card; `409 messenger-offline` when the messenger is not connected |
| `POST /api/messengers/claude-hook?from=<session>` | Used by the Claude hook: `{runId, payload}` → `{output}` after at most 120 s; `{output:null}` for a session that is not Claude; `409 conflict` unless `runId` is the pane's live launch; `400 invalid-input` for a bad body; `404 not-found` for an unknown session; `400 unknown-origin` when the request carries no known origin ([error contract](api-errors.md)) |

Invalid input is `400 invalid-input` with `details[].field`; an unknown binding
is `404 not-found` ([error contract](api-errors.md)).

#### Edits, deletes and files

The same persist-then-ack applies to these message subtypes. Bot messages and
the bot's own user are filtered for every one, other subtypes are dropped, and
message text is never logged.

- An edit (`message_changed`) replaces the text of a row still `pending`:
  the frozen text, preamble and sender prefix are rewritten in the same file,
  under the same request id. Once the row is `submitted`, or delivered, an
  edit is a new row under its own request id (adapter, channel, `ts` and the
  edit's time), so the delivered-id set does not refuse it and a submitted row
  file is never rewritten. Its text begins "Edited in Slack (replaces the
  earlier message):" and quotes the replacement. A Codex receipt is never
  touched. An edit of a message that was never accepted is ignored with an
  `edit-ignored` log line, as is a change that alters no text (a link unfurl).
- A delete (`message_deleted`) drops a `pending` row, which is then never
  sent. If the message was already `submitted` or delivered the row stays and
  its thread gets one line: "The Slack message was deleted after it was sent
  to the agent."
- A file share, or a message with files, delivers its text plus "A file was
  attached in Slack and was not delivered." A message of only files delivers
  just that sentence. Files are never downloaded.

#### Backfill

On each socket connect, the bridge reads what Slack held while the socket was
down. The first connect and a reconnect after a dropped socket count; Slack's
hourly `disconnect` refresh does not. It reads from the watermarks, with the
adapter's `history`: the channel from its watermark for top-level messages,
and, from the agent's thread watermark, each root still in the roots list and
each delivered top-level `ts`. `oldest` is exclusive, so the watermark message
is not fetched again; a read is at most 5 pages of 200. A channel or thread
without a watermark is not read.

A human message older than 1 hour is not delivered. Each user it affects gets
one ephemeral notice per channel ("N messages you sent while Agent Manager was
offline were not delivered."), not one per message, and only for messages
that were not already delivered. A newer message goes through the same path as
a live event: routing, `refusal()`, the delivered-id check and the row write.
A second pass over the same history therefore sends nothing twice, and raw
history is never copied into an agent any other way. A failed history read is
logged (`backfill-failed`) and is not treated as an empty history. Other
channels and threads are still read; then backfill throws so the next connect
retries from the same watermarks. A backfill still running
when Agent Manager stops writes no rows.

## Adding a messenger

An adapter is any object implementing the interface below (Slack's is a class), kept in `server/src/messengers/adapters/` and registered in
`ADAPTERS` (`server/src/messengers/index.js`) with a factory that receives its
section of `MESSENGERS` from `config.js`. Its tokens are read there, like every
operator-facing setting. It knows nothing about agents:

```js
export class XAdapter {
  constructor({ token = '' } = {}) { this.token = token; }
  configured() { return !!this.token; }
  start({ onReply, onCommand, onStatus, onConnect, log }) {}   // connect; call onStatus({connected, error})
  async stop() {}
  async post({ channel, thread }, card) { return { channel, ts }; } // ts: the message id
  async update(ref, card) {}                         // re-render a posted card
  async postEphemeral({ channel, user, text }) {}    // a line only `user` sees (Slack: chat.postEphemeral, covered by chat:write)
  async history({ channel, thread, oldest }) {}      // messages after `oldest`, oldest first, shaped like onReply events
}
```

The bridge itself is split by direction: `bridge.js` (`MessengerBridge`) watches
sessions and posts cards, `replies.js` (`ReplyRouter`) turns chat events into
answers and prompts, and `cards.js` builds the neutral cards both use.

A **card** is `{kind, title, agent:{id,name,cli,group}, body, details, options:[{id,label,style}], hint, link, resolved}`.
Render `options` as buttons whose callback carries `option.id`; when `resolved`
is set, drop the buttons and show `resolved.text`. A card with `mrkdwn` (the
quote under a root) carries text the bridge has already escaped for Slack;
render it as it is.

Inbound events go to `onReply({channel, ts, thread, user:{id,name}, messageId, optionId?, text?})`:
`ts` is the message a button lives on, `thread` the card a threaded reply belongs
to, and `messageId` a stable id the bridge uses to drop redeliveries. `onReply`
resolves once the event is durable; a rejection leaves it unacked so the
service redelivers it. An adapter acks a message only after `onReply`
resolves, and logs `persist-failed` (never the text) when it rejects. Commands go
to `onCommand({channel, user, text})`, which resolves to reply text.

`history({channel, thread, oldest})` returns the messages after `oldest`
(exclusive) in the channel, or in `thread` when it is set, oldest first, each
shaped like an `onReply` event and filtered like a live one (no bot messages,
not the bot's own). Slack reads `conversations.history` or
`conversations.replies`, at most 5 pages of 200; the `channels:history` and
`groups:history` scopes already cover it. An adapter calls `onConnect()` once
per new connection, after it is ready, and not for a refresh the service asked
for (Slack's `disconnect` frame). The bridge answers with a backfill (see
"Backfill" above). An edit or delete arrives as the same event with `edit:
{ts, editTs}` or `deleted: {ts}` set.

An error thrown by `post` or `update` may carry `publicMessage`: text safe to
show in Settings as the binding's `lastError` (Slack sets it to the API's error
code). Any other error is shown only as a generic line and logged in full.

For Telegram the mapping is direct: `getUpdates` long-polling (outbound only,
like Socket Mode), inline keyboards for options (`callback_data` ≤ 64 bytes —
option ids already fit), `reply_to_message_id` for threads and
`editMessageText` for `update`.

## Tests

One file per concern, all under `server/test/`; no suite talks to Slack or runs a
real Claude.

- `messengers.test.mjs`: the bridge with a fake adapter and host (binding
  defaults, baselines, settle window, redelivery, allow-list, group addressing,
  typed questions, opt-in approvals, cards closed elsewhere, the lock, restart,
  `/am status`).
- `messengers-outbound.test.mjs`: the `transcript` mirror (cursor, caps, splitting,
  in-place updates, credential filter, lock, `seen` migration) and Slack's 429.
  `transcript-since.test.mjs`: the reader behind it, on a real Claude transcript.
- `messengers-bridge.test.mjs`: failure paths (lookups, posts, transcript
  reads, a corrupt `messengers.json`), escaping and review limits of approval
  details, back-off and the public `lastError`.
- `messengers-cards.test.mjs`: which buttons a card carries, invisible
  characters shown escaped, and the unreviewable-details refusal.
- `messengers-backfill.test.mjs`: backfill from the watermarks (what is read,
  the 1-hour limit and its one notice per user, idempotence with the delivered
  ids) and its wiring to a connect on the bridge, including after `stop()`.
- `messengers-replies.test.mjs`: what is said back in chat, what is logged,
  answering a card once, and how an agent is addressed by name.
- `messengers-store.test.mjs`: binding and saved-list validation, and what is
  kept on disk (saved lists survive a reload and a binding's removal; thread
  state loads from an older file and drops malformed entries).
- `messengers-outbox.test.mjs`: the prompt row (persist-then-ack, drain order,
  submitted and pending, edits and deletes, the ready wait).
- `messengers-outbox-load.test.mjs`: startup load of the row directory (malformed
  rows, unreadable directory).
- `messengers-outbox-delivery.test.mjs`: outbox drain with real `deliverToSession`
  classification (pending vs submitted).
- `messengers-lock.test.mjs`: a real privacy lock deletes waiting prompts;
  `checking` saves them and holds the drain.
- `messengers-finished-digest.test.mjs`: what a finished card's digest keeps
  and drops.
- `messengers-threads.test.mjs`: routing (card threads, bot threads, names, the
  only agent), the binding pick, root rotation and the 20-root cap, the
  ephemeral and channel notices, the recent texts, and thread state kept or
  deleted when a binding is removed.
- `messengers-slack-protocol.test.mjs`: Slack rendering and escaping, Socket
  Mode acks and replies (bot filtering, edits, deletes, file shares, slash
  commands), `history`, the connect signal, and where the tokens are read.
- `messengers-slack.test.mjs`: the Slack socket (malformed frames, start/stop,
  silent connections, reconnect back-off, replaced sockets, a failing slash
  command, public API errors).
- `messengers-claude.test.mjs`: the hook payload mapping and its output.
- `messengers-hooks.test.mjs`: hook decisions on the bridge (opt-in, timeout,
  abort, several channels, failed posts and their log lines, no leftover state).
  `messengers-fixtures.mjs` holds the fixtures it shares with other suites.
- `messengers-claude-hook.test.mjs`: the hook script against a local server
  (guards, pass-through, failures reported on stderr only) and its installation.
- `messengers-http.test.mjs`: the routes on a real server (error envelope,
  admission, tokens never reach a response or the API log).
- `messengers-hook-http.test.mjs`: the hook route with a fake connected Slack
  (a client that goes away cancels the hook, closes its card, and is logged as
  `hook-response-lost`).
- `web/test/messengersApi.test.mjs` and `web/test/messengersView.test.mjs`: the
  Settings section's pure helpers (scope parsing and names, the agent picker,
  the failure line, a tree that fails to load without hiding the bindings, and
  adding, removing and picking saved channels and users).
- `claude-continuation.test.mjs`: every reader of a Claude session's
  transcript opens the same file, the last one of the `continued-in` chain
  that starts at the newest pinned copy (`liveTranscript`). Covered:
  `continuedIn` (also past the 64 KB tail window), `followContinuation`,
  `digestFor` (which feeds *finished* cards), `traceLocation`,
  `findTranscript` and the conversation reader, and the bulk digest, which
  must agree with `digestFor` even when a middle hop has the newest
  timestamp, when one uuid sits in two project dirs, and when two sessions
  pin the same chain. No card is posted in this suite.

A *finished* card waits `MESSENGER_FINISHED_DELAY_MS` (default 8000) while the
session stays in `waiting`. It is not sent when that reply was already shown in the web
UI (the server-side read mark covers it); the bridge logs `skipped-read`
instead. Input-required cards are not delayed or skipped this way.

A *finished* card comes from the agent's transcript. Claude Code can move a
running conversation to a new transcript file and leave a `continued-in` record
at the end of the old one. Agent Manager follows that chain, up to 8 hops,
wherever it reads the transcript: digests, the conversation reader, search,
download, share, and sub-agents. Before that fix, an agent moved this way (typically one created
before the Slack setup and resumed since) got no *finished* cards, although
**Send test** worked.
