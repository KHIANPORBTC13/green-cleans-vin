/* Lo minimo para que el telefono trate esto como una aplicacion.

   Sin service worker Android no ofrece "Instalar", y la app no abre sin
   señal. Este guarda la carcasa —la pagina, el manifiesto y los iconos— y
   nada mas.

   Lo que NUNCA se guarda: las llamadas a la base de datos. Una respuesta
   vieja de la base, servida desde la memoria del telefono, enseñaria autos
   que ya no estan o esconderia los nuevos, y nadie notaria que la lista es de
   ayer.

   La pagina se pide primero a la red y solo si no hay señal se tira de la
   copia: asi cada arreglo que se sube llega en la siguiente apertura, en vez
   de quedarse el telefono con la version vieja hasta vaciar la memoria. */
const CACHE = "registro-vin-v1";
const CARCASA = ["./", "./index.html", "./manifest.webmanifest",
  "./icon-180.png", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CARCASA)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  /* La base de datos, siempre en directo. */
  if (url.hostname.endsWith("supabase.co")) return;

  /* El lector y las fuentes no cambian nunca para una misma direccion:
     guardarlos hace que el lector arranque al momento la segunda vez. */
  if (url.hostname === "cdn.jsdelivr.net" || url.hostname.endsWith("gstatic.com")
      || url.hostname.endsWith("googleapis.com")) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
      return r;
    })));
    return;
  }

  if (url.origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(r => {
    if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
    return r;
  }).catch(() => caches.match(req).then(hit => hit || caches.match("./index.html"))));
});
