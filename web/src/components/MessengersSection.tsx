import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import * as messengers from '../lib/messengersApi';
import type { MessengerAdapterStatus, MessengerBinding, MessengerEvent, MessengerSaved } from '../lib/messengersApi';
import { addUserToDraft, failureText, newBinding, pickableAgents, savedFor, savedLabel, scopeName, settleLoad } from '../lib/messengersView';
import type { Tree } from '../types';
import { MessengerSavedTargets } from './MessengerSavedTargets';

// Settings → General → Messengers. Connects a Slack channel (or another
// messenger) to a session or a group; see docs/messengers.md for setup.
const EVENT_LABELS: Record<MessengerEvent, string> = { 'input-required': 'needs input', finished: 'finished work' };

function adapterHelp(a: MessengerAdapterStatus) {
  if (!a.configured) return <>Set <span className="mono">SLACK_BOT_TOKEN</span> and <span className="mono">SLACK_APP_TOKEN</span> and restart.</>;
  if (a.connected) return 'Connected.';
  return `Not connected${a.error ? ` — ${a.error}` : ''}.`;
}

export function MessengersSection() {
  const [adapters, setAdapters] = useState<MessengerAdapterStatus[]>([]);
  const [bindings, setBindings] = useState<MessengerBinding[]>([]);
  const [saved, setSaved] = useState<MessengerSaved | undefined>(undefined);
  const [tree, setTree] = useState<Tree | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState({ channel: '', scope: '', users: '', approvals: false });

  const load = useCallback(async () => {
    const loaded = settleLoad(...await Promise.allSettled([messengers.getMessengers(), api.getTree()]));
    if (loaded.messengers) {
      setAdapters(loaded.messengers.adapters);
      setBindings(loaded.messengers.bindings);
      setSaved(loaded.messengers.saved);
    }
    if (loaded.tree) setTree(loaded.tree);
    setErr(loaded.error);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);

  const run = async (fn: () => Promise<unknown>, ok = '') => {
    setErr(''); setNote('');
    try { await fn(); if (ok) setNote(ok); await load(); } catch (e) { setErr((e as Error).message); }
  };
  const add = () => run(async () => {
    await messengers.createMessengerBinding(newBinding(draft));
    setDraft({ ...draft, channel: '', users: '' });
  }, 'Connected. Use “Send test” to check the channel.');
  const toggleEvent = (b: MessengerBinding, e: MessengerEvent) => {
    const events = b.events.includes(e) ? b.events.filter((x) => x !== e) : [...b.events, e];
    if (events.length) run(() => messengers.updateMessengerBinding(b.id, { events }));
  };

  const live = pickableAgents(tree);
  const mine = savedFor(saved, 'slack');
  return (
    <>
      <h3>Messengers</h3>
      <div className="s-help">
        Send “needs input” and “finished” cards to a chat channel, and answer from there. Only the listed
        user ids can reply. Approving a tool call from chat is off unless you turn it on for a binding.
      </div>
      {adapters.map((a) => (
        <div className="setting-row" key={a.id}>
          <div>
            <div className="s-label">{a.id[0].toUpperCase() + a.id.slice(1)}</div>
            <div className="s-help">
              {adapterHelp(a)}
            </div>
          </div>
          <span className={a.connected ? 'save-flag' : 's-muted'}>{a.connected ? 'online' : 'offline'}</span>
        </div>
      ))}
      {bindings.map((b) => (
        <div className="setting-row row-top" key={b.id}>
          <div>
            <div className="s-label">{b.adapter} <span className="mono">{b.target.channel}</span> → {scopeName(b, tree)}</div>
            <div className="s-help">
              {(Object.keys(EVENT_LABELS) as MessengerEvent[]).map((e) => (
                <label key={e} style={{ marginRight: 12 }}>
                  <input type="checkbox" checked={b.events.includes(e)} onChange={() => toggleEvent(b, e)} /> {EVENT_LABELS[e]}
                </label>
              ))}
              <label>
                <input type="checkbox" checked={b.approvals} onChange={() => run(() => messengers.updateMessengerBinding(b.id, { approvals: !b.approvals }))} /> allow approvals (Codex, Claude Code)
              </label>
              <div>Allowed users: <span className="mono">{b.allowedUsers.join(', ') || 'nobody'}</span></div>
              {failureText(b) && <div className="s-muted">Failing — <span className="mono">{failureText(b)}</span>. Retrying with a growing delay.</div>}
            </div>
          </div>
          <span className="confirm-del">
            <button className="btn-ghost" onClick={() => run(() => messengers.testMessengerBinding(b.id), 'Test card sent.')}>Send test</button>
            <button className="btn-ghost" onClick={() => run(() => messengers.deleteMessengerBinding(b.id))}>Remove</button>
          </span>
        </div>
      ))}
      {err && <div className="s-help s-err" role="alert">{err}</div>}
      {adapters.length > 0 && (
        <div className="setting-row row-top">
          <div>
            <div className="s-label">Connect a channel</div>
            <input className="cfg-input" aria-label="Channel id" placeholder="Channel id, e.g. C0123ABCD" value={draft.channel}
              onChange={(e) => setDraft({ ...draft, channel: e.target.value })} />
            {mine.channels.length > 0 && (
              <select className="cfg-input" aria-label="Saved channel" value="" onChange={(e) => e.target.value && setDraft({ ...draft, channel: e.target.value })}>
                <option value="">Saved channel…</option>
                {mine.channels.map((c) => <option key={c.id} value={c.id}>{savedLabel(c)}</option>)}
              </select>
            )}
            <select className="cfg-input" aria-label="Agent or group" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
              <option value="">Agent or group…</option>
              {tree?.groups.length ? <optgroup label="Groups">{tree.groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}</optgroup> : null}
              <optgroup label="Agents">{live.map((s) => <option key={s.id} value={`session:${s.id}`}>{s.name}</option>)}</optgroup>
            </select>
            <input className="cfg-input" aria-label="Allowed user ids" placeholder="Allowed user ids, e.g. U0123ABCD" value={draft.users}
              onChange={(e) => setDraft({ ...draft, users: e.target.value })} />
            {mine.users.length > 0 && (
              <select className="cfg-input" aria-label="Add saved user" value="" onChange={(e) => e.target.value && setDraft({ ...draft, users: addUserToDraft(draft.users, e.target.value) })}>
                <option value="">Add saved user…</option>
                {mine.users.map((u) => <option key={u.id} value={u.id}>{savedLabel(u)}</option>)}
              </select>
            )}
            <label className="s-help"><input type="checkbox" checked={draft.approvals}
              onChange={(e) => setDraft({ ...draft, approvals: e.target.checked })} /> allow approving tool calls and answering Claude's questions from chat</label>
            {note && <div className="s-help">{note}</div>}
          </div>
          <button className="btn-ghost" disabled={!draft.channel.trim() || !draft.scope || !draft.users.trim()} onClick={add}>Connect</button>
        </div>
      )}
      {adapters.length > 0 && (
        <MessengerSavedTargets adapter="slack" channels={mine.channels} users={mine.users}
          draftChannel={draft.channel} draftUsers={draft.users} run={run} />
      )}
    </>
  );
}
