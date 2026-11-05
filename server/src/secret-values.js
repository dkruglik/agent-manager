import { MIN_KNOWN_CREDENTIAL_LENGTH } from './audit-credentials.js';

// The values of the secrets a process holds, for the credential filter of what goes to a chat: the Slack
// tokens, the Hugging Face token and the provider keys the CLIs read (the `secrets` of the catalog, plus the
// alternative names isConfigured accepts), and any other variable named like a secret.
const NAMED = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HF_API_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'GOOGLE_API_KEY'];
// Names that end in TOKEN, SECRET, PASSWORD, PASSWD or APIKEY, or in the standalone word KEY after an underscore
// (OPENAI_KEY, AWS_SECRET_ACCESS_KEY). KEYBOARD, MONKEY and KEY_COUNT do not match.
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY)$|(?:^|_)KEY$/i;

/** @param clis the CLI catalog (`secrets` lists names). Values under the filter's minimum length are left out. */
export function secretValues(clis, env) {
  const names = new Set([...NAMED, ...clis.flatMap((c) => c.secrets || []), ...Object.keys(env).filter((n) => SECRET_NAME.test(n))]);
  return [...names].map((n) => env[n]).filter((v) => typeof v === 'string' && v.trim().length >= MIN_KNOWN_CREDENTIAL_LENGTH);
}
