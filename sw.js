const CACHE_NAME = 'local-pwa-builder-v7';

// In-memory registry of live FileSystemDirectoryHandles mapped by virtual appScope
const devDirectoryHandles = new Map();

const MIME_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4'
};

function getMimeType(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Receive live directory handles from index.html when DEVELOPER broadcast is active
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SET_DEV_FOLDER') {
    devDirectoryHandles.set(event.data.appScope, {
      handle: event.data.handle,
      wrapperHtml: event.data.wrapperHtml
    });
  } else if (event.data && event.data.type === 'CLEAR_DEV_FOLDER') {
    devDirectoryHandles.delete(event.data.appScope);
  }
});

async function serveFromDevHandle(devEntry, relativePath) {
  const cleanRel = (!relativePath || relativePath.endsWith('/'))
    ? `${relativePath}index.html`
    : relativePath;

  // Never allow dev.file or manifest.lock to be accessed from inside the app
  const lowerRel = cleanRel.toLowerCase();
  if (lowerRel === 'dev.file' || lowerRel.endsWith('/dev.file') || lowerRel === 'manifest.lock' || lowerRel.endsWith('/manifest.lock')) {
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  const parts = cleanRel.split('/').filter(Boolean);
  let currentHandle = devEntry.handle;

  for (let i = 0; i < parts.length - 1; i++) {
    currentHandle = await currentHandle.getDirectoryHandle(parts[i]);
  }
  const fileHandle = await currentHandle.getFileHandle(parts[parts.length - 1]);
  const file = await fileHandle.getFile();

  // If serving the root HTML entry, inject the manifest & install gate wrapper
  if (cleanRel === 'index.html' && devEntry.wrapperHtml) {
    const rawHtml = await file.text();
    const finalHtml = devEntry.wrapperHtml(rawHtml);
    return new Response(finalHtml, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  return new Response(file, {
    headers: { 'Content-Type': getMimeType(cleanRel) }
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const cleanPath = decodeURI(url.pathname);
  const lowerPath = cleanPath.toLowerCase();

  // Strictly block dev.file and manifest.lock from ever being fetched or discovered inside any app
  if (lowerPath.endsWith('/dev.file') || lowerPath.endsWith('/manifest.lock')) {
    event.respondWith(
      new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      })
    );
    return;
  }

  if (cleanPath.includes('/apps/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        // Check if this request belongs to an active DEVELOPER live-broadcast folder
        for (const [appScope, devEntry] of devDirectoryHandles.entries()) {
          if (cleanPath.startsWith(appScope)) {
            // Verify dev.file in Cache Storage is explicitly set to "true"
            const baseScope = appScope.replace(/apps\/[^/]+\/$/, '');
            const rootDevRes = await cache.match(`${url.origin}${baseScope}dev.file`);
            const appDevRes = await cache.match(`${url.origin}${appScope}dev.file`);
            const rootTrue = rootDevRes && (await rootDevRes.text()).trim().toLowerCase() === 'true';
            const appTrue = appDevRes && (await appDevRes.text()).trim().toLowerCase() === 'true';

            if ((rootTrue || appTrue) && !cleanPath.endsWith('manifest.json')) {
              try {
                const relPath = cleanPath.slice(appScope.length);
                return await serveFromDevHandle(devEntry, relPath);
              } catch (err) {
                // Fall back to cached files if not found in live folder
              }
            }
          }
        }

        const cacheKey = cleanPath.endsWith('/')
          ? `${url.origin}${cleanPath}index.html`
          : `${url.origin}${cleanPath}`;

        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          return cachedResponse;
        }
        return new Response('Virtual PWA file not found in local cache.', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' }
        });
      })
    );
  }
});
