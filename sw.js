const CACHE = 'mediabox-v6';
const MEDIA_CACHE = 'mediabox-media-v1'; // オフライン保存した曲・動画(バージョン更新で消さない)
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE && k !== MEDIA_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/**
 * オフライン保存済みメディアの配信。
 * 動画のシークに必要なRangeリクエスト(部分取得)にも対応する。
 */
async function serveMedia(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(request.url, { ignoreSearch: true, ignoreVary: true });
  if (!cached) return fetch(request); // 未保存 → 通常のストリーミング再生

  const range = request.headers.get('range');
  if (!range) return cached.clone();

  const m = /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) return cached.clone();
  const buf = await cached.clone().arrayBuffer();
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  if (start >= buf.byteLength) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buf.byteLength}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;

  // メディアはオフライン保存があればそこから、なければネットワークから
  if (url.pathname.includes('/media/')) {
    e.respondWith(serveMedia(e.request));
    return;
  }

  // ライブラリJSONは常にネットワーク
  if (url.pathname.endsWith('library.json')) return;

  // アプリ本体: ネットワーク優先(オンラインなら常に最新版)、オフライン時はキャッシュ
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() =>
      caches.match(e.request, { ignoreSearch: true }).then((cached) => cached || Response.error())
    )
  );
});
