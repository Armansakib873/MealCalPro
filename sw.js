const CACHE_NAME = 'mealcal-v15'; // Incremented for PWA mobile fix

const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
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
        })
    );
});

// Fetch Strategy: Network First for HTML, Cache First for static assets
self.addEventListener('fetch', (evt) => {
    const url = new URL(evt.request.url);
    
    // 1. Ignore non-GET requests
    if (evt.request.method !== 'GET') return;
    
    // 2. Handle Supabase API calls - network only, no caching
    if (url.hostname.includes('supabase.co')) {
        evt.respondWith(fetch(evt.request));
        return;
    }
    
    // 3. For navigation requests (HTML), use network first
    if (evt.request.mode === 'navigate') {
        evt.respondWith(
            fetch(evt.request)
                .then((response) => {
                    // Cache the successful response
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(evt.request, responseClone);
                    });
                    return response;
                })
                .catch(() => {
                    // Fallback to cache if network fails
                    return caches.match('./index.html');
                })
        );
        return;
    }
    
    // 4. For static assets, use cache first with network fallback
    evt.respondWith(
        caches.match(evt.request).then((cacheRes) => {
            if (cacheRes) {
                // Return cached version and update in background
                fetch(evt.request).then((networkRes) => {
                    if (networkRes && networkRes.status === 200) {
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(evt.request, networkRes.clone());
                        });
                    }
                }).catch(() => {}); // Silently fail network update
                return cacheRes;
            }
            
            // No cache, fetch from network
            return fetch(evt.request).then((networkRes) => {
                if (networkRes && networkRes.status === 200) {
                    const responseClone = networkRes.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(evt.request, responseClone);
                    });
                }
                return networkRes;
            }).catch(() => {
                // Return offline response for assets
                return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
            });
        })
    );
});
