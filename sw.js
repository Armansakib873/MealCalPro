// Bump this on every release so installed PWAs drop the old cache.
const CACHE_NAME = 'mealcal-v34'; // v34: SVG cash gauge

const CSS_FILES = [
    'base', 'layout', 'navigation', 'bottom-sheet', 'components', 'auth', 'profile',
    'expenses', 'deposits', 'tracker', 'dashboard', 'summary', 'dashboard-balance',
    'cycle', 'responsive', 'actions', 'dashboard-schedules', 'guest-meals', 'theme', 'neumorphism', 'dashboard-neu', 'polish',
].map((f) => `./css/${f}.css`);

const JS_FILES = [
    'core', 'utils', 'ui', 'auth', 'realtime', 'app-shell', 'notifications', 'dashboard',
    'dashboard-schedules', 'scheduler', 'profile', 'tracker', 'summary',
    'export', 'expenses', 'deposits', 'entries', 'features', 'insights', 'admin', 'cycle', 'pwa',
].map((f) => `./js/${f}.js`);

const ASSETS = [
    './',
    './index.html',
    ...CSS_FILES,
    ...JS_FILES,
    './192.png',
    './512.png',
    './Mealcal_logo.png',
    './favicon.ico',
    './manifest.json'
    // Removed external CDN from install - it's handled dynamically in fetch
];

// Install: Cache App Shell
self.addEventListener('install', (evt) => {
    evt.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate: Cleanup old caches
self.addEventListener('activate', (evt) => {
    evt.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch strategy
//  - Supabase API / realtime: never touched by the service worker
//  - Our own HTML, JS, CSS: NETWORK FIRST (new releases apply immediately), cache as offline fallback
//  - Images, fonts, CDN libraries: CACHE FIRST, refreshed in the background
self.addEventListener('fetch', (evt) => {
    const req = evt.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.hostname.includes('supabase.co') || url.protocol.startsWith('chrome-extension')) return;

    const sameOrigin = url.origin === self.location.origin;
    const isAppCode = sameOrigin && (req.mode === 'navigate' || /.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith('/'));

    if (isAppCode) {
        evt.respondWith(
            fetch(req)
                .then((res) => {
                    if (res && res.status === 200) {
                        const copy = res.clone();
                        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
                    }
                    return res;
                })
                .catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : new Response('Offline', { status: 503 }))))
        );
        return;
    }

    evt.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req)
                .then((res) => {
                    if (res && (res.status === 200 || res.type === 'opaque')) {
                        const copy = res.clone();
                        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
                    }
                    return res;
                })
                .catch(() => cached || new Response('Offline', { status: 503, statusText: 'Service Unavailable' }));
            return cached || network;
        })
    );
});

// ============================================
// BROWSER PUSH NOTIFICATION HANDLERS
// ============================================

// Listen for incoming Push Events
self.addEventListener('push', (evt) => {
    let data = { title: 'MealCal Pro Alert', body: 'You have a new update in MealCal Pro', url: './' };
    if (evt.data) {
        try {
            data = evt.data.json();
        } catch (e) {
            data.body = evt.data.text();
        }
    }

    const options = {
        body: data.body || 'You have a new notification.',
        icon: data.icon || './192.png',
        badge: './192.png',
        vibrate: [100, 50, 100],
        data: {
            url: data.url || './',
            timestamp: Date.now()
        }
    };

    evt.waitUntil(
        self.registration.showNotification(data.title || 'MealCal Pro', options)
    );
});

// Notification Click Event Listener: Focus app or open URL
self.addEventListener('notificationclick', (evt) => {
    evt.notification.close();
    const targetUrl = evt.notification.data?.url || './';

    evt.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    if (targetUrl && client.navigate) {
                        client.navigate(targetUrl);
                    }
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});

