// Checks buildLabel: what Settings shows for the commit this build came from.
import assert from 'node:assert/strict';
import { buildLabel } from '../src/lib/buildLabel.ts';

const SHA = '1233c80ea949ed58f5459db3d4b3d105096c4a87';

assert.deepEqual(buildLabel({ sha: SHA, ref: 'main', source: 'stamp' }),
  { text: '1233c80 · main', title: SHA });
assert.deepEqual(buildLabel({ sha: SHA, ref: null, source: 'git' }),
  { text: '1233c80', title: SHA });

// HF's own commit of the Space repo is not a commit of agent-manager; say so.
const space = buildLabel({ sha: SHA, ref: null, source: 'space-commit' });
assert.equal(space.text, '1233c80 · Space commit');
assert.match(space.title, /Space repo/);

assert.deepEqual(buildLabel(null), { text: 'unknown', title: 'This build carries no commit stamp' });
assert.deepEqual(buildLabel(undefined), buildLabel(null));

// A dev preview runs a PR build, not the image the stamp describes.
const preview = { kind: 'prs', label: '#12 abcdef0 + #14 1234567', id: 'r1', prs: [] };
assert.deepEqual(buildLabel({ sha: SHA, ref: 'main', source: 'stamp' }, preview),
  { text: 'dev preview: #12 abcdef0 + #14 1234567', title: 'A dev-preview build of open PRs, not the image' });
assert.deepEqual(buildLabel({ sha: SHA, ref: 'main', source: 'stamp' }, { kind: 'main', label: 'main', id: 'image', prs: [] }),
  buildLabel({ sha: SHA, ref: 'main', source: 'stamp' }), 'the image itself is just the stamp');

console.log('buildLabel: ok');
