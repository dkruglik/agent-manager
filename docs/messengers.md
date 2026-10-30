# Messengers: Slack (and others) as a two-way channel

**Status:** phase 2 implemented — Slack adapter, typed answers for shared Codex,
Claude Code permission prompts and questions answered from chat (opt-in per
binding), free-text prompts for every agent CLI. 2026-10-29.

Connect a chat channel to one agent or to a whole group. The channel then gets a
card when an agent **needs input** and when it **finishes a turn**, and you can
answer from the chat:

| In the chat | What happens in Agent Manager |
| --- | --- |
| Click an option on a question card | The question is answered through the CLI's typed API |
| Reply in a question card's thread | Your text answers the first open question |
| Click **Approve once / Deny** (only with *allow approvals*) | The permission request is decided |
| Reply in a finished card's thread | Sent to that agent as a normal prompt |
| `agent-name: text` in a group channel | Sent to that agent as a normal prompt |
| A plain message in a single-agent channel | Sent to that agent as a normal prompt |
| `/am status` | Lists agents in scope and their state |

A card closes itself when its dialog is answered anywhere else (terminal,
reader, another chat). Clicking a closed card does nothing.

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

## Claude Code approvals

Claude Code exposes no typed answer path into a running TUI, but it does run
*blocking* hooks before it shows a dialog. Agent Manager installs
`scripts/am-claude-approval-hook.sh` as a `PermissionRequest` hook and as a
`PreToolUse` hook for `AskUserQuestion`, next to its existing lifecycle hooks.

The server writes these hooks into `$CLAUDE_CONFIG_DIR/settings.json` when it
starts, and only when `CLAUDE_CONFIG_DIR` is set (the container image sets it).
On a VPS or a local install, set it yourself, for example to `~/.claude`, before
starting the server ([configuration table](development.md#configuration)). The
hook script needs `jq` and `curl` on `PATH`; without either, or without the
setting, nothing is installed or the hook does nothing, and prompts stay in the
terminal.

1. Claude runs the hook with the pending tool call (or the questions).
2. The hook — only in the pane's own `claude` process (`CLAUDE_PID` and
   `AM_PANE_PID`, as the input-required hook checks) — calls
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
   Manager stops, they say so too. In each case the hook prints nothing and
   Claude falls back to its dialog. The hook's own timeout is 150 s.

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
  list is ignored and logged. Being in the channel is not enough.
- **Approvals are opt-in per binding.** Without it, permission cards show no
  buttons and a forged button value is refused, and Claude's blocking hook
  returns at once without a decision.
- **The privacy lock stops cards and deliveries.** No card is posted and no
  reply, answer or approval is delivered to an agent while the instance is
  locked; refusal notices and `/am status` still reply in the channel, and
  `/am status` lists no agents.
- **Tokens live in the environment**, never in `messengers.json`.
- **Audit.** Binding changes go through the API and appear in the API log.
  Posted cards, answers, prompts and refusals are written to
  `DATA_DIR/messengers.log.jsonl`.
- Agent Manager still has no login of its own: anything that can reach the API
  can change bindings. The messenger does not widen that boundary — the bridge
  only answers dialogs and sends prompts for sessions a binding covers.

## Data

`DATA_DIR/messengers.json` holds the bindings plus delivery state: which cards
are in which channel (so a restart neither re-posts nor loses the ability to
answer) and the newest reply already accounted for per agent (so connecting a
channel does not replay old answers). Card records expire after 7 days.

## API

| Route | |
| --- | --- |
| `GET /api/messengers` | Adapters (configured / connected / error) and bindings; a binding whose posts keep failing carries `lastError` (a Slack error code) and is retried after 5 s, doubling to 5 min |
| `POST /api/messengers/bindings` | `{adapter, target:{channel}, scope:{type:"session"\|"group", id}, events?, allowedUsers, approvals?}` |
| `PUT /api/messengers/bindings/:id` | Partial update; `adapter` cannot change |
| `DELETE /api/messengers/bindings/:id` | |
| `POST /api/messengers/bindings/:id/test` | Posts a test card; `409 messenger-offline` when the messenger is not connected |
| `POST /api/messengers/claude-hook?from=<session>` | Used by the Claude hook: `{runId, payload}` → `{output}` after at most 120 s; `409 conflict` unless `runId` is the pane's live launch |

Invalid input is `400 invalid-input` with `details[].field`; an unknown binding
is `404 not-found` ([error contract](api-errors.md)).

## Adding a messenger

An adapter is a class in `server/src/messengers/adapters/`, registered in
`ADAPTERS` (`server/src/messengers/index.js`) with a factory that receives its
section of `MESSENGERS` from `config.js`. Its tokens are read there, like every
operator-facing setting. It knows nothing about agents:

```js
export class XAdapter {
  constructor({ token = '' } = {}) { this.id = 'x'; this.token = token; }
  configured() { return !!this.token; }
  start({ onReply, onCommand, onStatus, log }) {}   // connect; call onStatus({connected, error})
  async stop() {}
  async post({ channel, thread }, card) { return { channel, ts }; } // ts: the message id
  async update(ref, card) {}                         // re-render a posted card
}
```

The bridge itself is split by direction: `bridge.js` (`MessengerBridge`) watches
sessions and posts cards, `replies.js` (`ReplyRouter`) turns chat events into
answers and prompts, and `cards.js` builds the neutral cards both use.

A **card** is `{kind, title, agent:{id,name,cli,group}, body, details, options:[{id,label,style}], hint, link, resolved}`.
Render `options` as buttons whose callback carries `option.id`; when `resolved`
is set, drop the buttons and show `resolved.text`.

Inbound events go to `onReply({channel, ts, thread, user:{id,name}, messageId, optionId?, text?})`:
`ts` is the message a button lives on, `thread` the card a threaded reply belongs
to, and `messageId` a stable id the bridge uses to drop redeliveries. Commands go
to `onCommand({channel, user, text})`, which resolves to reply text.

For Telegram the mapping is direct: `getUpdates` long-polling (outbound only,
like Socket Mode), inline keyboards for options (`callback_data` ≤ 64 bytes —
option ids already fit), `reply_to_message_id` for threads and
`editMessageText` for `update`.

## Tests

`server/test/messengers.test.mjs` drives the bridge with a fake adapter and a
fake host (baselines, settle window, redelivery, allow-list, group addressing,
typed questions, opt-in approvals, cards closed elsewhere, the lock, restart),
and the Slack adapter with a fake socket and `fetch` (envelope acks, bot-message
filtering, slash-command replies, token use).
`server/test/messengers-http.test.mjs` exercises the routes on a real server:
the error envelope, admission, and that tokens reach neither a response nor the
API log. `messengers-claude.test.mjs` covers the hook payload mapping and the
bridge's wait (opt-in, timeout, abort, several channels), and
`messengers-claude-hook.test.mjs` runs the hook script against a local server
(guards, pass-through, silent failure) and its installation. No suite talks to
Slack or runs a real Claude.
