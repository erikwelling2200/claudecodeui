import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClaudeSdkEnv, mapCliOptionsToSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// Claude Code turns the Artifact tools off for SDK-driven sessions unless
// CLAUDE_CODE_ARTIFACT is set, so a UI session would lose them mid-conversation.
test('SDK sessions opt into the Artifact tools by default', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_ARTIFACT, '1');
});

test('a host CLAUDE_CODE_ARTIFACT value wins over the default', () => {
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ARTIFACT: '0' }).CLAUDE_CODE_ARTIFACT, '0');
});

test('SDK sessions get the todo tools, no auto-updater and the 1-hour prompt cache by default', () => {
  const env = buildClaudeSdkEnv({});
  assert.equal(env.CLAUDE_CODE_ENABLE_TODO_TOOLS, '1');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.ENABLE_PROMPT_CACHING_1H, '1');
});

test('host values win over those defaults', () => {
  const env = buildClaudeSdkEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '0', DISABLE_AUTOUPDATER: '0', ENABLE_PROMPT_CACHING_1H: '0' });
  assert.equal(env.CLAUDE_CODE_ENABLE_TODO_TOOLS, '0');
  assert.equal(env.DISABLE_AUTOUPDATER, '0');
  assert.equal(env.ENABLE_PROMPT_CACHING_1H, '0');
});

test('host env vars are still forwarded', () => {
  assert.equal(buildClaudeSdkEnv({ ANTHROPIC_BASE_URL: 'http://proxy' }).ANTHROPIC_BASE_URL, 'http://proxy');
});

test('the extra folders of a project reach the SDK as additionalDirectories', () => {
  const sdkOptions = mapCliOptionsToSDK({
    cwd: '/workspace/primary',
    additionalDirectories: ['/workspace/second', '/workspace/third'],
  });
  assert.equal(sdkOptions.cwd, '/workspace/primary');
  assert.deepEqual(sdkOptions.additionalDirectories, ['/workspace/second', '/workspace/third']);
});

test('a single-folder project sets no additionalDirectories', () => {
  assert.equal(mapCliOptionsToSDK({ cwd: '/workspace/primary', additionalDirectories: [] }).additionalDirectories, undefined);
  assert.equal(mapCliOptionsToSDK({ cwd: '/workspace/primary' }).additionalDirectories, undefined);
});
