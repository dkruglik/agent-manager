// Pure helpers behind Settings → Messengers (MessengersSection), kept apart so
// they can be tested without a browser. Settings is a lazy chunk, and so is this.
import { isPassive, type Session, type Tree } from '../types';
import { parseScope, type MessengerBinding, type MessengerSaved, type MessengerSavedEntry, type MessengerSavedLists, type MessengersResponse, type NewMessengerBinding } from './messengersApi';

export interface MessengersDraft { channel: string; scope: string; users: string; approvals: boolean }

/** The agent or group a binding covers. Called removed only when the tree is known. */
export function scopeName(b: MessengerBinding, tree: Tree | null): string {
  if (b.scope.type === 'group') {
    const g = tree?.groups.find((x) => x.id === b.scope.id);
    return `group ${g?.name ?? b.scope.id}${tree && !g ? ' (group removed)' : ''}`;
  }
  const s = tree?.sessions.find((x) => x.id === b.scope.id);
  return s?.name ?? `${b.scope.id}${tree ? ' (agent removed)' : ''}`;
}

/** Agents the picker offers: live ones that can take a prompt. */
export function pickableAgents(tree: Tree | null): Session[] {
  return tree?.sessions.filter((s) => !s.archivedAt && s.cli !== 'shell' && !isPassive(s.cli)) ?? [];
}

/** The binding's failure to show, or null. */
export function failureText(b: { lastError?: string | null }): string | null {
  return b.lastError || null;
}

/** The binding the "Connect a channel" form creates; throws when no scope is chosen. */
export function newBinding(draft: MessengersDraft): NewMessengerBinding {
  const scope = parseScope(draft.scope);
  if (!scope) throw new Error('Choose an agent or a group.');
  return {
    adapter: 'slack',
    target: { channel: draft.channel.trim() },
    scope,
    events: ['input-required', 'finished'],
    allowedUsers: draft.users.split(/[\s,]+/).filter(Boolean),
    approvals: draft.approvals,
  };
}

/** Each half of a load stands alone: a failed tree must not hide the bindings. */
export function settleLoad(m: PromiseSettledResult<MessengersResponse>, t: PromiseSettledResult<Tree>) {
  const failed = [m, t].find((r): r is PromiseRejectedResult => r.status === 'rejected');
  return {
    messengers: m.status === 'fulfilled' ? m.value : null,
    tree: t.status === 'fulfilled' ? t.value : null,
    error: failed ? (failed.reason as Error)?.message || String(failed.reason) : '',
  };
}

/** One adapter's saved channel and user ids; empty lists when the server has none. */
export function savedFor(saved: MessengerSaved | undefined, adapter: string): MessengerSavedLists {
  const e = saved?.[adapter];
  return { channels: e?.channels ?? [], users: e?.users ?? [] };
}

/** The list with `id` added (or renamed when already there). Empty ids are ignored. */
export function addSaved(list: readonly MessengerSavedEntry[], id: string, name: string): MessengerSavedEntry[] {
  const cleanId = id.trim();
  if (!cleanId) return [...list];
  const entry = { id: cleanId, name: name.trim() };
  if (list.some((x) => x.id === cleanId)) return list.map((x) => (x.id === cleanId ? entry : x));
  return [...list, entry];
}

/** Ids in a draft of user ids (split on spaces and commas) that are not saved yet, once each. */
export function newUserIds(draftUsers: string, saved: readonly MessengerSavedEntry[]): string[] {
  const ids = draftUsers.split(/[\s,]+/).filter((id) => id && !saved.some((u) => u.id === id));
  return [...new Set(ids)];
}

/** The users list to save: `saved` plus the draft's new ids, unnamed. Saved entries keep their names. */
export function usersToSave(saved: readonly MessengerSavedEntry[], draftUsers: string): MessengerSavedEntry[] {
  return newUserIds(draftUsers, saved).reduce((list, id) => addSaved(list, id, ''), [...saved]);
}

export function removeSaved(list: readonly MessengerSavedEntry[], id: string): MessengerSavedEntry[] {
  return list.filter((x) => x.id !== id);
}

/** The users draft with `id` appended once; manual text is kept as typed, except that trailing
 *  spaces and commas are stripped before the id is appended. */
export function addUserToDraft(users: string, id: string): string {
  const ids = users.split(/[\s,]+/).filter(Boolean);
  if (!id || ids.includes(id)) return users;
  return ids.length ? `${users.replace(/[\s,]+$/, '')}, ${id}` : id;
}

export function savedLabel(e: MessengerSavedEntry): string {
  return e.name ? `${e.name} (${e.id})` : e.id;
}
