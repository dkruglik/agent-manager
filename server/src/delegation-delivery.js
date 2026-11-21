// How a finished delegation's callback reaches its parent, recorded apart from
// the delegation's outcome (docs/agent-delegation-workflow.md). Pure record
// keeping plus the Claude receipt files; the state machine stays in delegations.js.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ApiError} from './api-errors.js';
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(s);
const fail = (code, message) => new ApiError(409, code, message);

/**
 * @typedef {'pending'|'delivered'|'uncertain'|'not-delivered'} DeliveryState
 * @typedef {{state: DeliveryState, reason: string|null, attempts: number, lastAttemptAt: number|null}} Delivery
 */
// Job states that end a delegation without a callback (no delivery follows).
const ENDED = new Set(['cancelled','expired','stale','failed']);
// What a journal written before `delivery` existed says about its callback.
const DERIVED = {'delivered':'delivered','notification-uncertain':'uncertain','notification-review':'uncertain','ready':'pending'};

/** The job's delivery record, derived from `state`/`reason` for an older journal. @returns {Delivery} */
export function deliveryOf(j) {
  const stored = j.delivery ? {...j.delivery} : {state:DERIVED[j.state] || 'pending', reason:DERIVED[j.state] && j.state!=='delivered' ? j.reason || null : null, attempts:0, lastAttemptAt:null};
  if (ENDED.has(j.state) && stored.state!=='delivered') return {...stored, state:'not-delivered', reason:j.state};
  return stored;
}
/** Record the start of one callback attempt. */
export const startAttempt = (j, now) => {const d=deliveryOf(j);j.delivery={...d, state:'pending', reason:null, attempts:d.attempts+1, lastAttemptAt:now};};
/** Record how the attempt ended: the job state tick() chose, and the error code if any. */
export const endAttempt = (j, reason=null) => {
  const state=j.state==='delivered' ? 'delivered' : DERIVED[j.state] || 'pending';
  j.delivery={...deliveryOf(j), state, reason:state==='delivered' ? null : reason};
};
/**
 * The reason a caller sees: the delivery's, once the result is known and the
 * callback did not land; otherwise the outcome's (or the dispatch's).
 */
export function reasonOf(j) {
  const d=deliveryOf(j);
  if (j.evidence?.outcome && d.reason && d.state!=='delivered') return d.reason;
  return j.evidence?.reason || j.reason || null;
}

// Claude has no native receipt channel. The receipt is written before the paste
// and a retry of `sending`/`submitted` never pastes again. A throw before any
// byte is typed deletes the receipt so the next tick can try.
const notifyPath = (dir, id) => path.join(dir, 'notify', id + '.json');
export function readNotifyReceipt(dir, id) {
  if(!uuid(id))return {status:'sending'};
  let fd;
  try {
    fd=fs.openSync(notifyPath(dir,id),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const s=fs.fstatSync(fd);
    if(!s.isFile() || s.size>8192)return {status:'sending'};
    return JSON.parse(fs.readFileSync(fd,'utf8'));
  } catch(e){if(e.code==='ENOENT')return null;return {status:'sending'};}
  finally {if(fd!==undefined)fs.closeSync(fd);}
}
export function writeNotifyReceipt(dir, id, record) {
  if(!uuid(id))throw fail('delegation-notify-uncertain','Callback id is not durable.');
  const folder=path.join(dir,'notify');
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const dest=notifyPath(dir,id),tmp=dest+'.'+randomUUID()+'.tmp';
  let fd;
  try {
    fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    fs.renameSync(tmp,dest);fd=fs.openSync(folder,'r');fs.fsyncSync(fd);
  } finally {if(fd!==null && fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}}
}
export function clearNotifyReceipt(dir, id) {
  if(!uuid(id))return;
  try{fs.unlinkSync(notifyPath(dir,id));}catch{}
}
export async function notifyClaudeOnce(dir, callbackId, send) {
  const existing=readNotifyReceipt(dir,callbackId);
  if(existing?.status==='accepted')return {ok:true,repeated:true};
  if(existing)throw fail('delegation-notify-uncertain','The callback may already have been typed; it was not pasted again.');
  writeNotifyReceipt(dir,callbackId,{status:'sending'});
  try {
    const result=await send();
    writeNotifyReceipt(dir,callbackId,{status:'accepted'});
    return result ?? {ok:true};
  } catch(error) {
    if(error?.typed===true){
      writeNotifyReceipt(dir,callbackId,{status:'submitted'});
      error.code='delegation-notify-uncertain';
      throw error;
    }
    clearNotifyReceipt(dir,callbackId);
    throw error;
  }
}
