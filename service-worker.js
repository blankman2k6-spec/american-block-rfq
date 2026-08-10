const CACHE="ab-sales-os-v5-2-3-period-sales-year-adjustment";
const ASSETS=["./","index.html","manifest.json","icon-192.png","icon-512.png","assets/ABCO-FLOWLINE-CATALOG.pdf","ABCO-FLOWLINE-CATALOG.pdf"];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch",event=>{
  const request=event.request;
  const url=new URL(request.url);

  // Never intercept API/auth requests, cross-origin traffic, or non-GET requests.
  // This is especially important for Supabase password recovery on iOS Safari/PWA.
  if(request.method!=="GET" || url.origin!==self.location.origin) return;

  if(request.mode==="navigate"){
    event.respondWith(
      fetch(request,{cache:"no-store"})
        .then(response=>{
          const copy=response.clone();
          event.waitUntil(caches.open(CACHE).then(cache=>cache.put("./",copy)).catch(()=>{}));
          return response;
        })
        .catch(()=>caches.match("./"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached=>cached || fetch(request).then(response=>{
      const copy=response.clone();
      event.waitUntil(caches.open(CACHE).then(cache=>cache.put(request,copy)).catch(()=>{}));
      return response;
    }))
  );
});
