// Service Worker for CloudCLI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
const CACHE_NAME = 'claude-ui-v2';
const urlsToCache = [
  '/manifest.json'
];

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Shown when the server does not answer a page load. Polls /health and reloads as soon as the server is back, so a
// server that is restarting or being started by its autostart task needs no click.
function offlinePage(requestUrl) {
  const origin = new URL(requestUrl).origin;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Offline</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; background: #111; color: #ddd; }
  @media (prefers-color-scheme: light) { body { background: #fafafa; color: #222; } }
  main { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  p { margin: 0.5rem 0; opacity: 0.8; }
  code { font-size: 0.95em; }
  button { margin-top: 1rem; padding: 0.5rem 1rem; border-radius: 0.5rem; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
  .hint { margin-top: 2.5rem; font-size: 0.85rem; opacity: 0.6; }
  pre { display: inline-block; margin: 0; padding: 0.4rem 0.8rem; border-radius: 0.4rem; background: rgba(128, 128, 128, 0.15); font-size: 0.9rem; user-select: all; }
</style>
</head>
<body>
<main>
  <h1>Offline</h1>
  <p>The CloudCLI server at <code>${origin}</code> is not answering.</p>
  <p id="status">Retrying automatically.</p>
  <button type="button" onclick="location.reload()">Retry now</button>
  <p class="hint">To have the server start at logon and come back after a crash, run this once in its checkout on the machine that serves it:</p>
  <pre>npm run autostart:install</pre>
</main>
<script>
  let attempts = 0;
  async function check() {
    attempts += 1;
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      if (response.ok) { location.reload(); return; }
    } catch {}
    document.getElementById('status').textContent = 'Retrying automatically (' + attempts + ').';
    setTimeout(check, 3000);
  }
  setTimeout(check, 3000);
</script>
</body>
</html>`;
}

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => new Response(offlinePage(event.request.url), {
        headers: { 'Content-Type': 'text/html' }
      }))
    );
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build
  if (url.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Activate event — purge old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CloudCLI', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
