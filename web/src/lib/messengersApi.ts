// Messenger bindings (docs/messengers.md). Kept out of api.ts so the code only
// Settings needs stays out of the entry chunk. Requests are stamped with the
// same headers as api.ts's helpers.
import { decodeResponse } from '../apiResponse';
import { requestHeaders } from '../requestIntent';

const requestJson = async <T>(input: string, init: RequestInit = {}): Promise<T> => {
  const headers = requestHeaders(init.headers, init.method || 'GET');
  return decodeResponse<T>(await fetch(input, { ...init, headers }));
};

export type MessengerEvent = 'input-required' | 'finished';
export interface MessengerBinding {
  id: string; adapter: string; target: { channel: string };
  scope: { type: 'session' | 'group'; id: string };
  events: MessengerEvent[]; allowedUsers: string[]; approvals: boolean;
  createdAt: string;
  /** Set while the binding's posts or lookups are failing: the adapter's public error (a Slack error
   *  code) or a generic line; never a token, path or network detail. */
  lastError?: string | null;
}
export interface MessengerAdapterStatus { id: string; configured: boolean; connected: boolean; error: string | null; }
export type NewMessengerBinding = Omit<MessengerBinding, 'id' | 'createdAt'>;

/** `session:<id>` / `group:<id>` from the scope picker. Splits on the first ':'
 *  only, so an id that contains one stays whole. */
export function parseScope(value: string): MessengerBinding['scope'] | null {
  const i = value.indexOf(':');
  const type = value.slice(0, i);
  const id = value.slice(i + 1);
  return i > 0 && id && (type === 'session' || type === 'group') ? { type, id } : null;
}

const HEADERS = { 'content-type': 'application/json' };
const bindingUrl = (id: string, suffix = ''): string => `/api/messengers/bindings/${encodeURIComponent(id)}${suffix}`;

export const getMessengers = (): Promise<{ adapters: MessengerAdapterStatus[]; bindings: MessengerBinding[] }> =>
  requestJson('/api/messengers');
export const createMessengerBinding = (b: NewMessengerBinding): Promise<MessengerBinding> =>
  requestJson('/api/messengers/bindings', { method: 'POST', headers: HEADERS, body: JSON.stringify(b) });
export const updateMessengerBinding = (id: string, patch: Partial<Omit<NewMessengerBinding, 'adapter'>>): Promise<MessengerBinding> =>
  requestJson(bindingUrl(id), { method: 'PUT', headers: HEADERS, body: JSON.stringify(patch) });
export const deleteMessengerBinding = (id: string): Promise<{ ok: boolean }> =>
  requestJson(bindingUrl(id), { method: 'DELETE' });
export const testMessengerBinding = (id: string): Promise<{ ok: boolean }> =>
  requestJson(bindingUrl(id, '/test'), { method: 'POST' });
