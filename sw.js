// ═══════════════════════════════════════════════════════
// ReBuild Service Worker
// Smart caching: app shell cached offline, Supabase data
// always fetched fresh when online, falls back to cache
// ═══════════════════════════════════════════════════════

const APP_VERSION   = 'rebuild-v1.0.0';
const STATIC_CACHE  = `${APP_VERSION}-static`;
const DATA_CACHE    = `${APP_VERSION}-data`;

// Core files to cache on install (app shell)
const STATIC_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Google Fonts (cached for offline)
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Fraunces:opsz,wght@9..144,400;9..144,600&display=swap',
];

// ── Install: pre-cache app shell ──
self.addEventListener('install', event => {
  console.log('[SW] Installing', APP_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        // Cache what we can — don't fail install if some files 404
        return Promise.allSettled(
          STATIC_FILES.map(url =>
            cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ──
self.addEventListener('activate', event => {
  console.log('[SW] Activating', APP_VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE && key !== DATA_CACHE)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: smart routing ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Supabase API calls — network first, cache fallback (read-only GETs)
  if (url.hostname.includes('supabase.co')) {
    if (request.method === 'GET') {
      event.respondWith(networkFirstWithCache(request, DATA_CACHE));
    } else {
      // POST/PATCH/DELETE — network only, queue if offline
      event.respondWith(networkOnlyWithOfflineQueue(request));
    }
    return;
  }

  // 2. Google Fonts — cache first (they rarely change)
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // 3. App shell — cache first, then network
  if (request.mode === 'navigate' || STATIC_FILES.includes(request.url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // 4. Everything else — network first
  event.respondWith(networkFirstWithCache(request, STATIC_CACHE));
});

// ── Caching strategies ──

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — content not available', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

async function networkFirstWithCache(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// For write operations (session saves) — attempt network, store in queue if offline
const OFFLINE_QUEUE_KEY = 'rebuild-offline-queue';

async function networkOnlyWithOfflineQueue(request) {
  try {
    const response = await fetch(request.clone());
    // If we have queued writes and we're back online, try to flush them
    flushOfflineQueue();
    return response;
  } catch {
    // Store failed write for later retry
    await queueOfflineWrite(request);
    // Return optimistic success so UI doesn't break
    return new Response(JSON.stringify({ queued: true, offline: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function queueOfflineWrite(request) {
  try {
    const body = await request.text();
    const queue = JSON.parse((await getFromIDB(OFFLINE_QUEUE_KEY)) || '[]');
    queue.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      timestamp: Date.now()
    });
    await saveToIDB(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    // Notify clients that data was queued
    self.clients.matchAll().then(clients => {
      clients.forEach(client => client.postMessage({ type: 'QUEUED_OFFLINE', count: queue.length }));
    });
  } catch (err) {
    console.warn('[SW] Failed to queue offline write:', err);
  }
}

async function flushOfflineQueue() {
  try {
    const raw = await getFromIDB(OFFLINE_QUEUE_KEY);
    if (!raw) return;
    const queue = JSON.parse(raw);
    if (!queue.length) return;
    console.log('[SW] Flushing', queue.length, 'queued writes');
    const remaining = [];
    for (const item of queue) {
      try {
        await fetch(item.url, {
          method: item.method,
          headers: item.headers,
          body: item.body
        });
      } catch {
        remaining.push(item);
      }
    }
    await saveToIDB(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
    if (remaining.length === 0) {
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'QUEUE_FLUSHED' }));
      });
    }
  } catch (err) {
    console.warn('[SW] Failed to flush queue:', err);
  }
}

// ── Minimal IndexedDB helpers for queue persistence ──
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rebuild-sw', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function getFromIDB(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveToIDB(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ── Background sync (when supported) ──
self.addEventListener('sync', event => {
  if (event.tag === 'sync-sessions') {
    event.waitUntil(flushOfflineQueue());
  }
});

// ── Push notifications ──
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'ReBuild', {
      body: data.body || 'You have a session ready.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag: data.tag || 'rebuild-notification',
      data: { url: data.url || '/' },
      actions: [
        { action: 'open', title: 'Open Session' },
        { action: 'dismiss', title: 'Later' }
      ]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.includes(url) && 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
