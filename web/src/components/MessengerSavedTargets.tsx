import { useState } from 'react';
import * as messengers from '../lib/messengersApi';
import type { MessengerSavedEntry, MessengerSavedLists } from '../lib/messengersApi';
import { addSaved, newUserIds, removeSaved, savedLabel, usersToSave } from '../lib/messengersView';

// Saved Slack channel and user ids (ids and optional names, never tokens): save what the
// "Connect a channel" form holds (Save channel also stores the optional name), or remove an
// entry. Writes go through `run`, one at a time: each PUT sends both whole lists.
interface Props extends MessengerSavedLists {
  adapter: string;
  draftChannel: string;
  draftUsers: string;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
}

export function MessengerSavedTargets({ adapter, channels, users, draftChannel, draftUsers, run }: Props) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const channel = draftChannel.trim();
  const hasNewUsers = newUserIds(draftUsers, users).length > 0;
  const save = async (c: readonly MessengerSavedEntry[], u: readonly MessengerSavedEntry[], ok: string): Promise<boolean> => {
    setBusy(true);
    try { return await run(() => messengers.saveMessengerTargets(adapter, c, u), ok); } finally { setBusy(false); }
  };
  const saveChannel = async () => { if (await save(addSaved(channels, channel, name), users, 'Channel saved.')) setName(''); };
  const saveUsers = () => save(channels, usersToSave(users, draftUsers), 'Users saved.');
  const remove = (kind: 'channel' | 'user', id: string) =>
    kind === 'channel' ? save(removeSaved(channels, id), users, '') : save(channels, removeSaved(users, id), '');
  const entries = [
    ...channels.map((e) => ({ kind: 'channel' as const, e })),
    ...users.map((e) => ({ kind: 'user' as const, e })),
  ];
  return (
    <div className="setting-row row-top">
      <div>
        <div className="s-label">Saved channels and users</div>
        <div className="s-help">Pick these in “Connect a channel” instead of pasting ids.</div>
        <input className="cfg-input" aria-label="Channel name" placeholder="Name for the channel id (optional)" value={name}
          onChange={(e) => setName(e.target.value)} />
        <button className="btn-ghost" disabled={busy || !channel || channels.some((c) => c.id === channel)} onClick={saveChannel}>Save channel</button>
        <button className="btn-ghost" disabled={busy || !hasNewUsers} onClick={saveUsers}>Save users</button>
        {entries.map(({ kind, e }) => (
          <div className="s-help" key={`${kind}:${e.id}`}>
            {kind} {e.name && `${e.name} `}<span className="mono">{e.id}</span>{' '}
            <button className="btn-ghost" disabled={busy} aria-label={`Remove saved ${kind} ${savedLabel(e)}`}
              onClick={() => remove(kind, e.id)}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}
