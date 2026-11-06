import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Delegations,consumeEvidence,hash,traceCheckpoint,delegationSupported,notifyClaudeOnce} from '../src/delegations.js';
const input=text=>({type:'user',message:{content:text}});
const answer=(text='Review ready',reason='end_turn')=>({type:'assistant',message:{content:[{type:'text',text}],stop_reason:reason}});
function fixture(t,overrides={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-delegation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'trace.jsonl');fs.writeFileSync(file,JSON.stringify(answer('old answer'))+'\n');
 const state={parent:'working',target:'waiting'}, identities={parent:'p1',target:'t1'};let now=1000,dispatches=0,notifications=0,lock=false;
 const append=r=>fs.appendFileSync(file,JSON.stringify(r)+'\n');
 const options={dir:path.join(root,'journal'),identity:id=>identities[id],state:async id=>state[id],assertWritable:()=>{if(lock)throw Error('locked')},now:()=>now,
  prepare:async()=>({cli:'claude',expectedText:'placeholder',cursor:traceCheckpoint(file)}),
  dispatch:async(j,payload)=>{dispatches++;j.expectedHash=hash(payload);append(input(payload));},
  notify:async()=>{notifications++;return {ok:true,queued:true,queuedSubmissionId:'native-ack'}},...overrides};
 const create=()=>new Delegations(options);const d=create();
 return {d,create,options,file,state,identities,append,counts:()=>({dispatches,notifications}),time:n=>{now=n},lock:v=>{lock=v}};
}
async function start(f,id=randomUUID()){const result=await f.d.create('parent','target',{requestId:id,text:'review'});return result.id;}

test('exact exchange and terminal text, not waiting, old output, tool data or intermediate text',async t=>{
 const f=fixture(t);const id=await start(f);await f.d.tick();assert.equal(f.d.get(id,'parent').outcome,null);
 f.append({type:'user',message:{content:[{type:'tool_result',content:'end_turn: result ready'}]}});
 f.append(answer('Working on it','tool_use'));await f.d.tick();assert.equal(f.d.get(id,'parent').outcome,null);
 f.append(answer('The review is done'));await f.d.tick();assert.equal(f.d.get(id,'parent').outcome,'completed');assert.equal(f.counts().notifications,0);
 f.state.parent='waiting';await Promise.all([f.d.tick(),f.d.tick()]);assert.equal(f.counts().notifications,1);assert.equal(f.d.get(id,'parent').state,'delivered');
 await f.create().tick();assert.equal(f.counts().notifications,1);
});
test('retry idempotency and restart during initial dispatch never paste twice',async t=>{
 const f=fixture(t,{dispatch:async()=>{throw Error('lost ack')}});const id=await start(f);
 assert.equal(f.d.get(id,'parent').state,'dispatch-uncertain');
 await f.d.create('parent','target',{requestId:id,text:'review'});
 const resumed=f.create();await resumed.tick();assert.equal(resumed.get(id,'parent').state,'dispatch-uncertain');
 await assert.rejects(()=>resumed.create('parent','target',{requestId:id,text:'changed'}),{code:'delegation-conflict'});
});
test('notification crash retry uses the same receipt UUID, not a new callback',async t=>{
 const seen=[];const f=fixture(t,{notify:async j=>{seen.push(j.callbackId);return {ok:true,repeated:seen.length>1}}});
 const id=await start(f);f.append(answer());f.state.parent='waiting';await f.d.tick();
 const j=f.d.jobs.get(id);j.state='notifying';f.d.save(j);await f.create().tick();assert.equal(seen.length,2);assert.equal(seen[0],seen[1]);
});
test('uncertain notification acknowledgement is durable and never replayed',async t=>{
 let calls=0;const f=fixture(t,{notify:async()=>{calls++;throw Object.assign(Error(),{code:'codex-send-uncertain'})}});
 const id=await start(f);f.append(answer());f.state.parent='waiting';await f.d.tick();await f.create().tick();
 assert.equal(calls,1);assert.equal(f.d.get(id,'parent').state,'notification-uncertain');
});
test('blocked, failed, and displaced exchanges are not completed',async t=>{
 for(const [state,record,outcome] of [['input-required',null,'blocked'],['stopped',null,'failed'],['waiting',input('unrelated new prompt'),'uncertain']]){
  const f=fixture(t);const id=await start(f);f.state.target=state;if(record)f.append(record);await f.d.tick();assert.equal(f.d.get(id,'parent').outcome,outcome);
 }
});
test('privacy lock, expired or remapped parent and cancellation suppress wakeups',async t=>{
 for(const mode of ['lock','expired','remap','cancel']){
  const f=fixture(t);const id=await start(f);f.append(answer());f.state.parent='waiting';
  if(mode==='lock')f.lock(true);if(mode==='expired')f.time(90000000);if(mode==='remap')f.identities.parent='p2';if(mode==='cancel')f.d.cancel(id,'parent');
  await f.d.tick();assert.equal(f.counts().notifications,0,mode);
 }
});
test('concurrent retry, duplicate target, and delegation cycles are refused before effect',async t=>{
 let release;const barrier=new Promise(r=>release=r);const f=fixture(t);const original=f.options.prepare;f.d.prepare=async(...args)=>{await barrier;return original(...args)};
 const id=randomUUID(),first=f.d.create('parent','target',{requestId:id,text:'review'});
 await assert.rejects(()=>f.d.create('parent','target',{requestId:id,text:'review'}),{code:'delegation-busy'});release();await first;
 await assert.rejects(()=>f.d.create('parent','target',{requestId:randomUUID(),text:'more'}),{code:'delegation-busy'});
 await assert.rejects(()=>f.d.create('target','parent',{requestId:randomUUID(),text:'loop'}),{code:'delegation-busy'});
 assert.equal(f.counts().dispatches,1);
});
test('partial records survive restart; rotated traces fail closed',async t=>{
 const f=fixture(t),id=await start(f);await f.d.tick();const line=JSON.stringify(answer());fs.appendFileSync(f.file,line.slice(0,10));await f.d.tick();
 assert.equal(f.d.get(id,'parent').outcome,null);fs.appendFileSync(f.file,line.slice(10)+'\n');const resumed=f.create();await resumed.tick();assert.equal(resumed.get(id,'parent').outcome,'completed');
 const f2=fixture(t),id2=await start(f2);fs.renameSync(f2.file,f2.file+'.old');fs.writeFileSync(f2.file,'');await f2.d.tick();assert.equal(f2.d.get(id2,'parent').outcome,'uncertain');
});
for (const phase of ['final','final_answer']) test('Codex '+phase+' needs matched input and same native completion',()=>{
 const e={},expected=hash('exact');const feed=r=>consumeEvidence(e,r,expected,'codex');
 feed({type:'event_msg',payload:{type:'task_started',turn_id:'turn'}});
 feed({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'exact'}]}});
 feed({type:'turn_context',payload:{turn_id:'turn'}});
 feed({type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'intermediate'}]}});
 assert.equal(e.outcome,undefined);
 feed({type:'response_item',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text:'done'}]}});
 feed({type:'event_msg',payload:{type:'task_complete',turn_id:'wrong'}});assert.equal(e.outcome,undefined);
 feed({type:'event_msg',payload:{type:'task_complete',turn_id:'turn'}});assert.equal(e.outcome,'completed');
});
test('foreign source cannot read or cancel a follow-up',async t=>{
 const f=fixture(t),id=await start(f);assert.throws(()=>f.d.get(id,'other'),{code:'not-found'});assert.throws(()=>f.d.cancel(id,'other'),{code:'not-found'});
});

test('Claude bracketed paste is matched as a whole; quoted or mismatched wrappers are not',()=>{
 const expected='[message from parent:] review\n\n[AM delegation 123]';
 for(const [text,match] of [[`\n\n<pasted_content id="0040">\n${expected}\n</pasted_content id="0040">\n`,true],
  [`quoted: ${expected}`,false],[`<pasted_content id="0040">\n${expected}\n</pasted_content id="0041">`,false]]){
  const e={};consumeEvidence(e,input(text),hash(expected),'claude');assert.equal(!!e.matched,match);
 }
});

test('cancellation during an asynchronous parent check cannot be overwritten by notification',async t=>{
 const f=fixture(t),id=await start(f);f.append(answer());f.state.parent='waiting';
 let release,entered;const pending=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
 f.d.state=async sid=>{if(sid==='parent'){entered();await pending;}return f.state[sid]};
 const ticking=f.d.tick();await seen;f.d.cancel(id,'parent');release();await ticking;
 assert.equal(f.counts().notifications,0);assert.equal(f.d.get(id,'parent').state,'cancelled');
});

test('uncertain recovery or mismatched restored settings never becomes an automatic second attempt',async t=>{
 for(const code of ['codex-recovery-uncertain','codex-recovery-review']){
  let count=0;const f=fixture(t,{notify:async()=>{count++;throw Object.assign(Error(),{code})}});
  const id=await start(f);f.append(answer());f.state.parent='unloaded';await f.d.tick();await f.create().tick();
  assert.equal(count,1);assert.match(f.d.get(id,'parent').state,/^notification-(uncertain|review)$/);
 }
});


test('cancellation during target observation or scan stays terminal across restart',async t=>{
 for(const boundary of ['target','scan']){
  const f=fixture(t),id=await start(f);f.state.parent='waiting';
  let release,entered;const pending=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
  if(boundary==='target')f.d.state=async sid=>{if(sid==='target'){entered();await pending;}return f.state[sid]};
  else {const scan=f.d.scan;f.d.scan=async j=>{scan(j);entered();await pending;};}
  const ticking=f.d.tick();await seen;f.d.cancel(id,'parent');release();await ticking;
  assert.equal(f.d.get(id,'parent').state,'cancelled',boundary);
  f.append(answer());await f.create().tick();assert.equal(f.counts().notifications,0,boundary);
 }
});
test('reused Claude child correlates each request and treats a scope update as uncertain, never completed',async t=>{
 const f=fixture(t);f.state.parent='waiting';
 const first=await start(f);f.append(answer('first run'));await f.d.tick();assert.equal(f.d.get(first,'parent').state,'delivered');
 const second=await start(f);await f.d.tick();assert.equal(f.d.get(second,'parent').outcome,null);
 f.append(answer('tool gap','tool_use'));await f.d.tick();assert.equal(f.counts().notifications,1);
 f.append(input('new scope from another input'));f.append(answer('answer to updated scope'));
 await f.d.tick();assert.equal(f.d.get(second,'parent').outcome,'uncertain');assert.equal(f.d.get(second,'parent').reason,'another-user-input');
 assert.equal(f.d.get(second,'parent').state,'delivered');assert.equal(f.counts().notifications,2);
 await f.create().tick();assert.equal(f.counts().notifications,2);
});
test('archiving a parent during observation invalidates callback instead of retrying forever',async t=>{
 const f=fixture(t);const id=await start(f);f.append(answer());f.state.parent='waiting';
 f.options.identity=()=>{throw Object.assign(Error('archived'),{code:'codex-sender-archived'});};
 const restored=f.create();await restored.tick();assert.equal(restored.get(id,'parent').state,'stale');assert.equal(f.counts().notifications,0);
});

const sharedOf=s=>s.shared===true;
test('notify allows shared Codex to Claude, Codex, or Cursor, and Claude to Cursor',()=>{
 const claude={id:'c',cli:'claude'},cursor={id:'u',cli:'cursor'},codex={id:'x',cli:'codex',shared:true},local={id:'y',cli:'codex'};
 assert.equal(delegationSupported(codex,claude,sharedOf),true);
 assert.equal(delegationSupported(codex,{...codex,id:'z'},sharedOf),true);
 assert.equal(delegationSupported(codex,cursor,sharedOf),true);
 assert.equal(delegationSupported(claude,cursor,sharedOf),true);
 assert.equal(delegationSupported(claude,claude,sharedOf),false);
 assert.equal(delegationSupported(claude,codex,sharedOf),false);
 assert.equal(delegationSupported(cursor,cursor,sharedOf),false);
 assert.equal(delegationSupported(local,cursor,sharedOf),false);
 assert.equal(delegationSupported(null,cursor,sharedOf),false);
});

const cursorUser=text=>({role:'user',message:{content:[{type:'text',text:`<timestamp>Tuesday, Nov 3, 2026, 5:44 PM (UTC)</timestamp>\n<user_query>\n${text}\n</user_query>`}]}});
const cursorAssistant=text=>({role:'assistant',message:{content:[{type:'text',text}]}});
function cursorHarness(t){
 const f=fixture(t);let payload='',dispatches=0;
 const write=records=>{
  const next=f.file+'.next';
  fs.writeFileSync(next,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  fs.renameSync(next,f.file);
 };
 f.d.prepare=async()=>({cli:'cursor',expectedText:'placeholder',cursor:traceCheckpoint(f.file)});
 f.d.dispatch=async(j,text)=>{dispatches++;payload=text;j.expectedHash=hash(text);write([cursorUser(text)]);};
 return {f,write,payload:()=>payload,dispatches:()=>dispatches};
}

test('Cursor user_query matches the dispatched text; a quote or an earlier turn_ended does not',()=>{
 const prompt='[message from parent:] review\n\n[AM delegation 123]',expected=hash(prompt),e={};
 const wrapped=`<timestamp>Tuesday, Nov 3, 2026, 5:44 PM (UTC)</timestamp>\n<user_query>\n${prompt}\n</user_query>`;
 consumeEvidence(e,{type:'turn_ended',status:'success'},expected,'cursor');
 consumeEvidence(e,{role:'assistant',message:{content:[{type:'text',text:'stale'}]}},expected,'cursor');
 assert.equal(e.matched,undefined);assert.equal(e.outcome,undefined);
 consumeEvidence(e,{role:'user',message:{content:[{type:'text',text:`quoted: ${prompt}`}]}},expected,'cursor');
 assert.equal(!!e.matched,false);
 consumeEvidence(e,{role:'user',message:{content:[{type:'text',text:wrapped}]}},expected,'cursor');
 assert.equal(e.matched,true);
 consumeEvidence(e,{role:'assistant',message:{content:[{type:'text',text:'ready'},{type:'tool_use',name:'Shell',input:{command:'ls'}}]}},expected,'cursor');
 assert.equal(e.outcome,undefined);
 consumeEvidence(e,{type:'turn_ended',status:'success'},expected,'cursor');
 assert.equal(e.outcome,'completed');assert.equal(e.reason,'harness-turn-ended');assert.equal(e.answer,'ready');
});

test('Cursor rewrite completes on turn_ended; displacement, failure, and a vanished turn do not',async t=>{
 const c=cursorHarness(t),id=await start(c.f);
 await c.f.d.tick();assert.equal(c.f.d.get(id,'parent').outcome,null);
 c.write([cursorUser(c.payload()),cursorAssistant('working'),{role:'assistant',message:{content:[{type:'tool_use',name:'Shell',input:{command:'ls'}}]}}]);
 await c.f.d.tick();assert.equal(c.f.d.get(id,'parent').outcome,null,'tool text is not a final');
 c.write([
  cursorUser('older'),cursorAssistant('OLD'),{type:'turn_ended',status:'success'},
  cursorUser(c.payload()),cursorAssistant('The review is done'),{type:'turn_ended',status:'success'},
  cursorUser('after'),cursorAssistant('later'),{type:'turn_ended',status:'success'},
 ]);
 c.f.state.parent='waiting';await c.f.d.tick();
 const done=c.f.d.get(id,'parent');
 assert.equal(done.outcome,'completed');assert.equal(done.reason,'harness-turn-ended');assert.equal(done.result,'The review is done');
 assert.equal(done.state,'delivered');assert.equal(c.f.counts().notifications,1);

 const displaced=cursorHarness(t),id2=await start(displaced.f);
 displaced.write([cursorUser(displaced.payload()),cursorUser('new scope'),cursorAssistant('answer to updated scope'),{type:'turn_ended',status:'success'}]);
 await displaced.f.d.tick();
 assert.equal(displaced.f.d.get(id2,'parent').outcome,'uncertain');
 assert.equal(displaced.f.d.get(id2,'parent').reason,'another-user-input');

 const noText=cursorHarness(t),id3=await start(noText.f);
 noText.write([cursorUser(noText.payload()),{role:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{path:'/work/README.md'}}]}},{type:'turn_ended',status:'success'}]);
 await noText.f.d.tick();
 assert.equal(noText.f.d.get(id3,'parent').outcome,'uncertain');assert.equal(noText.f.d.get(id3,'parent').reason,'no-final-result');

 const failed=cursorHarness(t),id4=await start(failed.f);
 failed.write([cursorUser(failed.payload()),cursorAssistant('partial'),{type:'turn_ended',status:'error'}]);
 await failed.f.d.tick();
 assert.equal(failed.f.d.get(id4,'parent').outcome,'failed');assert.equal(failed.f.d.get(id4,'parent').reason,'harness-turn-failed');

 const unmarked=cursorHarness(t),id5=await start(unmarked.f);
 unmarked.write([cursorUser(unmarked.payload()),cursorAssistant('done'),{type:'turn_ended'}]);
 await unmarked.f.d.tick();
 assert.equal(unmarked.f.d.get(id5,'parent').outcome,'completed');assert.equal(unmarked.f.d.get(id5,'parent').reason,'harness-turn-ended');

 const blocked=cursorHarness(t),id6=await start(blocked.f);
 blocked.f.state.target='input-required';await blocked.f.d.tick();
 assert.equal(blocked.f.d.get(id6,'parent').outcome,'blocked');assert.equal(blocked.f.d.get(id6,'parent').reason,'input-required');

 const stopped=cursorHarness(t),id7=await start(stopped.f);
 stopped.f.state.target='stopped';await stopped.f.d.tick();
 assert.equal(stopped.f.d.get(id7,'parent').outcome,'failed');assert.equal(stopped.f.d.get(id7,'parent').reason,'process-stopped-without-result');

 const vanished=cursorHarness(t),id8=await start(vanished.f);
 await vanished.f.d.tick();assert.equal(vanished.f.d.get(id8,'parent').outcome,null);
 vanished.write([cursorUser('something else'),cursorAssistant('nope'),{type:'turn_ended',status:'success'}]);
 await vanished.f.d.tick();
 assert.equal(vanished.f.d.get(id8,'parent').outcome,'uncertain');assert.equal(vanished.f.d.get(id8,'parent').reason,'trace-rewritten');
});

test('Cursor retry stays one dispatch, a torn rewrite is not final, and the tail window sees the new turn',async t=>{
 const c=cursorHarness(t),id=randomUUID();
 const first=await c.f.d.create('parent','target',{requestId:id,text:'review'});
 const second=await c.f.d.create('parent','target',{requestId:id,text:'review'});
 assert.equal(first.id,second.id);assert.equal(c.dispatches(),1);
 await assert.rejects(()=>c.f.d.create('parent','target',{requestId:id,text:'changed'}),{code:'delegation-conflict'});

 const torn=cursorHarness(t),id2=await start(torn.f);
 await torn.f.d.tick();
 const body=[cursorUser(torn.payload()),cursorAssistant('done'),{type:'turn_ended',status:'success'}].map(r=>JSON.stringify(r)).join('\n');
 fs.writeFileSync(torn.f.file,body);
 await torn.f.d.tick();assert.equal(torn.f.d.get(id2,'parent').outcome,null);
 fs.appendFileSync(torn.f.file,'\n');await torn.f.d.tick();
 assert.equal(torn.f.d.get(id2,'parent').outcome,'completed');assert.equal(torn.f.d.get(id2,'parent').result,'done');

 const tail=cursorHarness(t),id3=await start(tail.f);
 const prefix=[cursorUser('old'),cursorAssistant('OLD'),{type:'turn_ended',status:'success'}].map(r=>JSON.stringify(r)).join('\n')+'\n';
 const suffix=[cursorUser(tail.payload()),cursorAssistant('tail answer'),{type:'turn_ended',status:'success'}].map(r=>JSON.stringify(r)).join('\n')+'\n';
 fs.writeFileSync(tail.f.file,prefix+suffix);
 tail.f.d.jobs.get(id3).scanBytes=Buffer.byteLength(suffix);
 await tail.f.d.tick();
 assert.equal(tail.f.d.get(id3,'parent').outcome,'completed');assert.equal(tail.f.d.get(id3,'parent').result,'tail answer');
});

test('a Claude parent callback is pasted once and a typed failure is not repeated',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-notify-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let calls=0;
 const f=fixture(t,{notify:async job=>notifyClaudeOnce(root,job.callbackId,async()=>{calls++;return {ok:true,queued:true};})});
 const id=await start(f);f.append(answer());f.state.parent='waiting';
 await f.d.tick();assert.equal(calls,1);assert.equal(f.d.get(id,'parent').state,'delivered');
 await f.d.tick();assert.equal(calls,1);assert.equal(f.d.get(id,'parent').notification.repeated,undefined);

 let typed=0;
 const f2=fixture(t,{notify:async job=>notifyClaudeOnce(root,job.callbackId,async()=>{typed++;throw Object.assign(Error('pasted'),{typed:true});})});
 const id2=await start(f2);f2.append(answer());f2.state.parent='waiting';
 await f2.d.tick();await f2.d.tick();
 assert.equal(typed,1);assert.equal(f2.d.get(id2,'parent').state,'notification-uncertain');

 let early=0;
 const f3=fixture(t,{notify:async job=>notifyClaudeOnce(root,job.callbackId,async()=>{early++;if(early===1)throw Object.assign(Error('not yet'),{code:'input-not-ready'});return {ok:true};})});
 const id3=await start(f3);f3.append(answer());f3.state.parent='waiting';
 await f3.d.tick();assert.equal(f3.d.get(id3,'parent').state,'ready');
 await f3.d.tick();assert.equal(early,2);assert.equal(f3.d.get(id3,'parent').state,'delivered');
});
