import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';

const render = (toolResult: unknown, startedAt: string) =>
  renderToStaticMarkup(
    React.createElement(ToolRenderer, {
      toolName: 'Bash',
      toolInput: JSON.stringify({ command: 'npm test' }),
      toolResult,
      startedAt,
      mode: 'input' as const,
    }),
  );

describe('Bash command row duration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows how long a finished command took', () => {
    const markup = render(
      { content: 'ok\ndone', isError: false, timestamp: '2026-11-05T10:00:03.400Z' },
      '2026-11-05T10:00:00.000Z',
    );

    expect(markup).toContain('>3.4s</span>');
    expect(markup).toContain('2 lines');
  });

  it('switches to minutes for a long command', () => {
    const markup = render(
      { content: 'ok', isError: false, timestamp: '2026-11-05T10:02:05.000Z' },
      '2026-11-05T10:00:00.000Z',
    );

    expect(markup).toContain('>2m 5s</span>');
  });

  it('shows the time running so far while the command has no result', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T10:00:42.000Z'));

    expect(render(null, '2026-11-05T10:00:00.000Z')).toContain('>42s</span>');
  });

  it('shows no duration when the result has no timestamp', () => {
    const markup = render({ content: 'ok', isError: false }, '2026-11-05T10:00:00.000Z');

    expect(markup).not.toMatch(/>\d+(\.\d)?s<\/span>/);
  });
});
