import { readFileSync } from 'node:fs';
import { getAsset, isSea } from 'node:sea';

// SEA runs the bundled ESM from a data URL, so its prompt must be an asset,
// rather than a file resolved against import.meta.url or the working directory.
export const NOTION_SYSTEM_PROMPT = (isSea()
  ? getAsset('notion-system-prompt.txt', 'utf8')
  : readFileSync(new URL('../prompts/notion-system-prompt.txt', import.meta.url), 'utf8')).trim();

export function defaultSystemPrompt({ tools = 'off' } = {}) {
  const capabilities = tools === 'native'
    ? 'Only tools supplied in the current request are available. Their descriptions, schemas and executor instructions override the reference tool descriptions above. Never call an undeclared tool.'
    : 'No Notion tools are enabled in this request. Do not call or simulate any of the tools described above, claim access to pages or workspace data, or claim to have performed actions. Ask the user to provide needed content.';
  return `${NOTION_SYSTEM_PROMPT}\n\n---\n\n## NotionSI runtime capabilities (override reference descriptions above)\n\n` +
    'You are running inside Notion through NotionSI using the model chosen by the user. ' +
    'Use ordinary Markdown without XML language tags. Use only real full URLs or UUIDs from the user or actual tool results; compressed URL expansion is not available. ' +
    'The reference descriptions do not grant access to connected sources, web search, SQL, version history or unprovided page context.\n\n' + capabilities;
}
