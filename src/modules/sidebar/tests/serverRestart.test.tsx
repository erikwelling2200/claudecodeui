import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

// The restart button in the sidebar footer: a first click arms it, a second click posts the restart, and the page
// reloads once /health answers from a process with a different start stamp.

const restartCalls: number[] = [];
const updateCalls: number[] = [];
let updateFails = false;
let healthStartedAt = '2026-11-19T10:00:00.000Z';
let healthDown = false;

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      system: {
        restart: async () => {
          restartCalls.push(Date.now());
          return new Response(JSON.stringify({ success: true, data: { supervised: false } }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        },
        updateAndRestart: async () => {
          updateCalls.push(Date.now());
          const body = updateFails
            ? { success: false, step: 'merge', error: 'fatal: Not possible to fast-forward, aborting.' }
            : { success: true, previousHead: 'a', head: 'b', commits: 1, installed: false, built: true };
          return new Response(JSON.stringify(body), {
            status: updateFails ? 500 : 202,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    },
  };
});

const { default: ServerRestartButton } = await import('@/modules/sidebar/ServerRestartButton');
const t = ((key: string) => key) as never;

beforeEach(() => {
  vi.useFakeTimers();
  restartCalls.length = 0;
  updateCalls.length = 0;
  updateFails = false;
  healthDown = false;
  vi.stubGlobal('fetch', async (url: string) => {
    if (url !== '/health') throw new Error(`unexpected fetch ${url}`);
    if (healthDown) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ status: 'ok', startedAt: healthStartedAt }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('the first click only arms the button', () => {
  const { getByLabelText, getByText } = render(React.createElement(ServerRestartButton, { t }));
  fireEvent.click(getByLabelText('server.restart'));
  getByText('server.confirm');
  assert.equal(restartCalls.length, 0);
});

test('an armed button disarms itself after a few seconds', () => {
  const { getByLabelText, queryByText } = render(React.createElement(ServerRestartButton, { t }));
  fireEvent.click(getByLabelText('server.restart'));
  act(() => { vi.advanceTimersByTime(5000); });
  assert.equal(queryByText('server.confirm'), null);
});

test('confirming posts the restart and reloads once a new server answers', async () => {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });
  const { getByLabelText, getByText } = render(React.createElement(ServerRestartButton, { t }));
  fireEvent.click(getByLabelText('server.restart'));
  fireEvent.click(getByText('server.confirm'));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  assert.equal(restartCalls.length, 1);

  // The old process is still answering, then down, then the new one answers with a new stamp.
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  assert.equal(reload.mock.calls.length, 0);
  healthDown = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  assert.equal(reload.mock.calls.length, 0);
  healthDown = false;
  healthStartedAt = '2026-11-19T10:05:00.000Z';
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  assert.equal(reload.mock.calls.length, 1);
});

test('a server that never comes back leaves the button in its failed state', async () => {
  const { getByLabelText, getByText } = render(React.createElement(ServerRestartButton, { t }));
  fireEvent.click(getByLabelText('server.restart'));
  fireEvent.click(getByText('server.confirm'));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  healthDown = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
  getByLabelText('server.failed');
});

test('right-click offers the update, which restarts once the new server answers', async () => {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });
  const { getByLabelText, getByText } = render(React.createElement(ServerRestartButton, { t }));
  fireEvent.contextMenu(getByLabelText('server.restart'));
  fireEvent.click(getByText('server.update'));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  assert.equal(updateCalls.length, 1);
  assert.equal(restartCalls.length, 0);

  healthStartedAt = '2026-11-19T10:10:00.000Z';
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  assert.equal(reload.mock.calls.length, 1);
});

test('a failed update keeps the server up and shows a dismissable warning', async () => {
  updateFails = true;
  const { getByLabelText, getByText } = render(React.createElement(ServerRestartButton, { t }));
  fireEvent.contextMenu(getByLabelText('server.restart'));
  fireEvent.click(getByText('server.update'));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  fireEvent.click(getByLabelText('server.updateFailedLabel'));
  getByLabelText('server.restart');
});
