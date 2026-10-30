import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import * as messengers from '../lib/messengersApi';
import type { MessengerAdapter, MessengerBinding, MessengerEvent } from '../lib/messengersApi';
import type { Tree } from '../types';

// Settings → General → Messengers. Connects a Slack channel (or another
// messenger) to a session or a group; see docs/messengers.md for setup.
const EVENT_LABELS: Record<MessengerEvent, string> = { 'input-required': 'needs input', finished: 'finished work' };

export function MessengersSection() {
  const [adapters, setAdapters] = useState<MessengerAdapter[]>([]);
  const [bindings, setBindings] = useState<MessengerBinding[]>([]);
  const [tree, setTree] = useState<Tree | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState({ channel: '', scope: '', users: '', approvals: false });

  const load = useCallback(async () => {
    try {
      const [m, t] = await Promise.all([messengers.getMessengers(), api.getTree()]);
      setAdapters(m.adapters);
      setBindings(m.bindings);
      setTree(t);
      setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);

  const scopeName = (b: MessengerBinding) => {
    if (b.scope.type === 'group') return `group ${tree?.groups.find((g) => g.id === b.scope.id)?.name ?? b.scope.id}`;
    return tree?.sessions.find((s) => s.id === b.scope.id)?.name ?? b.scope.id;
  };
  const run = async (fn: () => Promise<unknown>, ok = '') => {
    setErr(''); setNote('');
    try { await fn(); if (ok) setNote(ok); await load(); } catch (e) { setErr((e as Error).message); }
  };
  const add = () => run(async () => {
    const [type, id] = draft.scope.split(':');
    await messengers.createMessengerBinding({
      adapter: 'slack',
      target: { channel: draft.channel.trim() },
      scope: { type: type as 'session' | 'group', id },
      events: ['input-required', 'finished'],
      allowedUsers: draft.users.split(/[\s,]+/).filter(Boolean),
      approvals: draft.approvals,
    });
    setDraft({ ...draft, channel: '', users: '' });
  }, 'Connected. Use “Send test” to check the channel.');
  const toggleEvent = (b: MessengerBinding, e: MessengerEvent) => {
    const events = b.events.includes(e) ? b.events.filter((x) => x !== e) : [...b.events, e];
    if (events.length) run(() => messengers.updateMessengerBinding(b.id, { events }));
  };

  const live = tree?.sessions.filter((s) => !s.archivedAt && s.cli !== 'shell' && s.cli !== 'files' && s.cli !== 'trace') ?? [];
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
              {!a.configured ? <>Set <span className="mono">SLACK_BOT_TOKEN</span> and <span className="mono">SLACK_APP_TOKEN</span> and restart.</>
                : a.connected ? 'Connected.' : `Not connected${a.error ? ` — ${a.error}` : ''}.`}
            </div>
          </div>
          <span className={a.connected ? 'save-flag' : 's-muted'}>{a.connected ? 'online' : 'offline'}</span>
        </div>
      ))}
      {bindings.map((b) => (
        <div className="setting-row row-top" key={b.id}>
          <div>
            <div className="s-label">{b.adapter} <span className="mono">{b.target.channel}</span> → {scopeName(b)}</div>
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
              {b.lastError && <div className="s-muted">Posting is failing — <span className="mono">{b.lastError}</span>. Retrying with a growing delay.</div>}
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
            <select className="cfg-input" aria-label="Agent or group" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
              <option value="">Agent or group…</option>
              {tree?.groups.length ? <optgroup label="Groups">{tree.groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}</optgroup> : null}
              <optgroup label="Agents">{live.map((s) => <option key={s.id} value={`session:${s.id}`}>{s.name}</option>)}</optgroup>
            </select>
            <input className="cfg-input" aria-label="Allowed user ids" placeholder="Allowed user ids, e.g. U0123ABCD" value={draft.users}
              onChange={(e) => setDraft({ ...draft, users: e.target.value })} />
            <label className="s-help"><input type="checkbox" checked={draft.approvals}
              onChange={(e) => setDraft({ ...draft, approvals: e.target.checked })} /> allow approving tool calls and answering Claude's questions from chat</label>
            {note && <div className="s-help">{note}</div>}
          </div>
          <button className="btn-ghost" disabled={!draft.channel.trim() || !draft.scope || !draft.users.trim()} onClick={add}>Connect</button>
        </div>
      )}
    </>
  );
}
