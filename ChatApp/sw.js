const CACHE_NAME = 'chat-app-v6';

const STATIC_ASSETS = [
    '/offline.html',
    '/static/manifest.json',
    '/static/css/style.css',
    '/static/js/chat.js',
    '/static/images/notification-icon.png',
    '/static/images/badge-icon.png',
    '/static/images/view-icon.png',
    '/static/images/error-image.png',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js',
    'https://cdn.socket.io/4.0.1/socket.io.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-solid-900.woff2'
];

// Install event
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async cache => {
            const validAssets = await Promise.all(
                STATIC_ASSETS.map(async url => {
                    try {
                        const response = await fetch(url, { method: 'HEAD' });
                        if (response.ok) return url;
                        console.warn(`⚠️ Skipping cache (not OK): ${url}`);
                    } catch (err) {
                        console.warn(`⚠️ Skipping cache (failed): ${url}`, err);
                    }
                    return null;
                })
            );
            return cache.addAll(validAssets.filter(Boolean));
        })
    );
    self.skipWaiting();
});

// Activate event
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// Fetch event
self.addEventListener('fetch', event => {
    if (!event.request.url.startsWith(self.location.origin)) return;

    const url = new URL(event.request.url);
    const isNavigate = event.request.mode === 'navigate';
    const isStatic = url.pathname.startsWith('/static/');
    const isAPI = /\/(messages|groups|online_users|user_status|logout)\b/.test(url.pathname) || url.pathname.startsWith('/socket.io');

    // Network-first for navigations (dynamic HTML)
    if (isNavigate) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match('/offline.html'))
        );
        return;
    }

    // Cache-first for static assets
    if (isStatic) {
        event.respondWith(
            caches.match(event.request).then(response => response || fetch(event.request))
        );
        return;
    }

    // Network-first for API/socket
    if (isAPI) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }

    // Default: try cache, then network, then offline fallback for HTML
    event.respondWith(
        caches.match(event.request).then(response => response || fetch(event.request).catch(() => {
            if (event.request.headers.get('accept')?.includes('text/html')) {
                return caches.match('/offline.html');
            }
            return new Response('Offline');
        }))
    );
});

// Push notifications are handled from the client via showNotification
// Keep a no-op listener for compatibility
self.addEventListener('push', () => {});

// Notification click event
self.addEventListener('notificationclick', event => {
    event.notification.close();

    const targetUrl = new URL(event.notification.data.url, self.location.origin).href;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            for (const client of clientList) {
                if (client.url === targetUrl || client.url.includes(targetUrl)) {
                    client.focus();
                    client.postMessage({
                        type: 'FOCUS_CHAT',
                        senderId: event.notification.data.senderId,
                        messageId: event.notification.data.messageId
                    });
                    return;
                }
            }
            return clients.openWindow(targetUrl);
        })
    );
});
