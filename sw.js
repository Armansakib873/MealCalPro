const CACHE_NAME = 'mealcal-pro-v1';

// Assets to cache immediately so the app opens even if offline
// Note: We cache the CDN links because your HTML relies on them
const ASSETS = [
    './',
    './index.html',
    './192.png',
    './512.png',
    './Mealcal_logo.png',
    './video3.mp4', 
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
];

// Install Event
self.addEventListener('install', (evt) => {
      self.skipWaiting(); 
    evt.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log(' caching shell assets');
            return cache.addAll(ASSETS);
        })
    );
});

// Activate Event (Cleanup old caches)
self.addEventListener('activate', (evt) => {
    evt.waitUntil(
        Promise.all([
            // Claim clients immediately so the first load is controlled
            self.clients.claim(),
            caches.keys().then((keys) => {
                return Promise.all(keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
                );
            })
        ])
    );
});
// Fetch Event
self.addEventListener('fetch', (evt) => {
    // 1. Handle API/Supabase calls (Network Only)
    // We don't want to cache database data, or the money/meal stats will be wrong
    if (evt.request.url.includes('supabase.co')) {
        return; 
    }

    // 2. Handle Static Assets (Cache First, fall back to Network)
    evt.respondWith(
        caches.match(evt.request).then((cacheRes) => {
            return cacheRes || fetch(evt.request).catch(() => {
                // Optional: Return a specific offline page if needed
                // For now, we rely on the cached index.html
                if (evt.request.url.indexOf('.html') > -1) {
                    return caches.match('./index.html');
                }
            });
        })
    );
});