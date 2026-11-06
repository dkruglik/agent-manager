import { appUrl } from './appUrl';
import { requestOpenSession } from './openSession';

/** Opens the session a `#session=<id>` link names, once the tree knows it, and
 *  drops the hash so a reload does not jump there again. */
export function openLinkedSession(sessions: ReadonlyArray<{ id: string }>): void {
  const id = new URLSearchParams(location.hash.slice(1)).get('session');
  if (!id || !sessions.some((s) => s.id === id)) return;
  history.replaceState(history.state, '', appUrl());
  requestOpenSession(id);
}
