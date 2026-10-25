/* ============================================================
   RESUMEN DEL DÍA — imagen y PDF, el mismo archivo en SOO y en Registro VIN

   La copia buena vive en SOO (src/26-informe-dia.js); la app de Registro
   VIN lleva una copia idéntica como informe-dia.js. Igual que el lector:
   dos copias que se arreglan por separado acaban enseñando cosas distintas.

   Para qué: al acabar el día, cada trabajador se lleva una hoja con lo que
   hizo —cuántos autos, a qué ritmo, y la foto del VIN de cada uno— que
   puede enseñar o mandar por WhatsApp sin que nadie tenga que montarla.
   Es su respaldo y el del jefe: "estos son los nueve que hice hoy".

   Se dibuja todo en un lienzo y no se usa ninguna librería: la misma hoja
   sale como foto (una imagen larga, lo que mejor se ve en un teléfono) y
   como PDF en páginas A4 (lo que se imprime o se archiva). El PDF se
   escribe a mano: son páginas con una imagen JPEG cada una, y para eso
   bastan sesenta líneas.

   Uso:
     InformeDia.abrir(datos)                    pantalla con vista previa y compartir
     InformeDia.guardarRecorte(clave, dataURL)  el recorte del VIN, en el teléfono
     InformeDia.leerRecorte(clave)              → dataURL | null
     InformeDia.porHora(instantes)              → datos del gráfico de autos por hora
   ============================================================ */
;(function () {
  'use strict'

  const TZ = 'Australia/Brisbane'
  const ANCHO = 1080                       // lo que mejor se ve en un teléfono
  const ALTO_A4 = Math.round(ANCHO * 297 / 210)
  const M = 56                             // margen

  /* ---------------- Los recortes del VIN, en el teléfono ----------------

     No van a la nube a propósito. El almacén de SOO borra las fotos al
     cerrar cada período y tiene un límite pequeño; miles de recortes al año
     lo llenarían por algo que sólo hace falta para el resumen del día, y el
     resumen se mira en el mismo teléfono que escaneó. Se guardan pequeños
     (unos 10 KB) y se olvidan solos a los 45 días. */
  const BD = 'informe-dia', ALMACEN = 'recortes', DIAS = 45
  let _bd = null
  const abrirBD = () => _bd || (_bd = new Promise((ok, no) => {
    try {
      const r = indexedDB.open(BD, 1)
      r.onupgradeneeded = () => r.result.createObjectStore(ALMACEN)
      r.onsuccess = () => ok(r.result)
      r.onerror = () => no(r.error)
    } catch (e) { no(e) }
  }))
  const pedir = (modo, fn) => abrirBD().then(db => new Promise((ok, no) => {
    const tx = db.transaction(ALMACEN, modo)
    const r = fn(tx.objectStore(ALMACEN))
    tx.oncomplete = () => ok(r && r.result)
    tx.onerror = () => no(tx.error)
  }))

  const cargarImagen = src => new Promise((ok, no) => {
    const im = new Image()
    im.onload = () => ok(im)
    im.onerror = () => no(new Error('FOTO'))
    im.src = src
  })

  async function miniatura (dataUrl, ancho) {
    const im = await cargarImagen(dataUrl)
    const e = Math.min(1, (ancho || 560) / im.width)
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(im.width * e)); c.height = Math.max(1, Math.round(im.height * e))
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(im, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.8)
  }

  async function guardarRecorte (clave, dataUrl) {
    if (!clave || !dataUrl) return false
    try {
      const d = await miniatura(dataUrl, 560)
      await pedir('readwrite', s => s.put({ d, t: Date.now() }, String(clave)))
      if (Math.random() < 0.05) podar()
      return true
    } catch (e) { return false }
  }
  async function leerRecorte (clave) {
    try {
      const v = await pedir('readonly', s => s.get(String(clave)))
      return v && v.d ? v.d : null
    } catch (e) { return null }
  }
  async function podar () {
    try {
      const corte = Date.now() - DIAS * 864e5
      await pedir('readwrite', s => {
        const r = s.openCursor()
        r.onsuccess = () => {
          const c = r.result
          if (!c) return
          if (!c.value || c.value.t < corte) c.delete()
          c.continue()
        }
        return r
      })
    } catch (e) {}
  }

  /* ---------------- Ayudas para los datos ---------------- */
  const horaDe = iso => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false })
    .format(new Date(iso))) % 24
  const hhmm = iso => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
  /* Autos por hora, de la primera a la última hora con trabajo; las horas
     vacías de en medio se enseñan a cero, que también dicen algo. */
  function porHora (instantes) {
    const hs = instantes.filter(Boolean).map(horaDe)
    if (!hs.length) return []
    const a = Math.min(...hs), b = Math.max(...hs)
    const fuera = []
    for (let h = a; h <= b; h++) fuera.push({ etiqueta: String(h), valor: hs.filter(x => x === h).length })
    return fuera
  }

  /* ---------------- Dibujo ---------------- */
  const C = {
    tinta: '#10231a', suave: '#5d6d64', linea: '#e3ebe6', fondo: '#ffffff', panel: '#f3f7f4',
    verde: '#1f9d4c', ambar: '#c98a00', rojo: '#d23b32', gris: '#9aa5a0'
  }
  let FAM = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  const fuente = (g, peso, tam) => { g.font = `${peso} ${tam}px ${FAM}` }
  const MONO = 'ui-monospace, Menlo, Consolas, monospace'

  function rect (g, x, y, w, h, r, color) {
    g.beginPath()
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r)
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath()
    g.fillStyle = color; g.fill()
  }
  function recortarTexto (g, t, max) {
    t = String(t == null ? '' : t)
    if (g.measureText(t).width <= max) return t
    while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1)
    return t + '…'
  }
  function lineas (g, t, max) {
    const palabras = String(t || '').split(/\s+/)
    const out = []; let cur = ''
    for (const p of palabras) {
      const prueba = cur ? cur + ' ' + p : p
      if (g.measureText(prueba).width > max && cur) { out.push(cur); cur = p } else cur = prueba
    }
    if (cur) out.push(cur)
    return out
  }

  /* La hoja se arma como una lista de bloques, cada uno con su alto y su
     forma de dibujarse. Así la misma lista sirve para la imagen larga (uno
     detrás de otro) y para el PDF (se reparten en páginas sin partir nunca
     un bloque por la mitad, ni una fila de autos). */
  function bloques (d, L, recortes, logo) {
    const W = ANCHO - 2 * M
    const out = []
    const color = (d.marca && d.marca.color) || '#2A7F26'

    out.push({ alto: 230, cabecera: true, dibujar (g, y) {
      g.fillStyle = color; g.fillRect(0, y, ANCHO, 230)
      if (logo) {
        rect(g, M, y + 52, 92, 92, 22, '#fff')
        const e = Math.min(72 / logo.width, 72 / logo.height)
        g.drawImage(logo, M + 46 - logo.width * e / 2, y + 98 - logo.height * e / 2, logo.width * e, logo.height * e)
      } else {
        rect(g, M, y + 52, 92, 92, 22, 'rgba(255,255,255,.18)')
        g.fillStyle = '#fff'; fuente(g, 800, 38); g.textAlign = 'center'; g.textBaseline = 'middle'
        g.fillText((d.marca && d.marca.iniciales) || 'GC', M + 46, y + 99)
        g.textAlign = 'left'; g.textBaseline = 'alphabetic'
      }
      fuente(g, 600, 24); g.fillStyle = 'rgba(255,255,255,.82)'
      g.fillText(recortarTexto(g, ((d.marca && d.marca.nombre) || 'Green & Clean') + ' · ' + (d.titulo || L.titulo), W - 120), M + 120, y + 82)
      fuente(g, 800, 46); g.fillStyle = '#fff'
      g.fillText(recortarTexto(g, d.persona || '', W - 120), M + 120, y + 134)
      fuente(g, 500, 24); g.fillStyle = 'rgba(255,255,255,.9)'
      g.fillText(recortarTexto(g, [fechaLarga(d.fecha, d.idioma), d.lugar].filter(Boolean).join(' · '), W - 120), M + 120, y + 174)
    } })

    const kpis = (d.kpis || []).slice(0, 4)
    if (kpis.length) {
      const filas = Math.ceil(kpis.length / 2), hk = 168, gap = 20
      out.push({ alto: 40 + filas * hk + (filas - 1) * gap, dibujar (g, y) {
        const w = (W - gap) / 2
        kpis.forEach((k, i) => {
          const x = M + (i % 2) * (w + gap), yy = y + 40 + Math.floor(i / 2) * (hk + gap)
          rect(g, x, yy, w, hk, 22, C.panel)
          g.fillStyle = C.suave; fuente(g, 600, 22); g.fillText(recortarTexto(g, k.etiqueta, w - 48), x + 28, yy + 44)
          g.fillStyle = C.tinta; fuente(g, 800, 56); g.fillText(recortarTexto(g, k.valor, w - 48), x + 28, yy + 110)
          if (k.nota) { g.fillStyle = k.tono === 'mal' ? C.rojo : k.tono === 'bien' ? C.verde : C.suave; fuente(g, 600, 21); g.fillText(recortarTexto(g, k.nota, w - 48), x + 28, yy + 146) }
        })
      } })
    }

    if (d.frase) {
      const g0 = document.createElement('canvas').getContext('2d'); fuente(g0, 500, 26)
      const ls = lineas(g0, d.frase, W - 64)
      out.push({ alto: 36 + ls.length * 38 + 44, dibujar (g, y) {
        rect(g, M, y + 36, W, ls.length * 38 + 34, 18, '#eaf5ec')
        g.fillStyle = C.tinta; fuente(g, 500, 26)
        ls.forEach((l, i) => g.fillText(l, M + 32, y + 36 + 46 + i * 38))
      } })
    }

    for (const gr of d.graficos || []) {
      if (!gr.datos || !gr.datos.length) continue
      if (gr.tipo === 'horas') {
        out.push({ alto: 380, dibujar (g, y) {
          g.fillStyle = C.tinta; fuente(g, 800, 30); g.fillText(gr.titulo, M, y + 76)
          const base = y + 330, alto = 200, n = gr.datos.length
          const max = Math.max(1, ...gr.datos.map(x => x.valor))
          const paso = W / n, bw = Math.min(72, paso * 0.62)
          g.fillStyle = C.linea; g.fillRect(M, base, W, 2)
          gr.datos.forEach((x, i) => {
            const cx = M + paso * i + paso / 2
            const h = Math.round(alto * x.valor / max)
            if (x.valor) rect(g, cx - bw / 2, base - h, bw, h, Math.min(10, bw / 2), color)
            g.textAlign = 'center'
            g.fillStyle = C.tinta; fuente(g, 700, 22); if (x.valor) g.fillText(String(x.valor), cx, base - h - 10)
            g.fillStyle = C.suave; fuente(g, 500, 20); g.fillText(x.etiqueta + 'h', cx, base + 32)
            g.textAlign = 'left'
          })
        } })
      } else {
        const n = gr.datos.length, fila = 54
        out.push({ alto: 100 + n * fila, dibujar (g, y) {
          g.fillStyle = C.tinta; fuente(g, 800, 30); g.fillText(gr.titulo, M, y + 76)
          const max = Math.max(1, ...gr.datos.map(x => x.valor))
          const etW = Math.min(360, W * 0.38), barW = W - etW - 90
          gr.datos.forEach((x, i) => {
            const yy = y + 110 + i * fila
            g.fillStyle = C.tinta; fuente(g, 500, 23); g.fillText(recortarTexto(g, x.etiqueta, etW - 16), M, yy + 8)
            rect(g, M + etW, yy - 16, barW, 30, 15, C.panel)
            const w = Math.max(x.valor ? 30 : 0, Math.round(barW * x.valor / max))
            if (w) rect(g, M + etW, yy - 16, w, 30, 15, x.color || color)
            g.fillStyle = C.tinta; fuente(g, 700, 23); g.fillText(String(x.valor), M + etW + barW + 18, yy + 8)
          })
        } })
      }
    }

    const autos = d.autos || []
    out.push({ alto: 110, dibujar (g, y) {
      g.fillStyle = C.tinta; fuente(g, 800, 30)
      g.fillText(L.vehiculos.replace('{n}', autos.length), M, y + 84)
    } })
    if (!autos.length) {
      out.push({ alto: 90, dibujar (g, y) { g.fillStyle = C.suave; fuente(g, 500, 24); g.fillText(L.ninguno, M, y + 50) } })
    }
    const gap = 20, tw = (W - gap) / 2, th = 258
    for (let i = 0; i < autos.length; i += 2) {
      const par = autos.slice(i, i + 2)
      out.push({ alto: th + gap, fila: true, dibujar (g, y) {
        par.forEach((a, k) => {
          const x = M + k * (tw + gap), yy = y + gap / 2
          rect(g, x, yy, tw, th, 20, C.panel)
          /* La foto del VIN: entera y centrada, sin deformar. */
          const ix = x + 16, iy = yy + 16, iw = tw - 32, ih = 112
          rect(g, ix, iy, iw, ih, 12, '#dfe6e2')
          const im = recortes[i + k]
          if (im) {
            const e = Math.min(iw / im.width, ih / im.height)
            const w = im.width * e, h = im.height * e
            g.save(); g.beginPath(); g.rect(ix, iy, iw, ih); g.clip()
            g.drawImage(im, ix + (iw - w) / 2, iy + (ih - h) / 2, w, h)
            g.restore()
          } else {
            g.fillStyle = C.gris; fuente(g, 600, 20); g.textAlign = 'center'
            g.fillText(L.sinFoto, ix + iw / 2, iy + ih / 2 + 7); g.textAlign = 'left'
          }
          const est = { verde: C.verde, ambar: C.ambar, rojo: C.rojo }[a.estado] || C.gris
          g.fillStyle = est; g.beginPath(); g.arc(x + 28, yy + 162, 8, 0, Math.PI * 2); g.fill()
          g.fillStyle = C.suave; fuente(g, 700, 20)
          g.fillText('#' + (i + k + 1) + (a.hora ? ' · ' + a.hora : ''), x + 46, yy + 169)
          /* El VIN con los seis últimos en negrita: es lo que se busca con
             la vista en una hoja con veinte. */
          const vin = String(a.vin || '')
          g.fillStyle = C.tinta
          if (vin.length > 6) {
            g.font = `500 25px ${MONO}`; const pre = vin.slice(0, -6)
            g.fillText(pre, x + 20, yy + 208)
            const pw = g.measureText(pre).width
            g.font = `800 25px ${MONO}`; g.fillText(vin.slice(-6), x + 20 + pw, yy + 208)
          } else {
            g.font = `800 25px ${MONO}`; g.fillText(vin || '—', x + 20, yy + 208)
          }
          g.fillStyle = C.suave; fuente(g, 500, 19)
          g.fillText(recortarTexto(g, a.detalle || '', tw - 40), x + 20, yy + 240)
        })
      } })
    }

    out.push({ alto: 120, pie: true, dibujar (g, y) {
      g.fillStyle = C.linea; g.fillRect(M, y + 40, W, 2)
      g.fillStyle = C.suave; fuente(g, 500, 19)
      g.fillText(recortarTexto(g, d.pie || '', W), M, y + 80)
    } })
    return out
  }

  function fechaLarga (dia, idioma) {
    if (!dia) return ''
    return new Date(dia + 'T12:00:00Z').toLocaleDateString(idioma === 'en' ? 'en-AU' : 'es-AU',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  }

  /* La foto: todos los bloques seguidos, en una sola imagen larga. */
  function pintarLarga (bs) {
    const alto = bs.reduce((a, b) => a + b.alto, 0) + 24
    const c = document.createElement('canvas'); c.width = ANCHO; c.height = alto
    const g = c.getContext('2d')
    g.fillStyle = C.fondo; g.fillRect(0, 0, ANCHO, alto)
    let y = 0
    for (const b of bs) { b.dibujar(g, y); y += b.alto }
    return c
  }

  /* El PDF: los mismos bloques repartidos en A4. Desde la segunda página,
     una cabecera fina con el nombre y el número de página, para que una hoja
     suelta no se quede sin dueño. */
  function pintarPaginas (bs, d, L) {
    const paginas = []
    const cab = bs[0], pie = bs[bs.length - 1], cuerpo = bs.slice(1, -1)
    let c, g, y
    const nueva = (primera) => {
      c = document.createElement('canvas'); c.width = ANCHO; c.height = ALTO_A4
      g = c.getContext('2d'); g.fillStyle = C.fondo; g.fillRect(0, 0, ANCHO, ALTO_A4)
      if (primera) { cab.dibujar(g, 0); y = cab.alto }
      else {
        g.fillStyle = C.suave; fuente(g, 600, 21)
        g.fillText(recortarTexto(g, (d.persona || '') + ' · ' + fechaLarga(d.fecha, d.idioma), ANCHO - 2 * M), M, 64)
        g.fillStyle = C.linea; g.fillRect(M, 84, ANCHO - 2 * M, 2)
        y = 96
      }
      paginas.push({ c, g })
    }
    nueva(true)
    const limite = ALTO_A4 - 90
    for (const b of cuerpo) {
      if (y + b.alto > limite) nueva(false)
      b.dibujar(g, y); y += b.alto
    }
    if (y + pie.alto > ALTO_A4) nueva(false)
    pie.dibujar(g, Math.max(y, ALTO_A4 - pie.alto - 10))
    paginas.forEach((p, i) => {
      p.g.fillStyle = C.suave; fuente(p.g, 500, 18); p.g.textAlign = 'right'
      p.g.fillText(L.pagina.replace('{i}', i + 1).replace('{n}', paginas.length), ANCHO - M, ALTO_A4 - 24)
      p.g.textAlign = 'left'
    })
    return paginas.map(p => p.c)
  }

  const aBlob = (c, calidad) => new Promise(ok => c.toBlob(ok, 'image/jpeg', calidad))

  /* Un PDF 1.4 mínimo: catálogo, páginas y, en cada página, una imagen
     JPEG a toda la hoja. Los JPEG entran tal cual (DCTDecode): el PDF no
     los vuelve a comprimir ni los estropea. */
  async function pdfDe (lienzos) {
    const enc = new TextEncoder()
    const partes = []; let largo = 0; const offs = []
    const meter = b => { const u = typeof b === 'string' ? enc.encode(b) : b; partes.push(u); largo += u.length }
    const objeto = (n, cuerpo) => { offs[n] = largo; meter(`${n} 0 obj\n`); cuerpo(); meter('\nendobj\n') }
    const imgs = []
    for (const c of lienzos) imgs.push({ bytes: new Uint8Array(await (await aBlob(c, 0.88)).arrayBuffer()), w: c.width, h: c.height })
    const n = imgs.length, PW = 595.28, PH = 841.89
    meter('%PDF-1.4\n%âãÏÓ\n')
    objeto(1, () => meter('<< /Type /Catalog /Pages 2 0 R >>'))
    objeto(2, () => meter(`<< /Type /Pages /Count ${n} /Kids [${imgs.map((_, i) => (3 + 3 * i) + ' 0 R').join(' ')}] >>`))
    imgs.forEach((im, i) => {
      const pg = 3 + 3 * i
      objeto(pg, () => meter(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im${i} ${pg + 1} 0 R >> >> /Contents ${pg + 2} 0 R >>`))
      objeto(pg + 1, () => {
        meter(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`)
        meter(im.bytes); meter('\nendstream')
      })
      const cont = `q ${PW} 0 0 ${PH} 0 0 cm /Im${i} Do Q`
      objeto(pg + 2, () => meter(`<< /Length ${cont.length} >>\nstream\n${cont}\nendstream`))
    })
    const total = 3 + 3 * n, xref = largo
    meter(`xref\n0 ${total}\n0000000000 65535 f \n`)
    for (let k = 1; k < total; k++) meter(String(offs[k]).padStart(10, '0') + ' 00000 n \n')
    meter(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
    return new Blob(partes, { type: 'application/pdf' })
  }

  /* Genera la foto y el PDF. Los recortes pueden venir hechos o como una
     función que los consigue (por ejemplo, sacándolos de la foto guardada):
     se piden aquí, de dos en dos, avisando del avance. */
  async function generar (d, alAvanzar, formato) {
    const L = TEXTOS[d.idioma] || TEXTOS.es
    try {
      FAM = getComputedStyle(document.body).fontFamily || FAM
      if (document.fonts && document.fonts.ready) await document.fonts.ready
    } catch (e) {}
    const autos = d.autos || []
    const recortes = new Array(autos.length).fill(null)
    let hechos = 0
    /* Cada recorte tiene un tope de tiempo. Sacarlo de una foto guardada
       hace trabajar al lector, y en un teléfono lento uno atascado dejaba la
       hoja sin terminar y los botones apagados para siempre. Pasado el tope,
       ese auto sale sin foto y la hoja se termina igual. */
    const conTope = p => Promise.race([p, new Promise(ok => setTimeout(() => ok(null), 20000))])
    const uno = async i => {
      let src = autos[i].recorte
      try { if (typeof src === 'function') src = await conTope(src()) } catch (e) { src = null }
      if (src) { try { recortes[i] = await cargarImagen(src) } catch (e) {} }
      hechos++; if (alAvanzar) alAvanzar(hechos, autos.length)
    }
    for (let i = 0; i < autos.length; i += 2) await Promise.all([uno(i), i + 1 < autos.length ? uno(i + 1) : null])
    let logo = null
    if (d.marca && d.marca.logo) { try { logo = await cargarImagen(d.marca.logo) } catch (e) {} }
    const bs = bloques(d, L, recortes, logo)
    /* Sólo lo que se pidió: la foto o el PDF. Hacer los dos cada vez era
       el doble de espera para quien sólo quería uno. */
    if (formato === 'pdf') {
      const paginas = pintarPaginas(bs, d, L)
      const vistas = []
      for (const c of paginas) vistas.push(await aBlob(c, 0.8))
      return { pdf: await pdfDe(paginas), vistas }
    }
    const larga = pintarLarga(bs)
    const imagen = await aBlob(larga, 0.9)
    return { imagen, vistas: [imagen] }
  }

  /* ---------------- Pantalla ---------------- */
  const TEXTOS = {
    es: {
      titulo: 'Resumen del día', vehiculos: 'Vehículos del día ({n})', ninguno: 'Ningún vehículo registrado este día.',
      sinFoto: 'Sin foto del VIN', pagina: 'Página {i} de {n}', preparando: 'Preparando el resumen…',
      fotos: 'Preparando las fotos del VIN {i} de {n}…', compartir: 'Compartir', descargar: 'Descargar',
      enFoto: 'en foto', enPdf: 'en PDF', cerrar: 'Cerrar', error: 'No se pudo preparar el resumen.',
      bajado: 'Guardado en Descargas'
    },
    en: {
      titulo: 'Daily summary', vehiculos: 'Vehicles of the day ({n})', ninguno: 'No vehicles recorded this day.',
      sinFoto: 'No VIN photo', pagina: 'Page {i} of {n}', preparando: 'Preparing the summary…',
      fotos: 'Preparing the VIN photos {i} of {n}…', compartir: 'Share', descargar: 'Download',
      enFoto: 'as photo', enPdf: 'as PDF', cerrar: 'Close', error: 'The summary could not be prepared.',
      bajado: 'Saved to Downloads'
    }
  }

  const CSS = `
.ifd{position:fixed;inset:0;z-index:2147482000;background:#0e110f;color:#fff;display:flex;flex-direction:column;font-family:inherit}
.ifd *{box-sizing:border-box}
:where(.ifd) button{font:inherit;color:inherit;border:0;background:none;cursor:pointer}
.ifd-cab{display:flex;align-items:center;gap:10px;padding:10px 14px;padding-top:max(10px,env(safe-area-inset-top));flex:none}
.ifd-cab h2{flex:1;margin:0;font-size:17px}
.ifd-x{width:44px;height:44px;border-radius:50%;background:#2a2e2c;display:grid;place-items:center;font-size:20px}
.ifd-vista{flex:1;overflow:auto;padding:0 14px;-webkit-overflow-scrolling:touch}
.ifd-vista img{display:block;width:100%;max-width:620px;margin:0 auto 12px;border-radius:12px;background:#fff}
.ifd-estado{text-align:center;padding:40px 16px;opacity:.85}
.ifd-pie{flex:none;display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center;padding:10px 14px max(14px,env(safe-area-inset-bottom));border-top:1px solid #222}
.ifd-pie button{min-height:50px;border-radius:12px;font-weight:700;font-size:15px;background:#2a2e2c}
.ifd-pie button.ifd-pri{background:var(--ifd-acento,#2A7F26)}
.ifd-pie button:disabled{opacity:.4}
.ifd-nota{grid-column:1/-1;text-align:center;font-size:13px;opacity:.8;min-height:16px}
`
  let _css = false
  const ponerCss = () => { if (_css) return; _css = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s) }

  const nombreArchivo = d => ('resumen-' + (d.persona || 'dia') + '-' + (d.fecha || ''))
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')

  /* Compartir con un toque (WhatsApp, correo…) donde el teléfono lo deja;
     si no, se descarga. En Android con Chrome compartir archivos funciona;
     en un ordenador casi nunca, y ahí descargar es lo esperado. */
  async function compartir (blob, nombre, tipo, titulo) {
    const f = new File([blob], nombre, { type: tipo })
    try {
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        await navigator.share({ files: [f], title: titulo })
        return 'compartido'
      }
    } catch (e) { if (e && e.name === 'AbortError') return 'cancelado' }
    descargar(blob, nombre)
    return 'descargado'
  }
  function descargar (blob, nombre) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = nombre
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 60000)
  }

  /* formato: 'foto' (una imagen larga, lo que se manda por WhatsApp) o 'pdf'
     (páginas A4, lo que se imprime). Son dos botones distintos desde el
     principio y cada uno prepara sólo lo suyo. */
  function abrir (d, formato) {
    formato = formato === 'pdf' ? 'pdf' : 'foto'
    ponerCss()
    const L = TEXTOS[d.idioma] || TEXTOS.es
    const raiz = document.createElement('div')
    raiz.className = 'ifd'
    raiz.setAttribute('role', 'dialog'); raiz.setAttribute('aria-modal', 'true')
    raiz.innerHTML = `
      <div class="ifd-cab"><button class="ifd-x" data-a="x" aria-label="${L.cerrar}">✕</button><h2></h2></div>
      <div class="ifd-vista"><div class="ifd-estado">${L.preparando}</div></div>
      <div class="ifd-pie">
        <button class="ifd-pri" data-a="compartir" disabled>${L.compartir}</button>
        <button data-a="descargar" disabled>${L.descargar}</button>
        <div class="ifd-nota" aria-live="polite"></div>
      </div>`
    const titulo = (d.titulo || L.titulo) + ' ' + (formato === 'pdf' ? L.enPdf : L.enFoto) + ' · ' + (d.persona || '')
    raiz.querySelector('h2').textContent = titulo
    document.body.appendChild(raiz)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const estado = raiz.querySelector('.ifd-estado')
    const nota = raiz.querySelector('.ifd-nota')
    let hecho = null
    const urls = []
    const cerrar = () => { raiz.remove(); document.body.style.overflow = prev; urls.forEach(u => URL.revokeObjectURL(u)) }
    const nombre = nombreArchivo(d) + (formato === 'pdf' ? '.pdf' : '.jpg')
    const tipo = formato === 'pdf' ? 'application/pdf' : 'image/jpeg'
    raiz.onclick = async e => {
      const b = e.target.closest('[data-a]'); if (!b) return
      const a = b.dataset.a
      if (a === 'x') return cerrar()
      if (!hecho) return
      const blob = formato === 'pdf' ? hecho.pdf : hecho.imagen
      if (a === 'compartir') {
        const r = await compartir(blob, nombre, tipo, titulo)
        if (r === 'descargado') nota.textContent = L.bajado
      } else if (a === 'descargar') { descargar(blob, nombre); nota.textContent = L.bajado }
    }
    generar(d, (i, n) => { estado.textContent = L.fotos.replace('{i}', i).replace('{n}', n) }, formato)
      .then(r => {
        hecho = r
        const vista = raiz.querySelector('.ifd-vista'); vista.innerHTML = ''
        for (const v of r.vistas) {
          const u = URL.createObjectURL(v); urls.push(u)
          const img = document.createElement('img'); img.src = u; img.alt = titulo
          vista.appendChild(img)
        }
        raiz.querySelectorAll('.ifd-pie button').forEach(x => { x.disabled = false })
      })
      .catch(() => { estado.textContent = L.error })
    return { cerrar }
  }

  window.InformeDia = { abrir, generar, guardarRecorte, leerRecorte, porHora, hhmm, compartir, descargar }
})()
