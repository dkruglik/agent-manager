import { useState } from 'react';
import * as messengers from '../lib/messengersApi';
import type { MessengerSavedEntry } from '../lib/messengersApi';
import { addSaved, removeSaved, savedLabel } from '../lib/messengersView';

// Saved Slack channel and user ids (ids only, never tokens): save what the
// "Connect a channel" form holds, or remove an entry. Writes go through `run`.
interface Props {
  adapter: string;
  channels: MessengerSavedEntry[];
  users: MessengerSavedEntry[];
  draftChannel: string;
  draftUsers: string;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}

export function MessengerSavedTargets({ adapter, channels, users, draftChannel, draftUsers, run }: Props) {
  const [name, setName] = useState('');
  const channel = draftChannel.trim();
  const newUsers = draftUsers.split(/[\s,]+/).filter((id) => id && !users.some((u) => u.id === id));
  const save = (c: MessengerSavedEntry[], u: MessengerSavedEntry[], ok: string) =>
    run(() => messengers.saveMessengerTargets(adapter, c, u), ok);
  const entries = [
    ...channels.map((e) => ({ kind: 'channel', e })),
    ...users.map((e) => ({ kind: 'user', e })),
  ];
  return (
    <div className="setting-row row-top">
      <div>
        <div className="s-label">Saved channels and users</div>
        <div className="s-help">Pick these in “Connect a channel” instead of pasting ids.</div>
        <input className="cfg-input" aria-label="Channel name" placeholder="Name for the channel id (optional)" value={name}
          onChange={(e) => setName(e.target.value)} />
        <button className="btn-ghost" disabled={!channel || channels.some((c) => c.id === channel)}
          onClick={() => save(addSaved(channels, channel, name), users, 'Channel saved.').then(() => setName(''))}>Save channel</button>
        <button className="btn-ghost" disabled={!newUsers.length}
          onClick={() => save(channels, newUsers.reduce((l, id) => addSaved(l, id, ''), users), 'Users saved.')}>Save users</button>
        {entries.map(({ kind, e }) => (
          <div className="s-help" key={`${kind}:${e.id}`}>
            {kind} {e.name && `${e.name} `}<span className="mono">{e.id}</span>{' '}
            <button className="btn-ghost" aria-label={`Remove saved ${kind} ${savedLabel(e)}`}
              onClick={() => (kind === 'channel' ? save(removeSaved(channels, e.id), users, '') : save(channels, removeSaved(users, e.id), ''))}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}
