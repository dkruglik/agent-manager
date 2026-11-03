import { covers } from '../read-marks.js';

// What the bridge sees of a session's latest reply: an id that changes with
// each new output version, whether the operator's read mark already covers it,
// and the text for a finished card. `out` is the latest output (or null),
// `digest` the conversation digest, `mark` the session's read mark.
export function finishedDigest(out, digest, mark) {
  if (!out) return null;
  return { id: `${out.src}:${out.seq}:${out.hash}`, read: covers(mark, out), text: digest.lastAssistantMd || digest.lastAssistantText };
}
