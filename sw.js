/* Today Board — Service Worker
 * 캐시 전략
 *  - 네비게이션(문서/HTML) 요청: Network-First — 항상 최신 배포본을 먼저 시도하고,
 *    네트워크 실패(오프라인) 시에만 캐시된 index.html 로 폴백. 공개 페이지에 구버전이
 *    남는 문제를 막기 위한 전략입니다.
 *  - 그 외 정적 자산(mobile.css, manifest, icon 등) + 허용된 CDN(Tailwind / Alpine / Google Fonts): Cache-First
 *  - 그 외 도메인(예: api.telegram.org): SW 미개입 → 항상 네트워크 (오프라인이면 자연스럽게 실패)
 *
 * 배포/수정 후 캐시를 강제로 갱신하려면 아래 VERSION 값을 올리세요.
 */
const VERSION = 'today-board-v9-netfirst';
const PRECACHE = VERSION + '-precache';
const RUNTIME  = VERSION + '-runtime';

/* 첫 오프라인 구동을 보장하기 위해 설치 시점에 받아두는 목록 */
const CORE = [
  './',
  './index.html',
  './mobile.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  'https://cdn.tailwindcss.com/3.4.16',
  'https://cdnjs.cloudflare.com/ajax/libs/alpinejs/3.14.1/cdn.min.js',
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap',
];

/* 런타임에 Cache-First 로 저장할 외부 호스트 화이트리스트 */
const RUNTIME_HOSTS = [
  'cdn.tailwindcss.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.google.com', // 퀵링크 파비콘(/s2/favicons) — 한 번 본 파비콘은 오프라인에서도 표시
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE).then((cache) =>
      Promise.allSettled(
        CORE.map((url) => {
          const external = /^https?:\/\//i.test(url);
          // 교차 출처 CDN 은 CORS 헤더가 없을 수 있으므로 opaque(no-cors)로 저장
          const req = external
            ? new Request(url, { mode: 'no-cors' })
            : new Request(url, { cache: 'reload' });
          return cache.add(req).catch(() => {});
        })
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== PRECACHE && k !== RUNTIME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* 페이지에서 '눌러서 새로고침' 시 대기 중인 새 SW 를 즉시 활성화 */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  const sameOrigin = url.origin === self.location.origin;
  const allowedCdn = RUNTIME_HOSTS.includes(url.hostname);
  if (!sameOrigin && !allowedCdn) return; // 그 외 도메인은 브라우저 기본 처리에 위임

  // 네비게이션(문서) 요청: Network-First — 항상 최신본을 먼저 시도
  const isNavigation = req.mode === 'navigate' ||
    (sameOrigin && (url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')));

  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy));
          }
          return resp;
        })
        .catch(() =>
          caches.match(req).then((cached) =>
            cached || caches.match('./index.html').then((h) => h || caches.match('./'))
          )
        )
    );
    return;
  }

  // 그 외 정적 자산 / 허용 CDN: Cache-First
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then((resp) => {
          if (resp && (resp.ok || resp.type === 'opaque')) {
            const copy = resp.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy));
          }
          return resp;
        })
        .catch(() => cached); // undefined → 네트워크 오류 그대로 전달
    })
  );
});
