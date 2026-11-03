// Claude `continued-in` transcript handoff: when a transcript ends with a
// continued-in line, digestFor / traceLocation / the bulk pass follow it to the
// successor file. Run with:  node test/claude-continuation.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-continuation-'));
process.env.HOME = path.join(TMP, 'home');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.CODEX_HOME = path.join(TMP, 'no-codex');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const PROJ = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-work-proj');
fs.mkdirSync(PROJ, { recursive: true });

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = Object.is(got, want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const fileOf = (id) => path.join(PROJ, `${id}.jsonl`);
const line = (o) => JSON.stringify(o);
const turn = (q, a, ts) => [
  line({ type: 'user', cwd: '/work/proj', timestamp: ts, message: { role: 'user', content: q } }),
  line({ type: 'assistant', cwd: '/work/proj', timestamp: ts, message: { id: `m-${a}`, role: 'assistant', content: [{ type: 'text', text: a }] } }),
];
const handoff = (from, to, ts) => line({ type: 'continued-in', timestamp: ts, sessionId: from, continuedInSessionId: to });
const write = (id, lines) => fs.writeFileSync(fileOf(id), `${lines.join('\n')}\n`);

const [A, B, C, X, Y, Z, N, M, OK, BAD] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(uuid);
const [P, Q, R, U, V, E, F, H1, H2, H3, H4] = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].map(uuid);
// older copy of E in a project dir that sorts first; the newer one is continued to F
const PROJ_OLD = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-work-aaa');
fs.mkdirSync(PROJ_OLD, { recursive: true });
// a: A -> B (also covers the bulk pass)
write(A, [...turn('q', 'OLD ANSWER', '2026-11-02T10:00:00.000Z'), handoff(A, B, '2026-11-02T16:12:06.081Z')]);
write(B, [...turn('q2', 'MID ANSWER', '2026-11-02T17:00:00.000Z'), handoff(B, C, '2026-11-02T17:30:00.000Z')]);
write(C, turn('q3', 'NEW ANSWER', '2026-11-02T18:00:00.000Z'));
// c: cycle X -> Y -> X
write(X, [...turn('q', 'CYCLE X', '2026-11-02T10:00:00.000Z'), handoff(X, Y, '2026-11-02T11:00:00.000Z')]);
write(Y, [...turn('q', 'CYCLE Y', '2026-11-02T12:00:00.000Z'), handoff(Y, X, '2026-11-02T13:00:00.000Z')]);
// d: successor file is missing
write(Z, [...turn('q', 'OLD ANSWER', '2026-11-02T10:00:00.000Z'), handoff(Z, uuid(99), '2026-11-02T11:00:00.000Z')]);
// e: normal transcript
write(N, turn('q', 'PLAIN ANSWER', '2026-11-02T10:00:00.000Z'));
// f: unit inputs
write(BAD, [...turn('q', 'x', '2026-11-02T10:00:00.000Z'), handoff(BAD, 'not-a-uuid', '2026-11-02T11:00:00.000Z')]);
write(M, [handoff(M, OK, '2026-11-02T11:00:00.000Z'), ...turn('q', 'later', '2026-11-02T12:00:00.000Z')]);

// g: P -> Q -> R where the middle hop is the newest by timestamp
write(P, [...turn('q', 'P ANSWER', '2026-11-02T10:00:00.000Z'), handoff(P, Q, '2026-11-02T11:00:00.000Z')]);
write(Q, [...turn('q', 'Q ANSWER', '2026-11-02T19:00:00.000Z'), handoff(Q, R, '2026-11-02T19:30:00.000Z')]);
write(R, turn('q', 'R ANSWER', '2026-11-02T12:00:00.000Z'));
// h: successor exists but cannot be read
write(V, [...turn('q', 'STALE V', '2026-11-02T10:00:00.000Z'), handoff(V, U, '2026-11-02T11:00:00.000Z')]);
write(U, turn('q', 'UNREADABLE U', '2026-11-02T12:00:00.000Z'));
fs.chmodSync(fileOf(U), 0o000);
// i: two copies of E, the newer one continued to F
fs.writeFileSync(path.join(PROJ_OLD, `${E}.jsonl`), `${turn('q', 'OLD COPY E', '2026-11-02T09:00:00.000Z').join('\n')}\n`);
write(E, [...turn('q', 'NEW COPY E', '2026-11-02T10:00:00.000Z'), handoff(E, F, '2026-11-02T11:00:00.000Z')]);
write(F, turn('q', 'F ANSWER', '2026-11-02T12:00:00.000Z'));
fs.utimesSync(path.join(PROJ_OLD, `${E}.jsonl`), new Date('2026-01-01'), new Date('2026-01-01'));
// j: four-file chain for maxHops
write(H1, [handoff(H1, H2, '2026-11-02T11:00:00.000Z')]);
write(H2, [handoff(H2, H3, '2026-11-02T11:00:00.000Z')]);
write(H3, [handoff(H3, H4, '2026-11-02T11:00:00.000Z')]);
write(H4, turn('q', 'END', '2026-11-02T12:00:00.000Z'));

const mk = (id, sessionUuid) => ({ id, cli: 'claude', path: 'proj', sessionUuid });
fs.writeFileSync(path.join(process.env.DATA_DIR, 'sessions.json'), JSON.stringify([
  mk('s-a', A), mk('s-b', B), mk('s-x', X), mk('s-z', Z), mk('s-n', N),
  mk('s-p', P), mk('s-v', V), mk('s-e', E),
]));

const store = await import('../src/sessions.js');
store.init();
const traces = await import('../src/traces.js');
const share = await import('../src/share.js');
const { continuedIn, followContinuation, continuationChain } = await import('../src/claude-continuation.js');

try {
  console.log('\na: pinned transcript continued in another file');
  const d = await traces.digestFor(mk('s-a', A));
  check('digestFor reads the live successor', d && d.lastAssistantText, 'NEW ANSWER');
  const loc = await traces.traceLocation(mk('s-a', A));
  check('traceLocation points at the final successor', loc && loc.path, fileOf(C));
  const bulk = await traces.traceDigests({ fresh: true });
  check('bulk pass attributes the successor to the pinned session', bulk.get ? bulk.get('s-a')?.lastAssistantText : bulk['s-a']?.lastAssistantText, 'NEW ANSWER');

  console.log('\nb: two-hop chain');
  const db = await traces.digestFor(mk('s-b', B));
  check('B reaches C', db && db.lastAssistantText, 'NEW ANSWER');

  console.log('\nc: cycle terminates');
  const dx = await traces.digestFor(mk('s-x', X));
  check('cycle returns a digest', !!dx, true);
  check('follow stops at the last new file of a cycle', await followContinuation(fileOf(X), [fileOf(X), fileOf(Y)]), fileOf(Y));

  console.log('\nd: successor file missing');
  const dz = await traces.digestFor(mk('s-z', Z));
  check('stays on the pinned file', dz && dz.lastAssistantText, 'OLD ANSWER');

  console.log('\ne: no continuation');
  const dn = await traces.digestFor(mk('s-n', N));
  check('unchanged', dn && dn.lastAssistantText, 'PLAIN ANSWER');
  check('traceLocation unchanged', (await traces.traceLocation(mk('s-n', N))).path, fileOf(N));

  console.log('\nf: continuedIn unit');
  check('returns the id of a final continued-in line', await continuedIn(fileOf(A)), B);
  check('null for a non-UUID id', await continuedIn(fileOf(BAD)), null);
  check('null when the last line is not continued-in', await continuedIn(fileOf(M)), null);
  check('null for a missing file', await continuedIn(fileOf(uuid(98))), null);
  check('followContinuation returns input when none', await followContinuation(fileOf(N), [fileOf(N)]), fileOf(N));

  console.log('\ng: findTranscript follows the chain');
  check('pinned on A resolves to C', await share.findTranscript(mk('s-a', A)), fileOf(C));
  check('pinned on E resolves to F (newest copy)', await share.findTranscript(mk('s-e', E)), fileOf(F));
  check('traceLocation follows from the newest pinned file', (await traces.traceLocation(mk('s-e', E))).path, fileOf(F));

  console.log('\nh: continuationChain and attribution of intermediate hops');
  const all = [A, B, C].map(fileOf);
  check('chain lists every hop', (await continuationChain(fileOf(A), all)).join(','), all.join(','));
  const dg = await traces.traceDigests({ fresh: true });
  check('middle hop Q is attributed to the pinned session', (dg.get ? dg.get('s-p') : dg['s-p'])?.lastAssistantText, 'Q ANSWER');

  console.log('\ni: successor exists but cannot be parsed');
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let du;
  try { du = await traces.digestFor(mk('s-v', V)); } finally { console.warn = origWarn; }
  check('no stale digest of the sealed file', du, null);
  check('one warning naming the successor', warns.filter((w) => w.includes('[traces]') && w.includes(`${U}.jsonl`)).length, 1);

  console.log('\nj: continuedIn / pickSuccessor edge cases');
  const dirAsFile = path.join(PROJ, `${uuid(50)}.jsonl`);
  fs.mkdirSync(dirAsFile);
  const w2 = [];
  console.warn = (...a) => w2.push(a.join(' '));
  try {
    check('unreadable file is not continued', await continuedIn(dirAsFile), null);
    const nWarn = w2.length;
    await continuedIn(fileOf(uuid(98)));
    check('missing file does not warn', w2.length, nWarn);
    await continuedIn(fileOf(BAD));
    check('well-formed non-handoff does not warn', w2.length, nWarn);
  } finally { console.warn = origWarn; }
  check('unreadable file warned once', w2.length, 1);
  const ghost = fileOf(uuid(97));
  write(uuid(96), [handoff(uuid(96), uuid(97), '2026-11-02T11:00:00.000Z')]);
  check('successor that cannot be stat-ed is skipped', await followContinuation(fileOf(uuid(96)), [fileOf(uuid(96)), ghost]), fileOf(uuid(96)));

  console.log('\nk: cycle and maxHops');
  check('X -> Y -> X returns Y exactly', await followContinuation(fileOf(X), [fileOf(X), fileOf(Y)]), fileOf(Y));
  const hs = [H1, H2, H3, H4].map(fileOf);
  check('maxHops 2 stops at the third file', await followContinuation(hs[0], hs, { maxHops: 2 }), hs[2]);
  check('default maxHops reaches the end', await followContinuation(hs[0], hs), hs[3]);
} finally {
  try { fs.chmodSync(fileOf(U), 0o600); } catch { /* removed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
