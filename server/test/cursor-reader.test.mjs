// The Cursor CLI transcript reader: located by the pane's chat id (never by the
// lossy project slug), normalized for the trace panel, and digested.
// Fixture: fixtures/cursor-transcript.jsonl (scrubbed, shapes from Cursor 2026.10.22).
// Run with: node test/cursor-reader.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-reader-'));
process.env.HOME = path.join(TMP, 'home');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'no-claude');
process.env.CODEX_HOME = path.join(TMP, 'no-codex');
process.env.AM_TRACE_WORKERS = '0';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = Object.is(got, want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};

const ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const FIX = fs.readFileSync(new URL('./fixtures/cursor-transcript.jsonl', import.meta.url), 'utf8');
const dirOf = (id, slug = 'some-lossy-slug') => path.join(process.env.HOME, '.cursor', 'projects', slug, 'agent-transcripts', id);
const put = (id, text, slug) => {
  const d = dirOf(id, slug);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${id}.jsonl`), text);
  return path.join(d, `${id}.jsonl`);
};
const FILE = put(ID, FIX);
// A subagent transcript beside the main one must never be picked.
fs.mkdirSync(path.join(dirOf(ID), 'subagents'), { recursive: true });
fs.writeFileSync(path.join(dirOf(ID), 'subagents', `${OTHER}.jsonl`), '{"role":"user","message":{"content":[{"type":"text","text":"SUBAGENT"}]}}\n');

const traces = await import('../src/traces.js');
const share = await import('../src/share.js');
const s = { id: 'am-c', cli: 'cursor', sessionUuid: ID };
const read = (sess, opts = { offset: 0, limit: 100 }) => traces.readTrace(sess, opts);

console.log('reader');
const t = await read(s);
const users = t.turns.filter((m) => m.role === 'user');
check('two prompts', users.length, 2);
check('wrappers stripped', users[0].blocks[0].text, 'Reply with exactly the word PONG and nothing else.');
check('no timestamp tag left', users.some((m) => /<timestamp>|<user_query>/.test(m.blocks[0].text)), false);
check('ts parsed', users[0].ts, Date.UTC(2026, 10, 3, 17, 44));
check('second ts parsed', users[1].ts, Date.UTC(2026, 10, 3, 17, 50));
check('assistant PONG', t.turns[1].blocks[0].text, 'PONG');
const uses = t.turns.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_use');
check('four tool calls', uses.length, 4);
check('Shell shows the command', uses.find((b) => b.name === 'Shell')?.text, 'ls -la');
check('Read shows the path', uses.find((b) => b.name === 'Read')?.text, '/work/demo/README.md');
check('Grep shows the pattern', /TODO/.test(uses.find((b) => b.name === 'Grep')?.text), true);
check('Glob shows the pattern', uses.find((b) => b.name === 'Glob')?.text, '**/*.md');
check('subagent text not shown', JSON.stringify(t).includes('SUBAGENT'), false);
check('finished turn is waiting', t.activity, 'waiting');
check('harness label', t.harnessLabel, 'Cursor CLI');

console.log('working while a turn runs');
const lines = FIX.trimEnd().split('\n');
fs.writeFileSync(FILE, lines.slice(0, -1).join('\n') + '\n');
check('no turn_ended = working', (await read(s)).activity, 'working');
fs.writeFileSync(FILE, FIX);

console.log('location by id only');
check('path found by id', await share.cursorTranscriptPath(ID), FILE);
check('unknown id', await share.cursorTranscriptPath(OTHER), null);
for (const bad of ['../../etc', '', undefined, `${ID}/../x`, 'not-a-uuid']) {
  check(`malformed id ${JSON.stringify(bad)} finds nothing`, await share.cursorTranscriptPath(bad), null);
}
let err = null;
try { await read({ id: 'am-bad', cli: 'cursor', sessionUuid: '../../etc' }); } catch (e) { err = e.code; }
check('malformed sessionUuid: no-trace, no throw past it', err, 'no-trace');
check('malformed sessionUuid: digest null', await traces.digestFor({ id: 'am-bad', cli: 'cursor', sessionUuid: '../../etc' }), null);
check('malformed sessionUuid: location null', await traces.traceLocation({ id: 'am-bad', cli: 'cursor', sessionUuid: '../../etc' }), null);
const gone = '11111111-2222-4333-8444-555555555555';
const goneFile = put(gone, FIX, 'other-slug');
check('found under another slug', await share.cursorTranscriptPath(gone), goneFile);
fs.rmSync(path.dirname(goneFile), { recursive: true });
check('memoized path re-checked after removal', await share.cursorTranscriptPath(gone), null);

console.log('digest, location, findTrace');
const dg = await traces.digestFor(s);
check('digest last prompt', dg?.lastPromptText, 'List the files and show README.md.');
check('digest last reply', dg?.lastAssistantText, 'The folder has README.md and src/. README.md says: Demo project.');
check('digest counts tools', dg?.sinceToolCalls, 4);
check('digest not running at turn_ended', dg?.running, false);
check('digest prompt ts', dg?.lastPromptTs, Date.UTC(2026, 10, 3, 17, 50));
check('reply is dated with the prompt it answers', dg?.lastAssistantTs, Date.UTC(2026, 10, 3, 17, 50));
check('answer has a time', dg?.lastAnswerTs > 0, true);
check('reply is not older than the prompt', dg?.lastAssistantTs >= dg?.lastPromptTs, true);
fs.writeFileSync(FILE, lines.slice(0, -1).join('\n') + '\n');
check('digest running mid-turn', (await traces.digestFor(s))?.running, true);
fs.writeFileSync(FILE, FIX);
check('traceLocation', (await traces.traceLocation(s))?.path, FILE);
check('findTrace returns the file', (await share.findTrace(s, []))?.src, FILE);
check('not shareable', share.SHAREABLE_CLIS.includes('cursor'), false);
check('no id, no trace', await share.findTrace({ id: 'x', cli: 'cursor' }, []), null);

console.log('bulk pass (Overview)');
const store = await import('../src/sessions.js');
store.init();
const bulkS = store.create({ name: 'cur-bulk', cli: 'cursor', path: 'proj-bulk' });
const bulkId = store.update(bulkS.id, { sessionUuid: ID }).id;
const bulk = await traces.traceDigests({ fresh: true });
const bd = bulk.get ? bulk.get(bulkId) : bulk[bulkId];
check('bulk digest has the last reply', bd?.lastAssistantText, 'The folder has README.md and src/. README.md says: Demo project.');
check('bulk digest has the last prompt', bd?.lastPromptText, 'List the files and show README.md.');
check('bulk digest reply has a time', bd?.lastAssistantTs > 0, true);

console.log('a reply is never dated with an older prompt');
{
  const user = (stamp) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `${stamp}<user_query>\nq\n</user_query>` }] } });
  const reply = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } });
  const utc = '<timestamp>Tuesday, Nov 3, 2026, 5:44 PM (UTC)</timestamp>\n';
  const lastTs = async (...rows) => {
    const id = '5e5e5e5e-1111-4222-8333-444444444444';
    const f = put(id, rows.join('\n') + '\n', 'ts-slug');
    const d = await traces.digestFor({ id: 'am-ts', cli: 'cursor', sessionUuid: id });
    fs.rmSync(path.dirname(f), { recursive: true });
    return d?.lastAssistantTs;
  };
  check('control: reply after a stamped prompt is dated', await lastTs(user(utc), reply), Date.UTC(2026, 10, 3, 17, 44));
  check('no stamp on the newer prompt: not dated', await lastTs(user(utc), reply, user(''), reply), 0);
  check('unparsable stamp on the newer prompt: not dated',
    await lastTs(user(utc), reply, user('<timestamp>Tuesday, Nov 3, 2026, 5:50 PM (PST)</timestamp>\n'), reply), 0);
}

console.log('transcript lookup errors');
{
  const fsp = (await import('node:fs/promises')).default; // the object share.js calls
  const realStat = fsp.stat;
  const errs = [];
  const origErr = console.error;
  const failing = new Map(); // path -> error code
  fsp.stat = (p, ...rest) => {
    const code = failing.get(String(p));
    if (!code) return realStat.call(fsp, p, ...rest);
    return Promise.reject(Object.assign(new Error(`${code}: stat failed`), { code }));
  };
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const id = '7a7a7a7a-1111-4222-8333-444444444444';
    const file = put(id, FIX, 'lookup-slug');
    check('found and cached', await share.cursorTranscriptPath(id), file);
    check('an ordinary miss logs nothing', errs.length, 0);
    for (const code of ['EIO', 'EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY']) {
      failing.set(file, code);
      check(`${code} on the cached path: same path kept`, await share.cursorTranscriptPath(id), file);
    }
    check('transient failures logged once per code', errs.filter((m) => m.includes('[cursor]')).length, 5);
    check('the log line names the chat id', errs.every((m) => m.includes(id)), true);
    check('the log line carries the error message', errs.some((m) => m.includes('EIO: stat failed')), true);
    errs.length = 0;
    await share.cursorTranscriptPath(id); // EBUSY again, same path
    check('same code and path again: quiet', errs.length, 0);
    failing.set(file, 'EACCES');
    check('EACCES on the cached path: cache dropped, rescan, none found', await share.cursorTranscriptPath(id), null);
    check('EACCES logged', errs.filter((m) => m.includes('EACCES')).length >= 1, true);
    // The rescan stat'd the same path again with EACCES: still only one line for (EACCES, path).
    check('EACCES logged once for its path', errs.filter((m) => m.includes('EACCES') && m.includes(file)).length, 1);
    failing.clear();
    check('after recovery the path is found again', await share.cursorTranscriptPath(id), file);
    failing.set(file, 'EIO');
    errs.length = 0;
    check('EIO again on the same path: quiet (already seen)', (await share.cursorTranscriptPath(id), errs.length), 0);
    // A different path with the same code is a new line.
    const id2 = '8b8b8b8b-1111-4222-8333-444444444444';
    const file2 = put(id2, FIX, 'lookup-slug-2');
    await share.cursorTranscriptPath(id2);
    failing.set(file2, 'EIO');
    await share.cursorTranscriptPath(id2);
    check('same code on another path: logged', errs.filter((m) => m.includes(file2)).length, 1);
    failing.clear();
    errs.length = 0;
    fs.rmSync(path.dirname(file), { recursive: true });
    check('deleted file (ENOENT): null', await share.cursorTranscriptPath(id), null);
    check('deleted file: quiet', errs.length, 0);
  } finally {
    fsp.stat = realStat;
    console.error = origErr;
  }
}

console.log('unreadable transcript root');
{
  const errs = [];
  const origErr = console.error;
  const home = process.env.HOME;
  const root = path.join(TMP, 'home2');
  const proj = path.join(root, '.cursor', 'projects');
  fs.mkdirSync(proj, { recursive: true });
  const isRoot = process.getuid?.() === 0;
  if (isRoot) console.log('  SKIP  running as root: chmod 000 does not block reads');
  else {
    fs.chmodSync(proj, 0o000);
    process.env.HOME = root;
    console.error = (...a) => errs.push(a.join(' '));
    let r, threw = null;
    const id3 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    try { r = await share.cursorTranscriptPath(id3); await share.cursorTranscriptPath(id3); } catch (e) { threw = e; }
    console.error = origErr;
    process.env.HOME = home;
    fs.chmodSync(proj, 0o755);
    check('unreadable root: no throw', threw, null);
    check('unreadable root: null', r, null);
    check('unreadable root: logged once per code', errs.filter((m) => m.includes('[cursor]') && m.includes('EACCES')).length, 1);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
