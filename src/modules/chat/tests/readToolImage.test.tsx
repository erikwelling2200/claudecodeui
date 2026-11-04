import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';

const readFileBlob = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    readFileBlob: (...args: unknown[]) => readFileBlob(...args),
  },
}));

/**
 * When the agent reads an image, the user should see that image in the chat,
 * not only the path of the file.
 */

const OBJECT_URL = 'blob:mock-image';
URL.createObjectURL = vi.fn(() => OBJECT_URL);
URL.revokeObjectURL = vi.fn();

const IMAGE_PATH = 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\scratchpad\\tablet2.png';

beforeEach(() => {
  readFileBlob.mockReset();
  readFileBlob.mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });
});

const renderRead = (filePath: string, toolResult: unknown) =>
  render(
    <MarkdownWorkspaceContext.Provider value={{ projectId: 'project-1' }}>
      <ToolRenderer
        toolName="Read"
        toolInput={JSON.stringify({ file_path: filePath })}
        toolResult={toolResult}
        toolId="toolu_1"
        mode="input"
      />
    </MarkdownWorkspaceContext.Provider>,
  );

test('a completed Read of an image shows the image under the row', async () => {
  const { findByRole } = renderRead(IMAGE_PATH, { content: '[{"type":"image"}]', isError: false });

  const img = (await findByRole('img')) as HTMLImageElement;
  assert.equal(img.getAttribute('src'), OBJECT_URL);
  assert.equal(img.alt, 'tablet2.png');
  assert.deepEqual(readFileBlob.mock.calls[0].slice(0, 2), ['project-1', IMAGE_PATH]);
});

test('a Read of a text file shows no image', () => {
  const { queryByRole } = renderRead('/repo/src/app.ts', { content: 'code', isError: false });

  assert.equal(queryByRole('img'), null);
  assert.equal(readFileBlob.mock.calls.length, 0);
});

test('an image Read that is still running or failed shows no image', () => {
  const running = renderRead(IMAGE_PATH, undefined);
  assert.equal(running.queryByRole('img'), null);
  running.unmount();

  const failed = renderRead(IMAGE_PATH, { content: 'File does not exist.', isError: true });
  assert.equal(failed.queryByRole('img'), null);
  assert.equal(readFileBlob.mock.calls.length, 0);
});
