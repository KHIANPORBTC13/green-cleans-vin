/* ============================================================
   LECTOR DE VIN — el mismo archivo en SOO y en la app de Registro VIN

   La copia buena vive en SOO (src/25-lector-vin.js). La app de Registro VIN
   lleva una copia idéntica como lector-vin.js: si se cambia aquí, se copia
   allí tal cual. Dos lectores que se arreglan por separado acaban leyendo
   distinto la misma placa, y eso ya pasó una vez.

   Por qué está hecho así. La gente cobra por hora y cada minuto parado
   delante del teléfono es un minuto sin lavar. Antes registrar un chasis era
   foto → dibujar el recuadro → girar → leer → esperar → revisar. Ahora:

   · La cámara se abre dentro de la app con un marco fijo. Se pone el VIN
     dentro del marco y el recorte ya está hecho; no se dibuja nada.
   · Mientras se apunta, el lector va leyendo y el marco se pone en verde,
     ámbar o rojo. Se captura a mano cuando se ve verde: nada se guarda solo.
   · Lo que leyó mientras se apuntaba no se tira: cada fotograma es una
     lectura más que vota en la lectura final.
   · Las fotos de la galería no tienen marco, así que el lector busca solo
     dónde está el VIN y en qué posición está la foto.
   · Siempre se puede girar, enderezar, hacer zoom y mover el recuadro a mano.
   · Se compara con los autos ya vistos: si sólo se equivocó en un carácter
     parecido (una B por un 8), se propone el VIN conocido.

   La foto no sale del teléfono para leerse. Lo único que se descarga es el
   programa que lee, y sólo la primera vez.

   Uso desde la app:
     LectorVIN.precargar()                     deja el lector listo antes de usarlo
     LectorVIN.abrir({ fuente: 'camara' })     → Promise<resultado | null>
     LectorVIN.abrir({ archivo })              una foto de la galería
     LectorVIN.leerFotoEntera(lienzo)          sin pantalla: busca y lee
     LectorVIN.semaforo(vin)                   'verde' | 'ambar' | 'rojo'
   ============================================================ */
;(function () {
  'use strict'

  const VIN_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'
  const VIN_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1'
  const VIN_LANG = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0'

  /* El alfabeto del VIN no tiene I, O ni Q: la norma las quitó para que no
     se confundan con 1 y 0. Decírselo al lector le ahorra las tres
     confusiones más frecuentes antes de cometerlas. */
  const VIN_ALFABETO = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'

  /* ---------------- El programa que lee ----------------

     Uno solo y siempre despierto. Antes se creaba uno nuevo en cada lectura
     y se tiraba al acabar: en un teléfono eso son un par de segundos de
     arranque cada vez, sólo para volver a cargar lo mismo. Ahora arranca una
     vez —mejor aún, mientras la persona todavía está apuntando— y las
     lecturas van en fila, una detrás de otra, porque el programa no sabe
     hacer dos a la vez. */
  let _tess = null
  function cargarTesseract () {
    if (_tess) return _tess
    _tess = new Promise((ok, no) => {
      if (window.Tesseract) return ok(window.Tesseract)
      const s = document.createElement('script')
      s.src = VIN_CDN
      s.onload = () => window.Tesseract ? ok(window.Tesseract) : no(new Error('SIN_LECTOR'))
      s.onerror = () => { _tess = null; no(new Error('SIN_LECTOR')) }
      document.head.appendChild(s)
    })
    return _tess
  }

  let _worker = null
  function obtenerWorker () {
    if (_worker) return _worker
    _worker = cargarTesseract()
      .then(T => T.createWorker('eng', 1, { corePath: VIN_CORE, langPath: VIN_LANG }))
      .catch(e => { _worker = null; throw e })
    return _worker
  }

  let _fila = Promise.resolve()
  function enFila (fn) {
    const p = _fila.then(fn, fn)
    _fila = p.catch(() => {})
    return p
  }

  let _listo = false
  function precargar () {
    return obtenerWorker().then(() => { _listo = true; return true }, () => false)
  }

  /* ---------------- Preparar la imagen ---------------- */

  const lienzo = (w, h) => {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h))
    return c
  }

  const cargarImagen = fuente => new Promise((ok, no) => {
    if (fuente && fuente.getContext) return ok(fuente)
    const img = new Image()
    img.onload = () => ok(img)
    img.onerror = () => no(new Error('FOTO'))
    img.src = typeof fuente === 'string' ? fuente : URL.createObjectURL(fuente)
  })

  const anchoDe = im => im.naturalWidth || im.videoWidth || im.width
  const altoDe = im => im.naturalHeight || im.videoHeight || im.height

  /* Una foto de teléfono pasa de los 4000 píxeles; girarla o pintarla entera
     colgaría un móvil modesto, y para leer basta con mucho menos. */
  function aLienzo (im, max) {
    const w = anchoDe(im), h = altoDe(im)
    const e = Math.min(1, (max || 2000) / Math.max(w, h))
    const c = lienzo(w * e, h * e)
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(im, 0, 0, c.width, c.height)
    return c
  }

  function girarCuartos (c, q) {
    q = ((q % 4) + 4) % 4
    if (!q) return c
    const o = lienzo(q % 2 ? c.height : c.width, q % 2 ? c.width : c.height)
    const g = o.getContext('2d')
    g.translate(o.width / 2, o.height / 2)
    g.rotate(q * Math.PI / 2)
    g.drawImage(c, -c.width / 2, -c.height / 2)
    return o
  }

  /* Recorta el rectángulo del VIN y lo agranda mucho.

     Tesseract lee mal el texto pequeño: por debajo de unos 40 píxeles de
     alto por carácter empieza a inventar, y una foto a un metro deja el VIN
     en 15. Se lleva el recorte a unos 1200 píxeles de ancho, que para
     diecisiete caracteres deja cada uno con altura de sobra. Se guía por el
     ancho y no por el alto: son diecisiete repartidos a lo ancho. */
  function recortarYAmpliar (im, caja, ancho) {
    const W = anchoDe(im), H = altoDe(im)
    const sx = Math.max(0, Math.round(caja.x * W))
    const sy = Math.max(0, Math.round(caja.y * H))
    const sw = Math.max(8, Math.min(W - sx, Math.round(caja.w * W)))
    const sh = Math.max(8, Math.min(H - sy, Math.round(caja.h * H)))
    const escala = Math.max(1, Math.min(8, (ancho || 1200) / sw))
    const c = lienzo(sw * escala, sh * escala)
    const g = c.getContext('2d')
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    g.drawImage(im, sx, sy, sw, sh, 0, 0, c.width, c.height)
    return c
  }

  const aGris = c => {
    const g = c.getContext('2d')
    const d = g.getImageData(0, 0, c.width, c.height)
    const p = d.data
    for (let i = 0; i < p.length; i += 4) {
      const v = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0
      p[i] = p[i + 1] = p[i + 2] = v
    }
    g.putImageData(d, 0, 0)
    return d
  }

  /* Otsu: parte el histograma por donde mejor separa el fondo del texto. Un
     umbral fijo no vale porque cada foto trae su propio brillo. */
  function umbralOtsu (datos) {
    const h = new Array(256).fill(0)
    for (let i = 0; i < datos.length; i += 4) h[datos[i]]++
    const total = datos.length / 4
    let suma = 0
    for (let i = 0; i < 256; i++) suma += i * h[i]
    let sumaB = 0, wB = 0, mejor = 0, umbral = 128
    for (let i = 0; i < 256; i++) {
      wB += h[i]; if (!wB) continue
      const wF = total - wB; if (!wF) break
      sumaB += i * h[i]
      const mB = sumaB / wB, mF = (suma - sumaB) / wF
      const entre = wB * wF * (mB - mF) * (mB - mF)
      if (entre > mejor) { mejor = entre; umbral = i }
    }
    return umbral
  }

  /* Cuánto está torcido el texto, en grados.

     Una foto hecha a pulso sale siempre unos grados girada, y ahí el lector
     se desploma: en las pruebas acertaba 1 de 6 con tres grados frente a 5
     de 6 con la imagen recta. Se prueba a girar en pasos de medio grado y se
     mide lo "rayada" que queda la imagen por filas: con el renglón
     horizontal las filas de letras salen muy oscuras y las de entre líneas
     muy claras, y esa diferencia es máxima.

     Sobre la imagen ya en blanco y negro: sobre el gris, una placa con poco
     contraste da un máximo falso y sale girada de más. */
  function estimarInclinacion (datos, w, h) {
    const u = umbralOtsu(datos)
    const bin = new Float32Array(w * h)
    for (let i = 0, j = 0; j < bin.length; i += 4, j++) bin[j] = datos[i] > u ? 0 : 1
    let mejorAng = 0, mejorVar = -1, varRecta = 0
    for (let g = -7; g <= 7; g += 0.5) {
      const tan = Math.tan(g * Math.PI / 180)
      const filas = new Float32Array(h)
      for (let y = 0; y < h; y += 2) {
        let suma = 0
        for (let x = 0; x < w; x += 2) {
          const yy = y + Math.round((x - w / 2) * tan)
          if (yy >= 0 && yy < h) suma += bin[yy * w + x]
        }
        filas[y] = suma
      }
      let media = 0, n = 0
      for (let y = 0; y < h; y += 2) { media += filas[y]; n++ }
      media /= n
      let varia = 0
      for (let y = 0; y < h; y += 2) varia += (filas[y] - media) * (filas[y] - media)
      if (Math.abs(g) < 0.01) varRecta = varia
      if (varia > mejorVar) { mejorVar = varia; mejorAng = g }
    }
    /* Si girar no mejora de forma clara, no se gira: cada giro vuelve a
       interpolar los píxeles y emborrona un poco los caracteres. */
    return mejorVar > varRecta * 1.08 ? mejorAng : 0
  }

  function colorDeBorde (c) {
    const w = c.width, h = c.height
    const d = c.getContext('2d').getImageData(0, 0, w, h).data
    let r = 0, v = 0, a = 0, n = 0
    const mirar = (x, y) => { const i = (y * w + x) * 4; r += d[i]; v += d[i + 1]; a += d[i + 2]; n++ }
    for (let x = 0; x < w; x += 3) { mirar(x, 0); mirar(x, h - 1) }
    for (let y = 0; y < h; y += 3) { mirar(0, y); mirar(w - 1, y) }
    return `rgb(${Math.round(r / n)},${Math.round(v / n)},${Math.round(a / n)})`
  }

  /* El lienzo crece para que el giro no corte las esquinas, y se rellena con
     el color del propio borde y no con blanco: con blanco, el giro dejaba
     cuatro cuñas sobre una placa gris que el umbral tomaba por manchas
     pegadas al texto, y los aciertos con la imagen torcida caían de 5 a 2. */
  function enderezar (c, grados) {
    if (Math.abs(grados) < 0.5) return c
    const r = grados * Math.PI / 180
    const sen = Math.abs(Math.sin(r)), cos = Math.abs(Math.cos(r))
    const o = lienzo(c.width * cos + c.height * sen, c.width * sen + c.height * cos)
    const g = o.getContext('2d')
    g.fillStyle = colorDeBorde(c)
    g.fillRect(0, 0, o.width, o.height)
    g.translate(o.width / 2, o.height / 2)
    g.rotate(-r)
    g.imageSmoothingQuality = 'high'
    g.drawImage(c, -c.width / 2, -c.height / 2)
    return o
  }

  /* Realza los bordes antes de umbralizar. Un número grabado en metal tiene
     muy poco contraste con el metal de al lado; sin esto, Otsu parte por un
     sitio cualquiera y se lleva medio carácter. */
  function enfocar (c) {
    const g = c.getContext('2d')
    const d = g.getImageData(0, 0, c.width, c.height)
    const src = new Uint8ClampedArray(d.data)
    const w = c.width, h = c.height
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4
        const v = src[i] * 5 - (src[i - 4] + src[i + 4] + src[i - w * 4] + src[i + w * 4])
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v
      }
    }
    g.putImageData(d, 0, 0)
    return c
  }

  /* Umbral local: cada píxel se compara con la media de su vecindad.

     Otsu parte la imagen por un único valor, y eso se rompe en cuanto la
     placa está medio iluminada y medio en sombra —lo normal dentro de un
     auto—. Aquí el corte se recalcula en cada punto. La suma acumulada
     permite pedir la media de cualquier ventana de una vez; sin eso esto no
     corre en un teléfono. */
  function umbralLocal (datos, w, h) {
    const suma = new Float64Array((w + 1) * (h + 1))
    for (let y = 0; y < h; y++) {
      let fila = 0
      for (let x = 0; x < w; x++) {
        fila += datos[(y * w + x) * 4]
        suma[(y + 1) * (w + 1) + x + 1] = suma[y * (w + 1) + x + 1] + fila
      }
    }
    const r = Math.max(8, Math.round(h / 3))
    const salida = new Uint8ClampedArray(datos.length)
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r)
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r)
        const total = suma[(y1 + 1) * (w + 1) + x1 + 1] - suma[y0 * (w + 1) + x1 + 1] -
                      suma[(y1 + 1) * (w + 1) + x0] + suma[y0 * (w + 1) + x0]
        const media = total / ((y1 - y0 + 1) * (x1 - x0 + 1))
        const i = (y * w + x) * 4
        /* El 6% de margen evita que el grano del metal, que ronda la media,
           salga convertido en un enjambre de puntos negros. */
        const v = datos[i] < media * 0.94 ? 0 : 255
        salida[i] = salida[i + 1] = salida[i + 2] = v
        salida[i + 3] = 255
      }
    }
    return salida
  }

  /* Suaviza el grano y estira el contraste.

     Es la versión para la placa apagada: letras grises sobre metal gris, que
     es la que más fallaba. El grano del metal, a esa escala, pesa tanto como
     el trazo de la letra; difuminarlo un poco antes de estirar hace que lo
     que se estira sea la letra y no el ruido. */
  function suaveYEstirado (datos, w, h) {
    const a = new Float32Array(w * h)
    for (let i = 0, j = 0; j < a.length; i += 4, j++) a[j] = datos[i]
    const b = new Float32Array(w * h)
    for (let pasada = 0; pasada < 2; pasada++) {
      const src = pasada ? b : a, dst = pasada ? a : b
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let s = 0, n = 0
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= h) continue
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= w) continue
              s += src[yy * w + xx]; n++
            }
          }
          dst[y * w + x] = s / n
        }
      }
    }
    const orden = Array.from(a).sort((p, q) => p - q)
    const lo = orden[Math.floor(orden.length * 0.02)], hi = orden[Math.floor(orden.length * 0.98)]
    const k = hi > lo ? 255 / (hi - lo) : 1
    const salida = new Uint8ClampedArray(w * h * 4)
    for (let j = 0, i = 0; j < a.length; j++, i += 4) {
      const v = (a[j] - lo) * k
      salida[i] = salida[i + 1] = salida[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v
      salida[i + 3] = 255
    }
    return salida
  }

  /* Varias versiones de la misma banda. Una placa puede venir con letras
     oscuras sobre metal claro o al revés según le dé la luz, y probar varias
     cuesta un segundo y evita fallar por completo. Van en el orden en que
     más aciertan: si las primeras ya coinciden, las demás no se gastan. */
  function variantes (c) {
    const w = c.width, h = c.height
    const base = lienzo(w, h)
    base.getContext('2d').drawImage(c, 0, 0)
    const datos = aGris(base)

    const nitido = lienzo(w, h)
    nitido.getContext('2d').putImageData(datos, 0, 0)
    enfocar(nitido)

    const u = umbralOtsu(datos.data)
    const binaria = invertir => {
      const o = lienzo(w, h)
      const g = o.getContext('2d')
      const d = g.createImageData(w, h)
      for (let i = 0; i < datos.data.length; i += 4) {
        let v = datos.data[i] > u ? 255 : 0
        if (invertir) v = 255 - v
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v
        d.data[i + 3] = 255
      }
      g.putImageData(d, 0, 0)
      return o
    }
    const local = lienzo(w, h)
    local.getContext('2d').putImageData(new ImageData(umbralLocal(datos.data, w, h), w, h), 0, 0)
    const suave = lienzo(w, h)
    suave.getContext('2d').putImageData(new ImageData(suaveYEstirado(datos.data, w, h), w, h), 0, 0)

    return [base, nitido, local, suave, binaria(false), binaria(true)]
  }

  /* ---------------- Validar ---------------- */

  const VIN_PESOS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]
  const VIN_VALOR = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3,
                      M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 }
  const VIN_VERIF_OK = '0123456789X'

  /* El dígito verificador sólo es obligatorio en Norteamérica.

     Un Toyota, un VW o un BMW traídos de Japón o de Europa llevan en esa
     posición lo que al fabricante le convenga, y no cuadra; en Brisbane es
     media flota. Cuando cuadrar sumaba muchos puntos, ante un
     WVWZZZ1JZXW000010 el lector prefería una cadena inventada que cuadrase.
     Así que pesa poco, y reescribir caracteres para hacerlo cuadrar sólo se
     hace con los que están obligados: la región 1 a 5. */
  const esNorteamericano = v => !!v && '12345'.indexOf(v[0]) >= 0

  function arreglarVerificador (v) {
    if (v.length !== 17 || !esNorteamericano(v) || VIN_VERIF_OK.indexOf(v[8]) >= 0) return v
    let suma = 0
    for (let i = 0; i < 17; i++) {
      if (i === 8) continue
      const n = VIN_VALOR[v[i]]
      if (n == null) return v
      suma += n * VIN_PESOS[i]
    }
    const r = suma % 11
    return v.slice(0, 8) + (r === 10 ? 'X' : String(r)) + v.slice(9)
  }

  function verificadorOk (v) {
    if (!v || v.length !== 17) return null
    let suma = 0
    for (let i = 0; i < 17; i++) {
      const c = v[i]
      const n = c >= '0' && c <= '9' ? Number(c) : VIN_VALOR[c]
      if (n === undefined) return false
      suma += n * VIN_PESOS[i]
    }
    const r = suma % 11
    return v[8] === (r === 10 ? 'X' : String(r))
  }

  /* Las parejas que el lector confunde de verdad. */
  const PARECIDOS = { '1': 'L', L: '1', '8': 'B', B: '8', '5': 'S', S: '5',
                      '2': 'Z', Z: '2', '0': 'D', D: '0', '6': 'G', G: '6',
                      '7': 'T', T: '7', '4': 'A', A: '4' }
  const parecidos = (a, b) => a === b || PARECIDOS[a] === b ||
    (a === '0' && (b === 'U' || b === 'C')) || (b === '0' && (a === 'U' || a === 'C'))

  /* Los cuatro últimos van en cifras.

     La norma lo exige a todo fabricante de más de quinientos vehículos al
     año, que en la práctica es cualquier auto que llegue a un lavado. Así
     que una letra ahí es un error de lectura seguro, y si se parece a una
     cifra —una B a un 8, una S a un 5— se sabe cuál era. Es justo donde se
     equivocaba con los "últimos seis", que es lo que más se mira. */
  const DIGITO_DE = { B: '8', S: '5', Z: '2', D: '0', G: '6', T: '7', A: '4', L: '1', U: '0', C: '0', J: '1' }
  function cifrasAlFinal (v) {
    if (!v || v.length !== 17) return v
    let s = v.slice(0, 13)
    for (let i = 13; i < 17; i++) s += /[0-9]/.test(v[i]) ? v[i] : (DIGITO_DE[v[i]] || v[i])
    return s
  }

  function corregirConVerificador (vin) {
    if (!vin || vin.length !== 17 || !esNorteamericano(vin) || verificadorOk(vin)) return null
    const buenas = []
    for (let i = 0; i < 17; i++) {
      const alt = PARECIDOS[vin[i]]
      if (!alt) continue
      const prueba = vin.slice(0, i) + alt + vin.slice(i + 1)
      if (verificadorOk(prueba)) buenas.push(prueba)
    }
    return buenas.length === 1 ? buenas[0] : null
  }

  /* El verificador cuadra por casualidad una de cada once veces, y la
     primera prueba real lo demostró: una lectura completamente equivocada lo
     pasó. Así que se puntúa con todo lo que se sabe de un VIN. */
  const ANOS_VIN = 'ABCDEFGHJKLMNPRSTVWXY123456789'
  function puntuar (v, confianza) {
    if (!v) return -1
    let p = 0
    if (v.length === 17) p += 40
    if (esNorteamericano(v) && verificadorOk(v) === true) p += 8
    if (v.length === 17 && (ANOS_VIN.includes(v[9]) || !esNorteamericano(v))) p += 10
    if (v.length === 17 && /^[0-9]{4}$/.test(v.slice(-4))) p += 6
    if (v.length === 17 && (v.slice(-6).match(/[0-9]/g) || []).length >= 5) p += 4
    const cifras = (v.match(/[0-9]/g) || []).length
    if (cifras >= 4 && cifras <= 13) p += 15
    p += Math.round((confianza || 0) / 10)
    return p
  }

  /* De un texto sucio, sacar lo que puede ser un chasis. Las placas suelen
     imprimir el número entre asteriscos —*VIN*— y eso es la pista más fiable
     que hay en la imagen. */
  function candidatosDe (texto) {
    const bruto = (texto || '').toUpperCase()
    const fuera = []
    for (const m of bruto.match(/\*([A-Z0-9\s]{10,25})\*/g) || []) fuera.push({ s: m.replace(/\*/g, ''), premio: 30 })
    const limpio = bruto.replace(/[^A-Z0-9\s]/g, ' ')
    for (const t of limpio.split(/\s+/)) if (t.length >= 11) fuera.push({ s: t, premio: 0 })
    const pegado = limpio.replace(/\s+/g, '')
    for (let i = 0; i + 17 <= pegado.length; i++) fuera.push({ s: pegado.slice(i, i + 17), premio: 0 })
    return fuera.map(c => ({
      vin: c.s.replace(/[^A-Z0-9]/g, '').replace(/[IOQ]/g, x => (x === 'I' ? '1' : '0')),
      premio: c.premio
    })).filter(c => c.vin.length >= 11)
  }

  function mejorCandidato (texto, confianza) {
    let mejor = null
    for (const c of candidatosDe(texto)) {
      c.vin = cifrasAlFinal(arreglarVerificador(c.vin))
      const arreglado = c.vin.length === 17 ? corregirConVerificador(c.vin) : null
      const v = arreglado || c.vin
      const p = puntuar(v, confianza) + c.premio
      if (!mejor || p > mejor.puntos) mejor = { vin: v, puntos: p, corregido: arreglado ? c.vin : null, confianza }
    }
    return mejor
  }

  /* La lectura carácter a carácter, con lo segura que estaba de cada uno y
     qué otras letras se planteó. Es la diferencia entre saber que puso una B
     y saber que puso una B dudando entre B y 8. */
  function lecturaPorSimbolos (data) {
    const sim = (data && data.symbols) || []
    if (!sim.length) return null
    const utiles = sim
      .map(x => ({
        t: (x.text || '').trim().toUpperCase(),
        c: x.confidence || 0,
        alt: (x.choices || []).map(y => (y.text || '').trim().toUpperCase())
          .filter(y => y.length === 1 && VIN_ALFABETO.indexOf(y) >= 0)
      }))
      .filter(x => x.t.length === 1 && (VIN_ALFABETO + '*').indexOf(x.t) >= 0)
    while (utiles.length && utiles[0].t === '*') utiles.shift()
    while (utiles.length && utiles[utiles.length - 1].t === '*') utiles.pop()
    if (utiles.length !== 17 || utiles.some(x => x.t === '*')) return null
    return { vin: utiles.map(x => x.t).join(''), confs: utiles.map(x => x.c), alts: utiles.map(x => x.alt) }
  }

  /* Junta lo que dijeron todas las lecturas y decide carácter a carácter.

     Cada pasada se equivoca en sitios distintos y rara vez todas en el
     mismo. Se vota posición por posición, con el peso de lo segura que
     estaba cada una, y el resultado es mejor que cualquier lectura suelta.
     Antes se descartan las que hablan de otra cosa: basta una que se coma un
     carácter para comparar la letra 5 de una con la 6 de otra. */
  function consenso (cands) {
    let largos = cands.filter(c => c.vin.length === 17)
    if (largos.length < 3) return null
    const patron = largos.reduce((a, b) => (b.puntos > a.puntos ? b : a))
    const distancia = v => { let d = 0; for (let i = 0; i < 17; i++) if (v[i] !== patron.vin[i]) d++; return d }
    largos = largos.filter(c => distancia(c.vin) <= 6)
    if (largos.length < 3) return null

    const votos = []
    for (let i = 0; i < 17; i++) {
      const m = new Map()
      for (const c of largos) {
        /* Acotado entre uno y dos: con la confianza en bruto, una sola
           pasada muy segura y equivocada se imponía a tres correctas. Las
           lecturas de la cámara en vivo pesan menos: son fotogramas más
           pequeños y movidos, sirven para desempatar. */
        const peso = (1 + (c.confs ? c.confs[i] : Math.min(100, c.puntos)) / 100) * (c.vivo ? 0.6 : 1)
        m.set(c.vin[i], (m.get(c.vin[i]) || 0) + peso)
        for (const a of (c.alts ? c.alts[i] : [])) if (a !== c.vin[i]) m.set(a, (m.get(a) || 0) + 0.05)
      }
      let orden = [...m.entries()].sort((a, b) => b[1] - a[1])
      /* La décima es el año y en Norteamérica la norma sólo admite ahí unos
         pocos caracteres: lo que no cabe se descarta antes de contar. Sólo
         allí: un Toyota hecho para Australia lleva un 0 en esa posición
         (JTNK43BF303135104), y con la regla para todos el lector cambiaba
         ese 0 por la primera letra que se le ocurriera. */
      if (i === 9 && esNorteamericano(patron.vin)) {
        const validos = orden.filter(x => ANOS_VIN.indexOf(x[0]) >= 0)
        if (validos.length) orden = validos
      }
      /* Las cuatro últimas son cifras: el voto de una letra que se parece a
         una cifra pasa a esa cifra, y las letras que no se parecen a
         ninguna dejan de contar si hay alguna cifra votada. */
      if (i >= 13) {
        const n = new Map()
        for (const [ch, w] of orden) {
          const d = /[0-9]/.test(ch) ? ch : DIGITO_DE[ch]
          if (d) n.set(d, (n.get(d) || 0) + (d === ch ? w : w * 0.9))
        }
        if (n.size) orden = [...n.entries()].sort((a, b) => b[1] - a[1])
      }
      votos.push(orden)
    }
    return {
      votos,
      vin: votos.map(v => v[0][0]).join(''),
      alternativas: votos.map(v => v.slice(0, 3).map(x => x[0]))
    }
  }

  /* Cuánto se pusieron de acuerdo las lecturas sobre ESTE número, de 0 a
     100. Es más honrado que la confianza que declara una pasada: con la
     imagen binarizada esa cifra baja aunque acierte, y se llegó a ver
     "seguridad 34%" junto a un chasis perfecto. */
  function acuerdoDe (votos, vin) {
    if (!votos || vin.length !== 17) return null
    let suma = 0
    for (let i = 0; i < 17; i++) {
      const total = votos[i].reduce((a, b) => a + b[1], 0)
      const mio = (votos[i].find(x => x[0] === vin[i]) || [null, 0])[1]
      suma += total ? mio / total : 0
    }
    return Math.round(suma / 17 * 100)
  }

  /* Prueba las posiciones dudosas hasta que cuadre el verificador. Sólo se
     tocan las posiciones donde la votación estuvo dividida, así que no se
     acaba inventando un VIN cualquiera que dé el visto bueno. */
  function afinarConVotos (vin, alternativas) {
    if (!esNorteamericano(vin)) return null
    if (verificadorOk(vin)) return vin
    const dudosas = []
    for (let i = 0; i < 17; i++) {
      if (i === 8) continue
      const otras = (alternativas[i] || []).filter(c => c !== vin[i])
      if (otras.length) dudosas.push({ i, otras })
    }
    if (!dudosas.length || dudosas.length > 8) return null
    let hallado = null, cuantos = 0
    const probar = (k, actual) => {
      if (hallado || cuantos > 4000) return
      if (k === dudosas.length) { cuantos++; if (verificadorOk(actual)) hallado = actual; return }
      probar(k + 1, actual)
      for (const ch of dudosas[k].otras) {
        probar(k + 1, actual.slice(0, dudosas[k].i) + ch + actual.slice(dudosas[k].i + 1))
        if (hallado) return
      }
    }
    probar(0, vin)
    return hallado
  }

  /* ---------------- Leer ---------------- */

  /* Varias formas de mirar la misma imagen: 7 = una línea de texto,
     13 = una línea en crudo, 6 = un bloque. Cuál acierta depende de si el
     número lleva separaciones y de lo que pilló el recorte. */
  const VIN_MODOS = ['7', '13', '6']

  async function pasada (worker, im, modo) {
    await worker.setParameters({ tessedit_char_whitelist: VIN_ALFABETO + '*', tessedit_pageseg_mode: modo })
    const { data } = await worker.recognize(im, {}, { text: true, blocks: true })
    const bruto = ((data && data.text) || '').trim()
    const c = mejorCandidato(bruto, data && data.confidence)
    if (c) {
      const sim = lecturaPorSimbolos(data)
      /* Sólo si coinciden: si el candidato salió de otro trozo del texto,
         las confianzas serían de caracteres distintos. */
      if (sim && cifrasAlFinal(sim.vin) === c.vin) { c.confs = sim.confs; c.alts = sim.alts }
    }
    return { c, bruto: bruto.replace(/\s+/g, ' ') }
  }

  function prepararRecorte (im, caja, ancho) {
    const r = recortarYAmpliar(im, caja || { x: 0, y: 0, w: 1, h: 1 }, ancho)
    /* Enderezar va antes que todo lo demás: si la imagen está girada, el
       umbral y el lector trabajan ya con las letras cortadas. */
    const g = aGris(r)
    return enderezar(r, estimarInclinacion(g.data, r.width, r.height))
  }

  /* Una lectura rápida, para la cámara en vivo: una sola pasada sobre la
     imagen tal cual. No decide nada; sirve para pintar el marco y, sobre
     todo, como voto extra para la lectura de verdad. */
  /* Cada fotograma con una forma de mirar distinta: "una línea" falla en
     cuanto entra en el marco otro renglón de la placa, y "un bloque" falla
     con el VIN solo. Alternando, ninguno de los dos casos se queda sin
     lectura, y cada fotograma cuesta lo mismo que antes. */
  const MODOS_VIVO = ['7', '6', '13']
  let _vuelta = 0
  function leerRapido (fuente, caja) {
    return enFila(async () => {
      const worker = await obtenerWorker()
      _listo = true
      const im = await cargarImagen(fuente)
      const r = prepararRecorte(im, caja, 900)
      const { c, bruto } = await pasada(worker, r, MODOS_VIVO[_vuelta++ % MODOS_VIVO.length])
      return c ? Object.assign(c, { leido: bruto, vivo: true }) : { vin: null, leido: bruto }
    })
  }

  /* La lectura de verdad.

     previas: lo que leyó la cámara mientras se apuntaba. Cada fotograma es
     una mirada distinta a la misma placa —otra luz, otro reflejo—, y
     votando junto a las pasadas de la foto final se corrige justo lo que
     una sola foto no puede. */
  function leer (fuente, caja, opc) {
    opc = opc || {}
    return enFila(async () => {
      const worker = await obtenerWorker()
      _listo = true
      const im = await cargarImagen(fuente)
      const recorte = prepararRecorte(im, caja, 1200)
      const imagenes = variantes(recorte)
      const todos = (opc.previas || []).filter(c => c && c.vin && c.vin.length === 17)
      const leido = []
      const total = imagenes.length * VIN_MODOS.length
      let hechas = 0

      /* Cuando la foto sale bien no hace falta gastar todas las pasadas: si
         cuatro de esta foto coinciden letra por letra y además dan un VIN
         creíble, no hay nada que discutir, y seguir sólo añade segundos de
         espera a alguien que está terminando un auto. */
      const yaEstaClaro = () => {
        const l = todos.filter(c => !c.vivo && c.vin.length === 17)
        if (l.length < 4) return false
        if (!l.every(c => c.vin === l[0].vin)) return false
        return !esNorteamericano(l[0].vin) || verificadorOk(l[0].vin)
      }

      for (const modo of VIN_MODOS) {
        if (yaEstaClaro()) break
        for (const im2 of imagenes) {
          const { c, bruto } = await pasada(worker, im2, modo)
          if (bruto) leido.push(bruto)
          if (c) todos.push(c)
          hechas++
          if (opc.alProgresar) opc.alProgresar(hechas / total)
          if (yaEstaClaro()) break
        }
      }

      let mejor = null
      for (const c of todos) if (!c.vivo && (!mejor || c.puntos > mejor.puntos)) mejor = c
      const cons = consenso(todos)
      if (cons) {
        const base = cifrasAlFinal(arreglarVerificador(cons.vin))
        const afinado = afinarConVotos(base, cons.alternativas) || corregirConVerificador(base)
        const vin = afinado || base
        const p = puntuar(vin, mejor ? mejor.confianza : null)
        /* Estrictamente mejor: cuando una sola pasada sale limpia y las
           demás a medias, empatar y sustituirla la estropea. */
        if (!mejor || p > mejor.puntos) {
          mejor = { vin, puntos: p, corregido: afinado && afinado !== cons.vin ? cons.vin : null }
        }
        const a = acuerdoDe(cons.votos, mejor.vin)
        if (a != null) mejor.confianza = a
      }
      const crudo = Array.from(new Set(leido)).slice(0, 6).join(' | ')
      if (!mejor) return { vin: null, leido: crudo }
      return {
        vin: mejor.vin,
        confianza: mejor.confianza == null ? null : Math.round(mejor.confianza),
        corregido: mejor.corregido || null,
        semaforo: semaforo(mejor.vin),
        leido: crudo
      }
    })
  }

  /* Dónde está el VIN en una foto entera, y en qué posición está la foto.

     Una foto de la galería no tiene marco: puede ser la placa de cerca, el
     interior de la puerta entero o la foto hecha con el teléfono de lado. Se
     le pide al lector que busque texto suelto por toda la foto y se queda el
     renglón que más parece un VIN. Si en la posición original no hay
     ninguno, se prueba con la foto de lado, que es el fallo más corriente. */
  function localizar (fuente, posiciones) {
    return enFila(async () => {
      const worker = await obtenerWorker()
      _listo = true
      const im = await cargarImagen(fuente)
      const base = aLienzo(im, 1600)
      let mejor = null
      for (const q of posiciones || [0, 1, 3]) {
        const c = girarCuartos(base, q)
        await worker.setParameters({ tessedit_char_whitelist: VIN_ALFABETO + '*', tessedit_pageseg_mode: '11' })
        const { data } = await worker.recognize(c, {}, { text: true, blocks: true })
        for (const bl of (data && data.blocks) || []) {
          for (const pa of bl.paragraphs || []) {
            for (const li of pa.lines || []) {
              const k = mejorCandidato(li.text, li.confidence)
              const bb = li.bbox
              if (!k || !bb || k.vin.length < 14) continue
              /* Un VIN es un renglón ancho y bajo; uno alto es basura que el
                 lector juntó en vertical. */
              if ((bb.x1 - bb.x0) < (bb.y1 - bb.y0) * 3) continue
              /* El renglón que más parece un VIN, no el que da diecisiete
                 caracteres: en la misma placa "VEHICLE IDENTIFICATION"
                 también da diecisiete letras, y con la foto un poco
                 torcida el renglón del VIN sale con uno de menos. Aquí se
                 busca sitio, no lectura, así que cuenta la forma: que
                 acabe en cifras, que mezcle letras y cifras, que vaya
                 entre asteriscos y que pase el semáforo si está entero. */
              const v = k.vin
              const cifras = (v.match(/[0-9]/g) || []).length
              const p = (v.length >= 16 ? 20 : 10) +
                (/[0-9]{4}$/.test(v) ? 30 : 0) +
                (cifras >= 4 && cifras <= 13 ? 15 : 0) +
                (/\*/.test(li.text) ? 20 : 0) +
                (v.length === 17 ? ({ verde: 25, ambar: 0, rojo: -20 })[semaforo(v)] : 0) +
                Math.round((li.confidence || 0) / 10)
              if (!mejor || p > mejor.p) {
                const mw = (bb.x1 - bb.x0) * 0.06, mh = (bb.y1 - bb.y0) * 0.45
                const x = Math.max(0, bb.x0 - mw), y = Math.max(0, bb.y0 - mh)
                mejor = {
                  p, cuartos: q, vin: k.vin,
                  caja: {
                    x: x / c.width, y: y / c.height,
                    w: Math.min(c.width - x, bb.x1 - bb.x0 + 2 * mw) / c.width,
                    h: Math.min(c.height - y, bb.y1 - bb.y0 + 2 * mh) / c.height
                  }
                }
              }
            }
          }
        }
        if (mejor && mejor.vin.length === 17 && mejor.p >= 90) break
      }
      return mejor
    })
  }

  /* Sin pantalla: buscar y leer. Lo usa la app de Registro VIN para las
     fotos que se guardaron deprisa sin leer. */
  async function leerFotoEntera (fuente, opc) {
    const im = await cargarImagen(fuente)
    const base = aLienzo(im, 2000)
    const sitio = await localizar(base)
    if (!sitio) return { vin: null, leido: '' }
    const r = await leer(girarCuartos(base, sitio.cuartos), sitio.caja, opc)
    return Object.assign(r, { cuartos: sitio.cuartos, caja: sitio.caja })
  }

  /* ---------------- Semáforo ----------------

     De cuánto fiarse de un chasis:
       verde  región conocida, los cuatro últimos en cifras, y si es
              norteamericano también año válido y verificador
       ambar  algo no encaja: mirarlo
       rojo   eso no puede ser un VIN
     Es un filtro de verosimilitud, no una prueba. */
  const VIN_REGIONES = '123458JKLMNPRSVWXYZ6'
  function semaforo (v) {
    if (!v || !/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return 'rojo'
    if (VIN_REGIONES.indexOf(v[0]) < 0) return 'rojo'
    /* El año en la décima sólo es obligatorio en Norteamérica: un Toyota
       japonés para Australia lleva ahí un 0 y está bien. */
    if (esNorteamericano(v) && ANOS_VIN.indexOf(v[9]) < 0) return 'ambar'
    if (!/^[0-9]{4}$/.test(v.slice(-4))) return 'ambar'
    /* El número de serie, los seis últimos, va casi todo en cifras: BMW
       pone una letra delante (…W05633) y nadie más. Texto suelto de la
       placa que el lector juntó en diecisiete caracteres —"…GVM 2150"—
       también acaba en cuatro cifras, y esto es lo que lo delata. */
    if ((v.slice(-6).match(/[0-9]/g) || []).length < 5) return 'ambar'
    if (esNorteamericano(v)) return verificadorOk(v) ? 'verde' : 'ambar'
    return 'verde'
  }

  const limpiarVin = v => (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    .replace(/[IOQ]/g, c => (c === 'I' ? '1' : '0')).slice(0, 17)

  /* ---------------- Autos ya vistos ----------------

     El lector se equivoca en caracteres parecidos —una B por un 8, una S por
     un 5—, y casi siempre en un auto que ya pasó por aquí o que es de la
     misma tanda. Así que se compara con lo conocido:

     · el mismo VIN casi exacto: se propone el conocido, y además se avisa
       de que ya se registró;
     · los últimos seis iguales: si la lectura salió entera mal pero la cola,
       que es lo más grande y legible, salió bien;
     · la misma tanda: en el aeropuerto llegan muchos autos del mismo modelo
       seguidos y comparten los once primeros caracteres; sólo cambia el
       número de serie. Si el principio se parece a uno ya visto, se
       completa con él.

     Nunca se cambia nada en silencio: se enseña qué caracteres se tocaron,
     y se puede volver a lo que leyó. */
  const HIST = 'lectorvin_historial'
  const DIAS_HIST = 60
  function historial () {
    try {
      const h = JSON.parse(localStorage.getItem(HIST) || '[]')
      const corte = Date.now() - DIAS_HIST * 864e5
      return Array.isArray(h) ? h.filter(x => x && x.vin && x.t > corte) : []
    } catch (e) { return [] }
  }
  function recordar (vin) {
    vin = limpiarVin(vin)
    if (vin.length !== 17) return
    try {
      const h = historial().filter(x => x.vin !== vin)
      h.unshift({ vin, t: Date.now() })
      localStorage.setItem(HIST, JSON.stringify(h.slice(0, 400)))
    } catch (e) {}
  }

  function coste (a, b) {
    let d = 0
    for (let i = 0; i < 17; i++) d += a[i] === b[i] ? 0 : parecidos(a[i], b[i]) ? 0.4 : 1
    return d
  }
  function soloParecidos (a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !parecidos(a[i], b[i])) return false
    return true
  }
  function cambiosEntre (a, b) {
    const c = []
    for (let i = 0; i < 17; i++) if (a[i] !== b[i]) c.push(i)
    return c
  }

  function emparejar (leido, conocidos) {
    leido = limpiarVin(leido)
    const lista = []
    const vistos = new Set()
    for (const k of conocidos || []) {
      const vin = limpiarVin(typeof k === 'string' ? k : k.vin)
      if (vin.length !== 17 || vistos.has(vin)) continue
      vistos.add(vin)
      lista.push({ vin, cuando: k.cuando || k.t || null, donde: k.donde || null })
    }
    if (!lista.length || leido.length < 6) return null

    if (leido.length === 17) {
      const exacto = lista.find(k => k.vin === leido)
      if (exacto) return { tipo: 'exacto', vin: leido, conocido: exacto, cambios: [] }
      const orden = lista.map(k => ({ k, d: coste(leido, k.vin) })).sort((a, b) => a.d - b.d)
      const [a, b] = orden
      /* Sólo si TODO lo que cambia son parejas que el lector confunde —una
         B por un 8, una S por un 5—, como mucho dos, y sin otro conocido
         igual de cerca. Nunca un carácter cualquiera: en una tanda los
         números de serie van seguidos, y un auto nuevo que termina en
         ...105 no puede acabar "corregido" al ...104 que ya pasó. */
      if (a.d <= 0.8 && soloParecidos(leido, a.k.vin) && (!b || b.d - a.d >= 0.6)) {
        return { tipo: 'parecido', vin: a.k.vin, conocido: a.k, cambios: cambiosEntre(leido, a.k.vin) }
      }
    }

    const cola = leido.slice(-6)
    if (/^[0-9]{6}$/.test(cola)) {
      const mismos = lista.filter(k => k.vin.slice(-6) === cola)
      if (mismos.length === 1 && (leido.length < 17 || coste(leido, mismos[0].vin) <= 2.5)) {
        return { tipo: 'cola', vin: mismos[0].vin, conocido: mismos[0],
                 cambios: leido.length === 17 ? cambiosEntre(leido, mismos[0].vin) : [] }
      }
    }

    if (leido.length === 17 && /^[0-9]{4}$/.test(leido.slice(-4))) {
      const prefijos = new Map()
      for (const k of lista) {
        const p = k.vin.slice(0, 11)
        if (!prefijos.has(p)) prefijos.set(p, k)
      }
      const orden = [...prefijos.entries()]
        .map(([p, k]) => ({ p, k, d: coste(leido.slice(0, 11) + '000000', p + '000000') }))
        .sort((a, b) => a.d - b.d)
      const [a, b] = orden
      /* Igual que arriba: sólo parejas confundibles. Una letra distinta en
         el principio puede ser otra versión del modelo, y esa no se toca. */
      if (a && a.d > 0 && a.d <= 0.8 && soloParecidos(leido.slice(0, 11), a.p) && (!b || b.d - a.d >= 0.6)) {
        const vin = a.p + leido.slice(11)
        return { tipo: 'tanda', vin, conocido: a.k, cambios: cambiosEntre(leido, vin) }
      }
    }
    return null
  }

  /* ---------------- Pantalla ---------------- */

  const TEXTOS = {
    es: {
      cerrar: 'Cerrar', marco: 'Pon el VIN dentro del marco', marco2: 'En horizontal, que llene el marco',
      preparando: 'Preparando el lector…', buscando: 'Buscando…', linterna: 'Linterna',
      galeria: 'Galería', capturar: 'Capturar', zoom: 'Zoom',
      sinCamara: 'No se pudo abrir la cámara aquí.', permiso: 'Hay que permitir la cámara para escanear. También puedes usar la cámara del teléfono.',
      camaraTel: 'Usar la cámara del teléfono',
      titulo: 'Revisa el VIN', otraFoto: 'Otra foto', girar: 'Girar', enderezar: 'Enderezar',
      ayudaRecuadro: 'El recuadro debe encerrar sólo el VIN. Arrastra sus esquinas; con dos dedos, zoom.',
      leyendo: 'Leyendo…', cargando: 'Preparando el lector (sólo la primera vez)…',
      buscandoFoto: 'Buscando el VIN en la foto…',
      noEncontrado: 'No encontré el VIN en la foto. Pon el recuadro sobre el número.',
      noLeido: 'No se pudo leer. Ajusta el recuadro o gira la foto, o escríbelo.',
      sinRed: 'Falta descargar el lector: conéctate a internet una vez y vuelve a intentarlo.',
      vin: 'VIN', usar: 'Usar este VIN', soloFoto: 'Guardar sólo la foto', releer: 'Leer de nuevo',
      verde: 'Parece correcto', ambar: 'Revísalo', rojo: 'No es un VIN', vacio: 'Sin VIN',
      acuerdo: 'acuerdo {n}%',
      exacto: 'Este VIN ya se vio el {f}.',
      parecido: 'Corregido con un auto ya visto ({n}).',
      cola: 'Completado con un auto ya visto que termina igual.',
      tanda: 'Mismo modelo que otro auto: se completó el principio ({n}).',
      deshacer: 'Volver a lo leído', escrito: 'Has escrito el VIN a mano. El lector leyó {v}.', usarLeido: 'Usar lo leído',
      vertical: 'La foto está vertical: si el VIN se ve de lado, pulsa Girar.',
      caracteres: '{n} carácter', caracteresN: '{n} caracteres'
    },
    en: {
      cerrar: 'Close', marco: 'Fit the VIN inside the frame', marco2: 'Horizontal, filling the frame',
      preparando: 'Getting the reader ready…', buscando: 'Looking…', linterna: 'Torch',
      galeria: 'Gallery', capturar: 'Capture', zoom: 'Zoom',
      sinCamara: 'The camera could not be opened here.', permiso: 'Allow the camera to scan. You can also use the phone camera.',
      camaraTel: 'Use the phone camera',
      titulo: 'Check the VIN', otraFoto: 'Another photo', girar: 'Rotate', enderezar: 'Straighten',
      ayudaRecuadro: 'The box must hold only the VIN. Drag its corners; two fingers to zoom.',
      leyendo: 'Reading…', cargando: 'Getting the reader ready (first time only)…',
      buscandoFoto: 'Looking for the VIN in the photo…',
      noEncontrado: 'Could not find the VIN in the photo. Put the box over the number.',
      noLeido: 'Could not read it. Adjust the box or rotate the photo, or type it.',
      sinRed: 'The reader still needs downloading: connect to the internet once and try again.',
      vin: 'VIN', usar: 'Use this VIN', soloFoto: 'Save the photo only', releer: 'Read again',
      verde: 'Looks right', ambar: 'Check it', rojo: 'Not a VIN', vacio: 'No VIN',
      acuerdo: 'agreement {n}%',
      exacto: 'This VIN was already seen on {f}.',
      parecido: 'Corrected with a car already seen ({n}).',
      cola: 'Completed with a car already seen that ends the same.',
      tanda: 'Same model as another car: the start was completed ({n}).',
      deshacer: 'Back to what was read', escrito: 'You typed the VIN. The reader read {v}.', usarLeido: 'Use what was read',
      vertical: 'The photo is portrait: if the VIN is sideways, tap Rotate.',
      caracteres: '{n} character', caracteresN: '{n} characters'
    }
  }

  const ICONOS = {
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    luz: '<path d="M9 2h6l-1 7h-4L9 2z"/><path d="M10 9v11a2 2 0 004 0V9"/>',
    gal: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>',
    girar: '<path d="M4 12a8 8 0 108-8H8"/><path d="M11 1L8 4l3 3"/>',
    menos: '<path d="M5 12h14"/>', mas: '<path d="M5 12h14M12 5v14"/>',
    cam: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="4"/>',
    leer: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'
  }
  const icono = n => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[n]}</svg>`

  const CSS = `
.lv{position:fixed;inset:0;z-index:2147483000;background:#000;color:#fff;display:flex;flex-direction:column;
  font-family:inherit;-webkit-tap-highlight-color:transparent;overscroll-behavior:contain;touch-action:none}
.lv *{box-sizing:border-box}
.lv [hidden]{display:none!important}
:where(.lv) button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;-webkit-appearance:none}
.lv-bar{position:absolute;left:0;right:0;display:flex;align-items:center;gap:10px;padding:12px 14px;z-index:3}
.lv-top{top:0;padding-top:max(12px,env(safe-area-inset-top))}
.lv-ib{width:46px;height:46px;border-radius:50%;background:rgba(0,0,0,.5);display:grid;place-items:center;flex:none}
.lv-ib[aria-pressed=true]{background:#fff;color:#000}
.lv-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:center}
.lv-marco{position:absolute;left:50%;transform:translateX(-50%);border:3px solid rgba(255,255,255,.9);border-radius:12px;
  box-shadow:0 0 0 100vmax rgba(0,0,0,.55);transition:border-color .2s;z-index:1}
.lv-marco[data-s=verde]{border-color:#3ddc6a}.lv-marco[data-s=ambar]{border-color:#ffc23d}.lv-marco[data-s=rojo]{border-color:#ff5a4f}
.lv-guia{position:absolute;left:0;right:0;text-align:center;z-index:2;padding:0 20px;text-shadow:0 1px 3px #000}
.lv-guia b{display:block;font-size:18px}.lv-guia span{font-size:14px;opacity:.85}
.lv-vivo{position:absolute;left:0;right:0;text-align:center;z-index:2;padding:0 12px}
.lv-vivo code{display:inline-block;font:600 20px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.06em;
  background:rgba(0,0,0,.6);padding:6px 10px;border-radius:8px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv-chip{display:inline-block;margin-top:6px;font-size:13px;font-weight:700;padding:4px 10px;border-radius:999px;background:#555;color:#fff}
.lv-chip[data-s=verde]{background:#1f9d4c}.lv-chip[data-s=ambar]{background:#c98a00}.lv-chip[data-s=rojo]{background:#d23b32}
.lv-bajo{bottom:0;flex-direction:column;align-items:stretch;padding-bottom:max(16px,env(safe-area-inset-bottom));
  background:linear-gradient(transparent,rgba(0,0,0,.75) 30%)}
.lv-zoom{display:flex;align-items:center;gap:10px;padding:0 6px 10px;font-size:13px}
.lv-zoom input{flex:1;accent-color:var(--lv-acento,#3fa939)}
.lv-fila{display:flex;align-items:center;justify-content:space-between}
.lv-disp{width:78px;height:78px;border-radius:50%;background:#fff;border:5px solid rgba(255,255,255,.35);background-clip:padding-box;
  box-shadow:0 0 0 2px #fff inset;flex:none}
.lv-disp:active{transform:scale(.94)}
.lv-lado{width:78px;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:12px}
.lv-aviso{position:absolute;left:16px;right:16px;top:30%;z-index:4;background:#1c1f1d;border-radius:14px;padding:18px;text-align:center}
.lv-aviso p{margin:0 0 14px;line-height:1.45}
.lv-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:50px;border-radius:12px;
  font-weight:700;font-size:16px;padding:0 14px;background:var(--lv-acento,#3fa939);color:#fff}
.lv-btn.sec{background:#2a2e2c;color:#fff}
.lv-btn:disabled{opacity:.45}
.lv-ed{background:#0e110f}
.lv-cab{display:flex;align-items:center;gap:10px;padding:10px 12px;padding-top:max(10px,env(safe-area-inset-top));flex:none}
.lv-cab h2{flex:1;margin:0;font-size:17px}
.lv-cab .lv-mini{background:#2a2e2c;border-radius:10px;padding:10px 12px;font-weight:600;font-size:14px;display:flex;gap:6px;align-items:center}
.lv-escena{position:relative;flex:1;min-height:170px;background:#000;overflow:hidden}
.lv-escena canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
.lv-estado{position:absolute;left:10px;right:10px;bottom:10px;text-align:center;font-size:14px;pointer-events:none}
.lv-estado span{background:rgba(0,0,0,.7);padding:6px 10px;border-radius:8px;display:inline-block}
.lv-barra{height:3px;background:rgba(255,255,255,.15);position:absolute;left:0;right:0;bottom:0}
.lv-barra i{display:block;height:100%;width:0;background:var(--lv-acento,#3fa939);transition:width .2s}
.lv-herr{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:none;flex-wrap:nowrap}
.lv-herr .lv-mini{background:#2a2e2c;border-radius:10px;min-height:42px;padding:0 12px;display:flex;gap:6px;align-items:center;font-weight:600;font-size:14px;flex:none}
.lv-herr label{flex:1;min-width:0;font-size:12px;opacity:.85;display:flex;flex-direction:column;gap:2px}
.lv-herr input{width:100%;accent-color:var(--lv-acento,#3fa939);margin:0}
.lv-panel{flex:none;max-height:52%;overflow-y:auto;padding:4px 14px max(14px,env(safe-area-inset-bottom));touch-action:pan-y;
  background:#0e110f;border-top:1px solid #222}
.lv-ayuda{font-size:12.5px;opacity:.7;margin:2px 0 8px;line-height:1.4}
.lv-campo{width:100%;font:600 21px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.07em;text-transform:uppercase;
  background:#181c1a;color:#fff;border:2px solid #333;border-radius:12px;padding:12px;outline:none}
.lv-campo:focus{border-color:var(--lv-acento,#3fa939)}
.lv-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 2px;font-size:13px;opacity:.95}
.lv-nota{font-size:13px;line-height:1.45;margin:6px 0;padding:8px 10px;border-radius:10px;background:#1b2a1f}
.lv-nota.ojo{background:#33280f}
.lv-nota a{color:inherit;font-weight:700;text-decoration:underline;cursor:pointer;margin-left:4px}
.lv-nota mark{background:#ffc23d;color:#000;border-radius:3px;padding:0 1px}
.lv-vin{font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.05em}
.lv-acciones{display:flex;flex-direction:column;gap:8px;margin-top:10px}
@media (min-width:700px){.lv-panel{max-height:46%}.lv-acciones{flex-direction:row}}
`
  let _css = false
  function ponerCss () {
    if (_css) return
    _css = true
    const s = document.createElement('style')
    s.textContent = CSS
    document.head.appendChild(s)
  }

  const fechaCorta = t => {
    if (!t) return ''
    const d = new Date(t)
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  }

  /* abrir(opciones) → Promise<resultado | null>

       fuente: 'camara' | 'galeria'
       archivo: File | Blob | dataURL — una foto ya elegida (va al editor)
       conocidos: [{ vin, cuando }] o una función que los devuelve (puede
                  ser async): autos ya vistos, para corregir y avisar
       permitirSoloFoto: enseña "Guardar sólo la foto"
       idioma: 'es' | 'en'

     resultado: { vin, semaforo, confianza, foto, recorte, emparejado, soloFoto } */
  function abrir (opc) {
    opc = opc || {}
    ponerCss()
    precargar()
    const L = TEXTOS[opc.idioma] || TEXTOS.es
    const tx = (k, vars) => (L[k] || TEXTOS.es[k] || k).replace(/\{(\w+)\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : ''))

    let conocidos = []
    Promise.resolve(typeof opc.conocidos === 'function' ? opc.conocidos() : opc.conocidos)
      .then(l => { conocidos = (l || []).concat(historial().map(h => ({ vin: h.vin, cuando: h.t }))) })
      .catch(() => { conocidos = historial().map(h => ({ vin: h.vin, cuando: h.t })) })

    const raiz = document.createElement('div')
    raiz.className = 'lv'
    raiz.setAttribute('role', 'dialog')
    raiz.setAttribute('aria-modal', 'true')
    document.body.appendChild(raiz)
    const scrollPrevio = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    let terminar
    const promesa = new Promise(r => { terminar = r })
    let cerrado = false
    let limpiar = () => {}

    const cerrar = valor => {
      if (cerrado) return
      cerrado = true
      limpiar()
      raiz.remove()
      document.body.style.overflow = scrollPrevio
      terminar(valor || null)
    }

    /* ----- Elegir una foto de la galería ----- */
    const elegirFoto = () => {
      const inp = document.createElement('input')
      inp.type = 'file'
      inp.accept = 'image/*'
      inp.onchange = () => { const f = inp.files && inp.files[0]; if (f) editor(f, { buscar: true }) }
      inp.click()
    }
    const camaraNativa = () => {
      const inp = document.createElement('input')
      inp.type = 'file'
      inp.accept = 'image/*'
      inp.setAttribute('capture', 'environment')
      inp.onchange = () => { const f = inp.files && inp.files[0]; if (f) editor(f, { buscar: true }) }
      inp.click()
    }

    /* ======================= CÁMARA ======================= */
    function camara () {
      limpiar()
      raiz.className = 'lv'
      raiz.innerHTML = `
        <video class="lv-video" playsinline muted autoplay></video>
        <div class="lv-marco" data-s=""></div>
        <div class="lv-guia"><b>${tx('marco')}</b><span>${tx('marco2')}</span></div>
        <div class="lv-vivo"><code>${tx('preparando')}</code><br><span class="lv-chip" hidden></span></div>
        <div class="lv-bar lv-top">
          <button class="lv-ib" data-a="x" aria-label="${tx('cerrar')}">${icono('x')}</button>
          <span style="flex:1"></span>
          <button class="lv-ib" data-a="luz" aria-label="${tx('linterna')}" aria-pressed="false" hidden>${icono('luz')}</button>
        </div>
        <div class="lv-bar lv-bajo">
          <div class="lv-zoom" hidden><span>${tx('zoom')}</span><input type="range" min="1" max="4" step="0.1" value="1" aria-label="${tx('zoom')}"><span class="lv-zv">1×</span></div>
          <div class="lv-fila">
            <button class="lv-lado" data-a="gal">${icono('gal')}<span>${tx('galeria')}</span></button>
            <button class="lv-disp" data-a="disp" aria-label="${tx('capturar')}"></button>
            <span class="lv-lado"></span>
          </div>
        </div>`
      const $ = s => raiz.querySelector(s)
      const video = $('video'), marco = $('.lv-marco'), guia = $('.lv-guia'), vivo = $('.lv-vivo')
      const code = vivo.querySelector('code'), chip = vivo.querySelector('.lv-chip')
      let stream = null, track = null, zoomHw = null, zoomDig = 1, vivoActivo = true, ocupado = false
      let previas = [], ultimo = null, avisado = false, tempo = null

      /* El marco: ancho de casi toda la pantalla y bajo, como un VIN. La
         gente lo llena acercándose o con el zoom; un marco más alto dejaría
         entrar los renglones de arriba y abajo, que es lo que más confunde
         al lector. */
      const colocar = () => {
        const W = raiz.clientWidth, H = raiz.clientHeight
        const w = Math.min(W * 0.9, 620), h = Math.max(54, Math.round(w * 0.2))
        const top = Math.round(H * 0.4 - h / 2)
        Object.assign(marco.style, { width: w + 'px', height: h + 'px', top: top + 'px' })
        guia.style.top = Math.max(70, top - 64) + 'px'
        vivo.style.top = (top + h + 12) + 'px'
      }
      colocar()
      window.addEventListener('resize', colocar)

      /* Lo que el marco tapa, en coordenadas del vídeo: el vídeo se pinta
         "cubriendo" la pantalla y con el zoom digital además se agranda. */
      const cajaDelMarco = (alto) => {
        const vw = video.videoWidth, vh = video.videoHeight
        if (!vw || !vh) return null
        const W = raiz.clientWidth, H = raiz.clientHeight
        const s = Math.max(W / vw, H / vh) * zoomDig
        const ox = (W - vw * s) / 2, oy = (H - vh * s) / 2
        const r = marco.getBoundingClientRect(), rr = raiz.getBoundingClientRect()
        /* Un poco más que el marco: nadie centra el VIN al milímetro, y una
           letra cortada por el borde es una letra mal leída. Lo que entra
           de más a los lados lo descarta el propio lector. */
        let w = r.width / s, h = r.height / s
        const mv = alto == null ? 0.15 : alto
        let x = (r.left - rr.left - ox) / s - w * 0.07, y = (r.top - rr.top - oy) / s - h * mv
        w *= 1.14; h *= 1 + 2 * mv
        x = Math.max(0, x); y = Math.max(0, y)
        return { x: x / vw, y: y / vh, w: Math.min(1 - x / vw, w / vw), h: Math.min(1 - y / vh, h / vh) }
      }

      const fotograma = () => {
        const c = lienzo(video.videoWidth, video.videoHeight)
        c.getContext('2d').drawImage(video, 0, 0)
        return c
      }
      /* En vivo se copia sólo lo que hay dentro del marco: copiar el
         fotograma entero tres veces por segundo son megas de memoria que un
         teléfono modesto acaba notando. */
      const trozo = caja => recortarYAmpliar(video, caja, 900)

      /* Verde sólo cuando el mismo VIN sale en dos de las últimas cuatro
         lecturas: una sola puede ser casualidad. Y un fotograma que no lee
         nada no borra lo último bueno; si no, el número parpadea mientras
         se apunta y no hay forma de saber cuándo capturar. */
      const recientes = []
      let fallidas = 0
      const pintar = (vin, leidoTxt) => {
        recientes.push(vin && vin.length === 17 ? vin : null)
        if (recientes.length > 4) recientes.shift()
        if (!(vin && vin.length >= 11)) {
          if (++fallidas < 3 && ultimo) return
        } else fallidas = 0
        if (vin && vin.length >= 11) {
          code.textContent = vin
          const s = vin.length === 17 ? semaforo(vin) : 'rojo'
          const estable = recientes.filter(x => x === vin).length >= 2
          const color = s === 'verde' && !estable ? 'ambar' : s
          marco.dataset.s = color
          chip.hidden = false
          chip.dataset.s = color
          chip.textContent = tx(color)
          if (color === 'verde' && !avisado) { avisado = true; try { navigator.vibrate && navigator.vibrate(35) } catch (e) {} }
          if (color !== 'verde') avisado = false
          ultimo = vin
        } else {
          code.textContent = leidoTxt ? leidoTxt.slice(0, 20) : tx('buscando')
          marco.dataset.s = leidoTxt ? 'rojo' : ''
          chip.hidden = true
          ultimo = null
          avisado = false
        }
      }

      /* Lee lo que hay en el marco cada poco, sin amontonar: si el
         teléfono va lento, simplemente lee menos veces. */
      const bucle = async () => {
        if (!vivoActivo || cerrado) return
        if (!ocupado && !document.hidden && video.videoWidth) {
          /* En vivo, sin margen por arriba y por abajo: lo que entra de
             más ahí son otros renglones, y a una lectura rápida la lían. */
          const caja = cajaDelMarco(0)
          if (caja) {
            ocupado = true
            try {
              const r = await leerRapido(trozo(caja))
              if (!vivoActivo) return
              if (r && r.vin && r.vin.length === 17) {
                previas.push(r)
                if (previas.length > 10) previas.shift()
              }
              pintar(r && r.vin, r && r.leido)
            } catch (e) {
              if (e && e.message === 'SIN_LECTOR') code.textContent = tx('sinRed')
            }
            ocupado = false
          }
        }
        tempo = setTimeout(bucle, 350)
      }

      const ponerZoom = z => {
        $('.lv-zv').textContent = (+z).toFixed(1) + '×'
        if (zoomHw) {
          track.applyConstraints({ advanced: [{ zoom: +z }] }).catch(() => {})
        } else {
          zoomDig = +z
          video.style.transform = `scale(${zoomDig})`
        }
      }

      const aviso = (msg) => {
        const a = document.createElement('div')
        a.className = 'lv-aviso'
        a.innerHTML = `<p>${msg}</p>
          <button class="lv-btn" data-a="nativa">${icono('cam')}${tx('camaraTel')}</button>
          <div style="height:8px"></div>
          <button class="lv-btn sec" data-a="gal">${icono('gal')}${tx('galeria')}</button>`
        raiz.appendChild(a)
      }

      const arrancar = async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { aviso(tx('sinCamara')); return }
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
          })
        } catch (e) {
          aviso(e && e.name === 'NotAllowedError' ? tx('permiso') : tx('sinCamara'))
          return
        }
        if (cerrado) { stream.getTracks().forEach(t => t.stop()); return }
        video.srcObject = stream
        try { await video.play() } catch (e) {}
        track = stream.getVideoTracks()[0]
        const cap = track && track.getCapabilities ? track.getCapabilities() : {}
        if (cap.torch) $('[data-a=luz]').hidden = false
        const zin = $('.lv-zoom input')
        if (cap.zoom && cap.zoom.max > cap.zoom.min) {
          zoomHw = cap.zoom
          zin.min = cap.zoom.min; zin.max = Math.min(cap.zoom.max, 8); zin.step = cap.zoom.step || 0.1
          zin.value = (track.getSettings && track.getSettings().zoom) || cap.zoom.min
          $('.lv-zv').textContent = (+zin.value).toFixed(1) + '×'
        }
        $('.lv-zoom').hidden = false
        bucle()
      }

      raiz.onclick = e => {
        const b = e.target.closest('[data-a]')
        if (!b) return
        const a = b.dataset.a
        if (a === 'x') cerrar(null)
        else if (a === 'gal') elegirFoto()
        else if (a === 'nativa') camaraNativa()
        else if (a === 'luz') {
          const on = b.getAttribute('aria-pressed') !== 'true'
          track.applyConstraints({ advanced: [{ torch: on }] })
            .then(() => b.setAttribute('aria-pressed', String(on))).catch(() => {})
        } else if (a === 'disp') {
          if (!video.videoWidth) return
          const caja = cajaDelMarco()
          const foto = fotograma()
          try { navigator.vibrate && navigator.vibrate(20) } catch (e) {}
          editor(foto, { caja, previas: previas.slice() })
        }
      }
      $('.lv-zoom input').oninput = e => ponerZoom(e.target.value)

      limpiar = () => {
        vivoActivo = false
        clearTimeout(tempo)
        window.removeEventListener('resize', colocar)
        if (stream) stream.getTracks().forEach(t => t.stop())
        stream = null
      }
      arrancar()
    }

    /* ======================= EDITOR ======================= */
    async function editor (fuente, o) {
      limpiar()
      o = o || {}
      raiz.className = 'lv lv-ed'
      raiz.innerHTML = `
        <div class="lv-cab">
          <button class="lv-ib" data-a="x" aria-label="${tx('cerrar')}">${icono('x')}</button>
          <h2>${tx('titulo')}</h2>
          <button class="lv-mini" data-a="otra">${icono('cam')}${tx('otraFoto')}</button>
        </div>
        <div class="lv-escena"><canvas></canvas>
          <div class="lv-estado" hidden><span></span></div>
          <div class="lv-barra" hidden><i></i></div>
        </div>
        <div class="lv-herr">
          <button class="lv-mini" data-a="girar">${icono('girar')}${tx('girar')}</button>
          <label><span class="lv-endtxt">${tx('enderezar')} 0°</span>
            <input type="range" min="-30" max="30" step="1" value="0" aria-label="${tx('enderezar')}"></label>
          <button class="lv-mini" data-a="zmenos" aria-label="−">${icono('menos')}</button>
          <button class="lv-mini" data-a="zmas" aria-label="+">${icono('mas')}</button>
        </div>
        <div class="lv-panel">
          <p class="lv-ayuda">${tx('ayudaRecuadro')}</p>
          <input class="lv-campo" maxlength="17" autocomplete="off" autocapitalize="characters" autocorrect="off"
                 spellcheck="false" aria-label="${tx('vin')}" placeholder="${tx('vin')}">
          <div class="lv-meta"><span class="lv-n">0/17</span><span class="lv-chip" hidden></span><span class="lv-conf"></span></div>
          <div class="lv-notas"></div>
          <div class="lv-acciones">
            <button class="lv-btn" data-a="usar" disabled>${tx('usar')}</button>
            ${opc.permitirSoloFoto ? `<button class="lv-btn sec" data-a="solo">${tx('soloFoto')}</button>` : ''}
            <button class="lv-btn sec" data-a="releer">${icono('leer')}${tx('releer')}</button>
          </div>
        </div>`
      const $ = s => raiz.querySelector(s)
      const cv = $('canvas'), escena = $('.lv-escena'), campo = $('.lv-campo')
      const estado = $('.lv-estado'), barra = $('.lv-barra')

      let base
      try { base = aLienzo(await cargarImagen(fuente), 2400) } catch (e) { cerrar(null); return }
      if (cerrado) return
      let cuartos = 0, grados = 0, trabajo = base
      let caja = null                // en píxeles de "trabajo"
      let vista = { s: 1, ox: 0, oy: 0, s0: 1 }
      let lectura = null             // lo último que leyó el lector
      let emparejado = null
      let aMano = false
      let turno = 0
      let previas = o.previas || []

      const cajaPorDefecto = () => {
        const w = trabajo.width * 0.84
        const h = Math.min(trabajo.height * 0.2, w * 0.18)
        return { x: (trabajo.width - w) / 2, y: (trabajo.height - h) / 2, w, h }
      }
      const cajaDeFraccion = f => ({ x: f.x * trabajo.width, y: f.y * trabajo.height, w: f.w * trabajo.width, h: f.h * trabajo.height })
      const fraccion = () => ({ x: caja.x / trabajo.width, y: caja.y / trabajo.height, w: caja.w / trabajo.width, h: caja.h / trabajo.height })

      /* Al abrir, la foto se ve encuadrada en el VIN y no entera: lo que se
         revisa es el número, y en una foto entera el recuadro se ve del
         tamaño de un dedo. */
      const encajar = (enCaja) => {
        const W = escena.clientWidth, H = escena.clientHeight
        const s0 = Math.min(W / trabajo.width, H / trabajo.height)
        vista.s0 = s0
        if (enCaja && caja) {
          const s = Math.min(s0 * 6, Math.max(s0, Math.min(W * 0.92 / caja.w, H * 0.5 / caja.h)))
          vista.s = s
          vista.ox = W / 2 - (caja.x + caja.w / 2) * s
          vista.oy = H / 2 - (caja.y + caja.h / 2) * s
        } else {
          vista.s = s0
          vista.ox = (W - trabajo.width * s0) / 2
          vista.oy = (H - trabajo.height * s0) / 2
        }
        dibujar()
      }

      const color = () => {
        const v = limpiarVin(campo.value)
        return v.length === 17 ? semaforo(v) : ''
      }

      const dibujar = () => {
        const dpr = window.devicePixelRatio || 1
        const W = escena.clientWidth, H = escena.clientHeight
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
          cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr)
        }
        const g = cv.getContext('2d')
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.fillStyle = '#000'
        g.fillRect(0, 0, W, H)
        g.imageSmoothingQuality = 'high'
        g.drawImage(trabajo, vista.ox, vista.oy, trabajo.width * vista.s, trabajo.height * vista.s)
        if (!caja) return
        const x = vista.ox + caja.x * vista.s, y = vista.oy + caja.y * vista.s
        const w = caja.w * vista.s, h = caja.h * vista.s
        /* Dónde está el recuadro en pantalla, para la prueba automática. */
        cv.dataset.caja = [x, y, w, h].map(Math.round).join(',')
        g.fillStyle = 'rgba(0,0,0,.55)'
        g.beginPath()
        g.rect(0, 0, W, H)
        g.rect(x, y, w, h)
        g.fill('evenodd')
        const c = { verde: '#3ddc6a', ambar: '#ffc23d', rojo: '#ff5a4f' }[color()] || '#fff'
        g.strokeStyle = c
        g.lineWidth = 2
        g.strokeRect(x, y, w, h)
        g.lineWidth = 5
        const L2 = Math.min(22, w / 3, h / 1.5)
        for (const [px, py, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
          g.beginPath()
          g.moveTo(px + dx * L2, py); g.lineTo(px, py); g.lineTo(px, py + dy * L2)
          g.stroke()
        }
      }

      const rehacerTrabajo = (resetCaja) => {
        const fr = caja && !resetCaja ? fraccion() : null
        trabajo = enderezar(girarCuartos(base, cuartos), -grados)
        caja = fr ? cajaDeFraccion(fr) : cajaPorDefecto()
        encajar(true)
      }

      /* ----- Notas, semáforo, botones ----- */
      const marcar = (vin, cambios) => {
        const set = new Set(cambios || [])
        return vin.split('').map((ch, i) => set.has(i) ? `<mark>${ch}</mark>` : ch).join('')
      }
      const pintarPanel = () => {
        const v = limpiarVin(campo.value)
        $('.lv-n').textContent = v.length + '/17'
        const chip = $('.lv-chip')
        const s = v.length === 17 ? semaforo(v) : (v.length ? 'rojo' : '')
        chip.hidden = !v.length
        chip.dataset.s = s
        chip.textContent = v.length ? tx(s === 'rojo' && v.length < 17 ? 'vacio' : s) : ''
        if (v.length && v.length < 17) chip.textContent = v.length + '/17'
        $('.lv-conf').textContent = lectura && lectura.confianza != null && v === lectura.vin
          ? tx('acuerdo', { n: lectura.confianza }) : ''
        $('[data-a=usar]').disabled = v.length < 11
        const notas = []
        if (emparejado && v === emparejado.vin) {
          const n = emparejado.cambios.length
          const nn = tx(n === 1 ? 'caracteres' : 'caracteresN', { n })
          if (emparejado.tipo === 'exacto') {
            notas.push(`<div class="lv-nota ojo">${tx('exacto', { f: fechaCorta(emparejado.conocido.cuando) || '—' })}</div>`)
          } else {
            const k = { parecido: 'parecido', cola: 'cola', tanda: 'tanda' }[emparejado.tipo]
            notas.push(`<div class="lv-nota">${tx(k, { n: nn })}
              <div class="lv-vin" style="margin-top:4px">${marcar(emparejado.vin, emparejado.cambios)}</div>
              ${lectura && lectura.vin && lectura.vin !== emparejado.vin ? `<a data-a="deshacer">${tx('deshacer')}</a>` : ''}</div>`)
          }
        }
        if (aMano && lectura && lectura.vin && lectura.vin !== v) {
          notas.push(`<div class="lv-nota ojo">${tx('escrito', { v: `<span class="lv-vin">${lectura.vin}</span>` })}
            <a data-a="usarleido">${tx('usarLeido')}</a></div>`)
        }
        if (o.mensaje) notas.push(`<div class="lv-nota ojo">${o.mensaje}</div>`)
        $('.lv-notas').innerHTML = notas.join('')
        dibujar()
      }

      const mostrarEstado = (txt, progreso) => {
        estado.hidden = !txt
        estado.querySelector('span').textContent = txt || ''
        barra.hidden = progreso == null
        if (progreso != null) barra.querySelector('i').style.width = Math.round(progreso * 100) + '%'
      }

      /* Lee lo que hay en el recuadro. Si mientras tanto se movió el
         recuadro o se giró la foto, el resultado viejo se tira: hablaría de
         otro trozo de la foto. */
      const releer = async () => {
        if (!caja) return
        const mio = ++turno
        mostrarEstado(_listo ? tx('leyendo') : tx('cargando'), 0)
        try {
          const r = await leer(trabajo, fraccion(), {
            previas,
            alProgresar: p => { if (mio === turno) mostrarEstado(tx('leyendo'), p) }
          })
          if (mio !== turno || cerrado) return
          mostrarEstado(null)
          /* Lo leído en vivo vale para la primera lectura; si la persona
             movió el recuadro es porque la cámara apuntaba mal. */
          previas = []
          if (!r || !r.vin) { o.mensaje = tx('noLeido'); lectura = null; pintarPanel(); return }
          o.mensaje = null
          lectura = r
          emparejado = emparejar(r.vin, conocidos)
          if (!aMano) campo.value = emparejado ? emparejado.vin : r.vin
          pintarPanel()
        } catch (e) {
          if (mio !== turno) return
          mostrarEstado(null)
          o.mensaje = e && e.message === 'SIN_LECTOR' ? tx('sinRed') : tx('noLeido')
          pintarPanel()
        }
      }
      let espera = null
      const releerLuego = () => { clearTimeout(espera); espera = setTimeout(releer, 450) }

      /* Tras girar la foto, el recuadro de antes ya no señala nada: se
         vuelve a buscar dónde quedó el VIN en vez de dejar un recuadro en
         el centro, que suele caer sobre otro renglón de la placa. */
      const buscarYLeer = async () => {
        clearTimeout(espera)
        const mio = ++turno
        mostrarEstado(tx('buscandoFoto'), null)
        try {
          const sitio = await localizar(trabajo, [0])
          if (mio !== turno || cerrado) return
          if (sitio) { caja = cajaDeFraccion(sitio.caja); acotar(); encajar(true) }
        } catch (e) {}
        if (mio === turno && !cerrado) releer()
      }

      /* ----- Tocar: mover el recuadro, estirar sus esquinas, arrastrar la
         foto o pellizcar para el zoom ----- */
      const punteros = new Map()
      let gesto = null
      const enImagen = (px, py) => ({ x: (px - vista.ox) / vista.s, y: (py - vista.oy) / vista.s })
      const local = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
      const queToca = p => {
        if (!caja) return 'pan'
        const x = vista.ox + caja.x * vista.s, y = vista.oy + caja.y * vista.s
        const w = caja.w * vista.s, h = caja.h * vista.s
        const R = 30
        const cerca = (a, b) => Math.abs(a - b) < R
        if (cerca(p.x, x) && cerca(p.y, y)) return 'nw'
        if (cerca(p.x, x + w) && cerca(p.y, y)) return 'ne'
        if (cerca(p.x, x) && cerca(p.y, y + h)) return 'sw'
        if (cerca(p.x, x + w) && cerca(p.y, y + h)) return 'se'
        if (p.x > x && p.x < x + w && cerca(p.y, y)) return 'n'
        if (p.x > x && p.x < x + w && cerca(p.y, y + h)) return 's'
        if (p.y > y && p.y < y + h && cerca(p.x, x)) return 'w'
        if (p.y > y && p.y < y + h && cerca(p.x, x + w)) return 'e'
        if (p.x > x && p.x < x + w && p.y > y && p.y < y + h) return 'mover'
        return 'pan'
      }
      const acotar = () => {
        const minW = 30, minH = 10
        caja.w = Math.max(minW, Math.min(caja.w, trabajo.width))
        caja.h = Math.max(minH, Math.min(caja.h, trabajo.height))
        caja.x = Math.max(0, Math.min(caja.x, trabajo.width - caja.w))
        caja.y = Math.max(0, Math.min(caja.y, trabajo.height - caja.h))
      }
      const zoomEn = (factor, cx, cy) => {
        const s = Math.max(vista.s0 * 0.8, Math.min(vista.s0 * 10, vista.s * factor))
        const k = s / vista.s
        vista.ox = cx - (cx - vista.ox) * k
        vista.oy = cy - (cy - vista.oy) * k
        vista.s = s
        dibujar()
      }

      cv.onpointerdown = e => {
        try { cv.setPointerCapture(e.pointerId) } catch (x) {}
        punteros.set(e.pointerId, local(e))
        if (punteros.size === 2) {
          const [a, b] = [...punteros.values()]
          gesto = { tipo: 'pellizco', d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, s: vista.s, ox: vista.ox, oy: vista.oy }
        } else if (punteros.size === 1) {
          const p = local(e)
          gesto = { tipo: queToca(p), p0: p, c0: caja && Object.assign({}, caja), ox: vista.ox, oy: vista.oy }
        }
      }
      cv.onpointermove = e => {
        if (!punteros.has(e.pointerId) || !gesto) return
        punteros.set(e.pointerId, local(e))
        if (gesto.tipo === 'pellizco' && punteros.size >= 2) {
          const [a, b] = [...punteros.values()]
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
          const s = Math.max(vista.s0 * 0.8, Math.min(vista.s0 * 10, gesto.s * d / gesto.d))
          vista.s = s
          vista.ox = m.x - (gesto.m.x - gesto.ox) * s / gesto.s
          vista.oy = m.y - (gesto.m.y - gesto.oy) * s / gesto.s
          dibujar()
          return
        }
        const p = local(e)
        const dx = (p.x - gesto.p0.x) / vista.s, dy = (p.y - gesto.p0.y) / vista.s
        if (gesto.tipo === 'pan') {
          vista.ox = gesto.ox + (p.x - gesto.p0.x)
          vista.oy = gesto.oy + (p.y - gesto.p0.y)
          dibujar()
          return
        }
        const c0 = gesto.c0
        const t = gesto.tipo
        if (t === 'mover') { caja.x = c0.x + dx; caja.y = c0.y + dy }
        else {
          let x0 = c0.x, y0 = c0.y, x1 = c0.x + c0.w, y1 = c0.y + c0.h
          if (t.includes('w')) x0 = Math.min(x1 - 30, c0.x + dx)
          if (t.includes('e')) x1 = Math.max(x0 + 30, x1 + dx)
          if (t.includes('n')) y0 = Math.min(y1 - 10, c0.y + dy)
          if (t.includes('s')) y1 = Math.max(y0 + 10, y1 + dy)
          caja.x = x0; caja.y = y0; caja.w = x1 - x0; caja.h = y1 - y0
        }
        acotar()
        dibujar()
        gesto.movio = true
      }
      const soltar = e => {
        punteros.delete(e.pointerId)
        if (gesto && gesto.movio && gesto.tipo !== 'pan' && gesto.tipo !== 'pellizco') releerLuego()
        if (punteros.size === 1) {
          const p = [...punteros.values()][0]
          gesto = { tipo: 'pan', p0: p, ox: vista.ox, oy: vista.oy }
        } else if (!punteros.size) gesto = null
      }
      cv.onpointerup = soltar
      cv.onpointercancel = soltar
      cv.onwheel = e => {
        e.preventDefault()
        const p = local(e)
        zoomEn(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y)
      }

      const rango = $('.lv-herr input')
      let esperaGiro = null
      rango.oninput = () => {
        grados = +rango.value
        $('.lv-endtxt').textContent = `${tx('enderezar')} ${grados}°`
        clearTimeout(esperaGiro)
        esperaGiro = setTimeout(() => { rehacerTrabajo(false); releerLuego() }, 160)
      }
      campo.oninput = () => {
        const limpio = limpiarVin(campo.value)
        if (campo.value !== limpio) campo.value = limpio
        aMano = true
        pintarPanel()
      }

      raiz.onclick = e => {
        const b = e.target.closest('[data-a]')
        if (!b) return
        const a = b.dataset.a
        if (a === 'x') cerrar(null)
        else if (a === 'otra') { if (o.desdeGaleria) elegirFoto(); else camara() }
        else if (a === 'girar') { cuartos = (cuartos + 1) % 4; previas = []; rehacerTrabajo(true); buscarYLeer() }
        else if (a === 'zmas') zoomEn(1.4, escena.clientWidth / 2, escena.clientHeight / 2)
        else if (a === 'zmenos') zoomEn(1 / 1.4, escena.clientWidth / 2, escena.clientHeight / 2)
        else if (a === 'releer') { aMano = false; releer() }
        else if (a === 'deshacer') { campo.value = lectura.vin; emparejado = null; pintarPanel() }
        else if (a === 'usarleido') { campo.value = lectura.vin; aMano = false; emparejado = emparejar(lectura.vin, conocidos); if (emparejado) campo.value = emparejado.vin; pintarPanel() }
        else if (a === 'usar' || a === 'solo') {
          const v = a === 'solo' ? '' : limpiarVin(campo.value)
          if (v.length === 17) recordar(v)
          const foto = aLienzo(trabajo, 1600).toDataURL('image/jpeg', 0.8)
          const rc = caja ? recortarYAmpliar(trabajo, fraccion(), 900).toDataURL('image/jpeg', 0.85) : null
          cerrar({
            vin: v || null,
            semaforo: v.length === 17 ? semaforo(v) : null,
            confianza: lectura && v === lectura.vin ? lectura.confianza : null,
            leido: lectura ? lectura.vin : null,
            emparejado: emparejado && v === emparejado.vin ? emparejado : null,
            soloFoto: a === 'solo',
            foto, recorte: rc
          })
        }
      }

      const alCambiarTamano = () => encajar(true)
      window.addEventListener('resize', alCambiarTamano)
      limpiar = () => { turno++; clearTimeout(espera); clearTimeout(esperaGiro); window.removeEventListener('resize', alCambiarTamano) }

      if (o.caja) {
        caja = cajaDeFraccion(o.caja)
        acotar()
        encajar(true)
        pintarPanel()
        releer()
      } else if (o.buscar) {
        o.desdeGaleria = true
        caja = cajaPorDefecto()
        encajar(false)
        pintarPanel()
        mostrarEstado(_listo ? tx('buscandoFoto') : tx('cargando'), null)
        const mio = ++turno
        try {
          const sitio = await localizar(base)
          if (mio !== turno || cerrado) return
          if (sitio) {
            cuartos = sitio.cuartos
            trabajo = girarCuartos(base, cuartos)
            caja = cajaDeFraccion(sitio.caja)
            acotar()
            encajar(true)
            releer()
          } else {
            mostrarEstado(null)
            if (trabajo.height > trabajo.width * 1.15) o.mensaje = tx('noEncontrado') + ' ' + tx('vertical')
            else o.mensaje = tx('noEncontrado')
            pintarPanel()
          }
        } catch (e) {
          if (mio !== turno) return
          mostrarEstado(null)
          o.mensaje = e && e.message === 'SIN_LECTOR' ? tx('sinRed') : tx('noEncontrado')
          pintarPanel()
        }
      } else {
        caja = cajaPorDefecto()
        encajar(true)
        pintarPanel()
      }
    }

    if (opc.archivo) editor(opc.archivo, { buscar: true })
    else if (opc.fuente === 'galeria') { camara(); elegirFoto() }
    else camara()
    return promesa
  }

  window.LectorVIN = {
    precargar, abrir, leer, leerRapido, localizar, leerFotoEntera,
    semaforo, verificadorOk, limpiar: limpiarVin, emparejar, recordar, historial,
    get listo () { return _listo },
    /* Para la prueba de acierto: lo que necesita sin pasar por la pantalla. */
    _interno: { cargarImagen, recortarYAmpliar, girarCuartos, aLienzo, VIN_CORE, VIN_LANG, cargarTesseract }
  }
})()
