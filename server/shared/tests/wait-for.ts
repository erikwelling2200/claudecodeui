import assert from 'node:assert/strict';

/**
 * Polls until `condition` holds, for up to `timeoutMs`. For tests that cannot await the work they check: a fixed
 * sleep long enough on an idle machine is too short while the whole suite runs in parallel.
 */
export async function waitFor(condition: () => boolean, description = 'the condition holds', timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  assert.ok(condition(), `timed out waiting until ${description}`);
}
