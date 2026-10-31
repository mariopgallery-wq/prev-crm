import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function automaticAppUpdates() {
  return {
    name: 'preventivi-pro-service-worker',
    generateBundle(_options, bundle) {
      // La lista degli asset hashati cambia a ogni build: questo forza il browser
      // a rilevare il nuovo service worker dopo ogni deploy GitHub Pages.
      const assets = Object.keys(bundle).filter(file => file === 'index.html' || file.startsWith('assets/'));
      const urls = [...new Set(['./', './index.html', ...assets.map(file => `./${file}`)])];
      const source = `const CACHE_PREFIX = 'preventivi-pro-';\nconst CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(assets.join('|'))};\nconst PRECACHE_URLS = ${JSON.stringify(urls)};\n\nself.addEventListener('install', event => {\n  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));\n});\n\nself.addEventListener('activate', event => {\n  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));\n});\n\nself.addEventListener('fetch', event => {\n  const request = event.request;\n  if (request.method !== 'GET') return;\n  const url = new URL(request.url);\n  if (url.origin !== self.location.origin) return;\n  if (request.mode === 'navigate') {\n    event.respondWith(fetch(request).then(response => {\n      if (response && response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy)); }\n      return response;\n    }).catch(() => caches.match('./index.html')));\n    return;\n  }\n  if (url.pathname.includes('/assets/')) {\n    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {\n      if (response && response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(request, copy)); }\n      return response;\n    })));\n  }\n});\n`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), automaticAppUpdates()],
  // Relative asset URLs work both at a domain root and under GitHub Pages /repository/.
  base: './',
});
