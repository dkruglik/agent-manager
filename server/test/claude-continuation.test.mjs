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

const mk = (id, sessionUuid) => ({ id, cli: 'claude', path: 'proj', sessionUuid });
fs.writeFileSync(path.join(process.env.DATA_DIR, 'sessions.json'), JSON.stringify([
  mk('s-a', A), mk('s-b', B), mk('s-x', X), mk('s-z', Z), mk('s-n', N),
]));

const store = await import('../src/sessions.js');
store.init();
const traces = await import('../src/traces.js');
const { continuedIn, followContinuation } = await import('../src/claude-continuation.js');

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
  check('follow terminates on a cycle', typeof await followContinuation(fileOf(X), [fileOf(X), fileOf(Y)]), 'string');

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
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
