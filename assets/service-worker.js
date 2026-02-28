const CACHE_NAME = 'mealcal-cache-v1';
const urlsToCache = [
  '/Mealcal/',
  '/Mealcal/index.html',
  '/Mealcal/styles.css',
  '/Mealcal/app.js',
  '/Mealcal/bowl-app.png',
  '/Mealcal/bowl-app2.png',
  '/Mealcal/ss7.png',
  '/Mealcal/ss8.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Service Worker: Caching files');
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        console.log('Service Worker: Serving cached index.html for navigation');
        return caches.match('/Mealcal/index.html');
      })
    );
  } else {
    event.respondWith(
      caches.match(event.request).then((response) => {
        return response || fetch(event.request).catch(() => {
          console.log('Service Worker: Fetch failed for', event.request.url);
        });
      })
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data.action === 'clear-cache') {
    console.log('Service Worker: Received clear-cache message');
    event.waitUntil(
      caches.delete(CACHE_NAME).then(() => {
        console.log('Service Worker: Cache cleared');
        // Re-cache assets to maintain offline support
        return caches.open(CACHE_NAME).then((cache) => {
          console.log('Service Worker: Re-caching files');
          return cache.addAll(urlsToCache);
        });
      }).then(() => {
        // Notify clients (app) that cache is cleared
        self.clients.matchAll().then((clients) => {
          clients.forEach((client) => {
            client.postMessage({ action: 'cache-cleared' });
          });
        });
      }).catch((error) => {
        console.error('Service Worker: Error clearing cache', error);
      })
    );
  }
});