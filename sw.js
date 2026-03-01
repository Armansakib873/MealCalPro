const CACHE_NAME = 'mealcal-v6'; // Increment this whenever you change CSS/JS

const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './192.png',
    './512.png',
    './Mealcal_logo.png',
    './manifest.json',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
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

// Fetch Strategy: Stale-While-Revalidate
self.addEventListener('fetch', (evt) => {
    // 1. Ignore Supabase/API calls and non-GET requests
    if (evt.request.url.includes('supabase.co') || evt.request.method !== 'GET') return;

    evt.respondWith(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.match(evt.request).then((cacheRes) => {
                
                // Trigger network fetch regardless of whether cache exists
                const fetchPromise = fetch(evt.request).then((networkRes) => {
                    // Check if we received a valid response before caching
                    if (networkRes && networkRes.status === 200) {
                        cache.put(evt.request, networkRes.clone());
                    }
                    return networkRes;
                }).catch(() => {
                    // If network fails and it's a navigation request, show offline page
                    if (evt.request.mode === 'navigate') {
                        return cache.match('./index.html');
                    }
                });

                // Return the cached version immediately (stale), 
                // but let the fetchPromise finish in the background (revalidate).
                // If there is NO cache, wait for the network.
                return cacheRes || fetchPromise;
            });
        })
    );
});
