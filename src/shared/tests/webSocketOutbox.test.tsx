import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * A chat message sent while the socket was down, or into a socket that looked
 * open but was dead, used to vanish while its bubble stayed on screen. The
 * provider now keeps such frames until the server confirms receipt and sends
 * them again on the next socket.
 */

const AUTH = vi.hoisted(() => {
  const user = { id: 1 };
  return { current: { user, token: 'token-1', isLoading: false } };
});

vi.mock('@/modules/auth', () => ({
  useAuth: () => AUTH.current,
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  serverOpens() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Opens the way the current gateway does: announcing that it confirms frames. */
  serverOpensWithReceipts() {
    this.serverOpens();
    this.serverSends({ kind: 'gateway_features', clientFrameReceipts: true });
  }

  serverDrops() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  serverSends(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** Answers every frame carrying a client id with its receipt, as the gateway does. */
  serverAcknowledgesAll() {
    for (const frame of this.sent) {
      if (typeof frame.clientMessageId === 'string') {
        this.serverSends({ kind: 'client_frame_received', clientMessageId: frame.clientMessageId });
      }
    }
  }
}

const { WebSocketProvider, useWebSocket } = await import('@/shared/context/WebSocketContext');

/** Mirrors the provider's receipt timeout. */
const RECEIPT_TIMEOUT_MS = 10_000;

let api: ReturnType<typeof useWebSocket> | null = null;

function Capture() {
  const value = useWebSocket();
  useEffect(() => {
    api = value;
  });
  return null;
}

const renderProvider = () => render(<WebSocketProvider><Capture /></WebSocketProvider>);
const socket = (index: number) => FakeWebSocket.instances[index] as FakeWebSocket;
const send = (frame: Record<string, unknown>) => act(() => api?.sendMessage(frame));
const chatSend = { type: 'chat.send', sessionId: 's1', content: 'hello' };

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  api = null;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a message sent while the socket is down goes out when the next socket opens', () => {
  renderProvider();
  act(() => socket(0).serverOpensWithReceipts());
  act(() => socket(0).serverDrops());

  send(chatSend);
  assert.equal(api?.unsentCount, 1);

  act(() => { vi.advanceTimersByTime(3000); });
  act(() => socket(1).serverOpensWithReceipts());
  assert.equal(socket(1).sent.length, 1);
  assert.equal(socket(1).sent[0].content, 'hello');
  assert.equal(typeof socket(1).sent[0].clientMessageId, 'string');
  assert.equal(api?.unsentCount, 1, 'still unconfirmed until the receipt arrives');

  act(() => socket(1).serverAcknowledgesAll());
  assert.equal(api?.unsentCount, 0);
});

test('a message sent before the first handshake finishes goes out once it does', () => {
  renderProvider();
  send(chatSend);
  act(() => socket(0).serverOpens());
  assert.equal(socket(0).sent.length, 1);
});

test('a socket that never confirms a message is dropped, and the message goes out again with the same id', () => {
  renderProvider();
  act(() => socket(0).serverOpensWithReceipts());

  send(chatSend);
  assert.equal(socket(0).sent.length, 1);
  const id = socket(0).sent[0].clientMessageId;

  act(() => { vi.advanceTimersByTime(RECEIPT_TIMEOUT_MS); });
  assert.equal(api?.connectionStatus, 'disconnected');

  act(() => { vi.advanceTimersByTime(3000); });
  act(() => socket(1).serverOpensWithReceipts());
  assert.equal(socket(1).sent.length, 1);
  assert.equal(socket(1).sent[0].clientMessageId, id);
});

test('a confirmed message is not sent again after a reconnect', () => {
  renderProvider();
  act(() => socket(0).serverOpensWithReceipts());
  send(chatSend);
  act(() => socket(0).serverAcknowledgesAll());

  act(() => { vi.advanceTimersByTime(RECEIPT_TIMEOUT_MS * 2); });
  assert.equal(api?.connectionStatus, 'connected', 'a confirmed socket is kept');

  act(() => socket(0).serverDrops());
  act(() => { vi.advanceTimersByTime(3000); });
  act(() => socket(1).serverOpensWithReceipts());
  assert.equal(socket(1).sent.length, 0);
});

test('queued messages go out in the order they were sent', () => {
  renderProvider();
  send({ ...chatSend, content: 'first' });
  send({ type: 'chat.permission-response', requestId: 'r1', allow: true });
  send({ ...chatSend, content: 'second' });
  act(() => socket(0).serverOpens());
  assert.deepEqual(socket(0).sent.map((frame) => frame.content ?? frame.type), ['first', 'chat.permission-response', 'second']);
});

test('a control frame sent while the socket is down is not kept', () => {
  renderProvider();
  send({ type: 'chat.abort', sessionId: 's1' });
  act(() => socket(0).serverOpens());
  assert.equal(socket(0).sent.length, 0);
  assert.equal(api?.unsentCount, 0);
});

test('a server that never announced receipts gets each message once, and the socket is kept', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  send(chatSend);
  assert.equal(socket(0).sent.length, 1);
  assert.equal(api?.unsentCount, 0);

  act(() => { vi.advanceTimersByTime(RECEIPT_TIMEOUT_MS * 2); });
  assert.equal(api?.connectionStatus, 'connected');

  act(() => socket(0).serverDrops());
  act(() => { vi.advanceTimersByTime(3000); });
  act(() => socket(1).serverOpens());
  assert.equal(socket(1).sent.length, 0);
});
