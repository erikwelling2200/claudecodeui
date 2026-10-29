import { EventEmitter } from 'node:events';

export type FakeChatSocket = EventEmitter & {
  readyState: number;
  frames: Array<Record<string, unknown>>;
  send: (data: string) => void;
  /**
   * Hands a frame to the gateway and resolves once its handler has finished. The gateway's `message` listener is
   * async and nothing awaits it, so asserting straight after `emit` races the handler.
   */
  deliver: (payload: Record<string, unknown>) => Promise<void>;
};

export function createFakeSocket(): FakeChatSocket {
  const socket = new EventEmitter() as FakeChatSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  socket.deliver = async (payload) => {
    await Promise.all(socket.listeners('message').map((listener) => listener(JSON.stringify(payload))));
  };
  return socket;
}
