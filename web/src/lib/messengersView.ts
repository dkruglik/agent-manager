// Pure helpers behind Settings → Messengers (MessengersSection), kept apart so
// they can be tested without a browser. Settings is a lazy chunk, and so is this.
import { isPassive, type Session, type Tree } from '../types';
import { parseScope, type MessengerAdapterStatus, type MessengerBinding, type NewMessengerBinding } from './messengersApi';

export interface MessengersDraft { channel: string; scope: string; users: string; approvals: boolean }
export interface MessengersList { adapters: MessengerAdapterStatus[]; bindings: MessengerBinding[] }

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
export function settleLoad(m: PromiseSettledResult<MessengersList>, t: PromiseSettledResult<Tree>) {
  const failed = [m, t].find((r): r is PromiseRejectedResult => r.status === 'rejected');
  return {
    messengers: m.status === 'fulfilled' ? m.value : null,
    tree: t.status === 'fulfilled' ? t.value : null,
    error: failed ? (failed.reason as Error)?.message || String(failed.reason) : '',
  };
}
