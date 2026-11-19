import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { IS_PLATFORM } from '@/shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '@/shared/authToken';
import type { ServerEvent } from '@/shared/types';


type ServerEventListener = (event: ServerEvent) => void;

/**
 * Where the chat socket stands. `connecting` covers a handshake the provider
 * started on purpose (after sign-in, or with a refreshed token) and the time
 * signed out; `disconnected` a socket that closed on its own (it dropped, or an
 * attempt failed) until a reconnect opens again.
 */
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
  /**
   * Lets the UI tell a lost connection (`disconnected`, reconnecting every few
   * seconds) apart from the first handshake (`connecting`), so it can show the
   * former without flashing on every page load. A socket the provider replaces
   * on purpose, such as on a token refresh, reports `connecting` until the new
   * one opens, never `disconnected`.
   */
  connectionStatus: ConnectionStatus;
  /**
   * Chat messages the server has not confirmed yet: queued while the socket is
   * down, or sent and still waiting for the server's receipt. They are sent
   * (again) when the next socket opens.
   */
  unsentCount: number;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

/**
 * Frames that carry something the user wrote or answered. They are kept until
 * the server confirms receipt (`client_frame_received`), so a socket that is
 * down, or looks open but is dead, cannot swallow them. Control frames such as
 * `chat.abort` or `chat.subscribe` are not kept: sent late they would act on a
 * state that has moved on.
 */
const RELIABLE_FRAME_TYPES = new Set(['chat.send', 'chat.edit-send', 'chat.steer', 'chat.permission-response']);

/** A sent frame with no receipt after this long means the socket is dead, even if it still reads as open. */
const RECEIPT_TIMEOUT_MS = 10_000;

type OutboxEntry = {
  id: string;
  frame: Record<string, unknown>;
  /** The socket the frame last went out on, and when; null while it waits for a socket. */
  sentOn: WebSocket | null;
  sentAt: number;
};

const createClientMessageId = () => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    // crypto.randomUUID only exists in a secure context; a LAN address over http is not one.
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
);

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  // Drives `isConnected` and the workspace header's "Reconnecting" indicator.
  // Three values rather than a boolean: a first handshake still in flight must
  // not read as a lost connection, or every page load would flash the indicator.
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const outboxRef = useRef<OutboxEntry[]>([]);
  const [unsentCount, setUnsentCount] = useState(0);
  const receiptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Whether the server announced `clientFrameReceipts`. Until it has, frames are
   * not kept once sent: no receipt would come, and keeping them would send each
   * one again on the next socket. Kept across sockets, because a reconnect
   * flushes the outbox before the new socket's announcement arrives.
   */
  const serverConfirmsRef = useRef(false);
  const { isLoading: isAuthLoading, token, user } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  const transmit = useCallback((entry: OutboxEntry, socket: WebSocket) => {
    socket.send(JSON.stringify(entry.frame));
    entry.sentOn = socket;
    entry.sentAt = Date.now();
    if (!serverConfirmsRef.current) {
      // No receipt will come, so keeping it would send it twice on the next socket.
      outboxRef.current = outboxRef.current.filter((kept) => kept !== entry);
      setUnsentCount(outboxRef.current.length);
    }
  }, []);

  /**
   * Gives up on a socket that took a frame and never confirmed it. A socket
   * whose peer is gone (the PC slept, the network changed) can read as open
   * for a long time, and everything sent into it is lost; dropping it starts
   * the normal reconnect, which sends the outbox again.
   */
  const checkReceipts = useCallback(function checkReceipts() {
    receiptTimerRef.current = null;
    const socket = wsRef.current;
    const waiting = outboxRef.current.filter((entry) => entry.sentOn !== null && entry.sentOn === socket);
    if (!socket || waiting.length === 0) return;
    const oldest = Math.min(...waiting.map((entry) => entry.sentAt));
    const overdueIn = oldest + RECEIPT_TIMEOUT_MS - Date.now();
    if (overdueIn > 0) {
      receiptTimerRef.current = setTimeout(checkReceipts, overdueIn);
      return;
    }
    console.warn('WebSocket sent a chat message without a receipt; reconnecting');
    const handleLost = socket.onclose;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
    handleLost?.call(socket, new Event('close') as CloseEvent);
  }, []);

  const armReceiptCheck = useCallback(() => {
    if (receiptTimerRef.current === null) {
      receiptTimerRef.current = setTimeout(checkReceipts, RECEIPT_TIMEOUT_MS);
    }
  }, [checkReceipts]);

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(function connect() {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;

      websocket.onopen = () => {
        setConnectionStatus('connected');
        // Before the reconnect signal, so a chat that re-subscribes in response
        // already finds the queued message's run on the server.
        for (const entry of outboxRef.current) {
          transmit(entry, websocket);
        }
        if (outboxRef.current.length > 0) armReceiptCheck();
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          if (data.kind === 'gateway_features') {
            serverConfirmsRef.current = data.clientFrameReceipts === true;
            return;
          }
          if (data.kind === 'client_frame_received') {
            const remaining = outboxRef.current.filter((entry) => entry.id !== data.clientMessageId);
            outboxRef.current = remaining;
            setUnsentCount(remaining.length);
            return;
          }
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        // Also reached when the very first attempt fails, which is a lost
        // connection too. The effect cleanup detaches this handler before
        // closing a socket on purpose, so a token refresh never gets here.
        setConnectionStatus('disconnected');
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [armReceiptCheck, dispatch, isAuthLoading, token, user, transmit]); // reconnect with current authentication state

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, token,
  // user] and `dispatch` is stable, so depending on it reconnects on exactly
  // the same transitions as the previous [isAuthLoading, token, user] list.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (receiptTimerRef.current) {
        clearTimeout(receiptTimerRef.current);
        receiptTimerRef.current = null;
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
      // What comes next is a socket with a refreshed token, or none after a
      // sign-out or session expiry. Either way it starts from a fresh
      // handshake: the socket closed here is no longer live, and a drop seen
      // before must not show as "Reconnecting" after the next sign-in.
      setConnectionStatus('connecting');
    };
  }, [connect, isAuthLoading, user]); // reconnect after authentication or token refresh

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    const isOpen = socket !== null && socket.readyState === WebSocket.OPEN;
    const frame = message as Record<string, unknown> | null;
    if (frame && typeof frame.type === 'string' && RELIABLE_FRAME_TYPES.has(frame.type)) {
      const id = createClientMessageId();
      const entry: OutboxEntry = { id, frame: { ...frame, clientMessageId: id }, sentOn: null, sentAt: 0 };
      outboxRef.current = [...outboxRef.current, entry];
      setUnsentCount(outboxRef.current.length);
      if (isOpen) {
        transmit(entry, socket);
        armReceiptCheck();
      }
      return;
    }
    if (isOpen) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, [armReceiptCheck, transmit]);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected: connectionStatus === 'connected',
    connectionStatus,
    unsentCount,
  }), [sendMessage, subscribe, connectionStatus, unsentCount]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
