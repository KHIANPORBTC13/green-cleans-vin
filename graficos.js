/* ============================================================
   GRÁFICOS DEL REPORTE — dibujados a mano, en SVG y HTML

   Antes había uno solo (autos por día, con Chart.js). Ahora cada gráfico
   contesta una pregunta del jefe:

     indicadores    ¿cómo vamos frente al período anterior?
     tendencia      ¿qué días (u horas) se hizo más, y frente a antes?
     calor          ¿a qué día y hora se trabaja? (para los turnos)
     trabajadores   ¿quién hace cuántos, a qué ritmo y cuánto cambió?
     jornada        ¿a qué hora empezó y terminó cada día, y dónde hubo huecos?
     marcas         ¿qué marcas entran más?

   Sin librerías: es una descarga menos, funciona sin señal y se ve igual
   en claro y en oscuro porque los colores salen de variables CSS (--viz-*).
   La paleta se comprobó con el validador de colores (daltonismo, contraste,
   luminosidad): el verde del período actual y el gris del anterior, que
   además se distinguen por la forma (barras frente a línea) y la leyenda.

   Cada marca lleva data-tip: al pasar el dedo o el ratón sale el dato
   exacto. El área que responde es más grande que la marca.
   ============================================================ */
;(function () {
  'use strict'
  const NS = 'http://www.w3.org/2000/svg'
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const num = (v, d) => Number(v).toLocaleString('es-ES', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0, useGrouping: true })
  const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
  const DIAS_C = ['L', 'M', 'X', 'J', 'V', 'S', 'D']
  const hh = h => String(h).padStart(2, '0') + ':00'
  const hora = d => d.toLocaleTimeString('es-AU', { hour: '2-digit', minute: '2-digit', hour12: false })
  const diaSemana = d => (d.getDay() + 6) % 7
  const claveDia = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  const min = m => m < 60 ? Math.round(m) + ' min' : Math.floor(m / 60) + ' h' + (Math.round(m % 60) ? ' ' + Math.round(m % 60) + ' min' : '')

  /* Un máximo "redondo" para el eje: 7 → 8, 23 → 25, 140 → 150. */
  function techo (v) {
    if (v <= 4) return Math.max(1, Math.ceil(v))
    const p = Math.pow(10, Math.floor(Math.log10(v)))
    for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p
    return 10 * p
  }
  const el = (tag, attrs, hijos) => {
    const e = document.createElementNS(NS, tag)
    for (const k in attrs || {}) if (attrs[k] != null) e.setAttribute(k, attrs[k])
    for (const h of hijos || []) e.appendChild(h)
    return e
  }
  const texto = (x, y, t, attrs) => { const e = el('text', Object.assign({ x, y }, attrs || {})); e.textContent = t; return e }
  /* Una barra con las esquinas de arriba redondeadas y apoyada en la base. */
  const barra = (x, y, w, h, r) => {
    r = Math.max(0, Math.min(r, w / 2, h))
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
  }

  /* ---------- La etiqueta flotante con el dato exacto ---------- */
  let tip = null
  function etiqueta () {
    if (tip) return tip
    tip = document.createElement('div')
    tip.className = 'viz-tip'
    tip.setAttribute('role', 'status')
    tip.hidden = true
    document.body.appendChild(tip)
    document.addEventListener('pointerdown', e => { if (!e.target.closest('.viz')) ocultar() }, true)
    window.addEventListener('scroll', ocultar, { passive: true })
    return tip
  }
  function ocultar () {
    if (!tip) return
    tip.hidden = true
    document.querySelectorAll('.viz .on').forEach(x => x.classList.remove('on'))
  }
  function conEtiqueta (cont) {
    if (cont._conEtiqueta) return
    cont._conEtiqueta = true
    const mostrar = e => {
      const m = e.target.closest('[data-tip]')
      if (!m || !cont.contains(m)) { if (e.type !== 'pointermove' || e.pointerType === 'mouse') ocultar(); return }
      const t = etiqueta()
      cont.querySelectorAll('.on').forEach(x => { if (x !== m) x.classList.remove('on') })
      const grupo = m.dataset.marca ? cont.querySelectorAll('[data-marca="' + m.dataset.marca + '"]') : [m]
      grupo.forEach(x => x.classList.add('on'))
      t.innerHTML = m.dataset.tip
      t.hidden = false
      const r = t.getBoundingClientRect()
      let x = e.clientX - r.width / 2, y = e.clientY - r.height - 16
      x = Math.max(8, Math.min(window.innerWidth - r.width - 8, x))
      if (y < 8) y = e.clientY + 20
      t.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`
    }
    cont.addEventListener('pointermove', mostrar)
    cont.addEventListener('pointerdown', mostrar)
    cont.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') ocultar() })
  }

  /* ---------- Cálculos ---------- */
  /* El ritmo: minutos entre un auto y el siguiente de la misma persona el
     mismo día. Los huecos de más de 90 min son descansos o esperas, no
     ritmo, y no cuentan. Se da la mediana: un par de huecos raros no la
     mueven. */
  function ritmo (filas) {
    const porPersonaDia = new Map()
    for (const r of filas) {
      const d = new Date(r.client_at); if (isNaN(d)) continue
      const k = String(r.worker_name || '').trim().toLowerCase() + '|' + claveDia(d)
      if (!porPersonaDia.has(k)) porPersonaDia.set(k, [])
      porPersonaDia.get(k).push(d.getTime())
    }
    const huecos = []
    for (const l of porPersonaDia.values()) {
      l.sort((a, b) => a - b)
      for (let i = 1; i < l.length; i++) { const g = (l[i] - l[i - 1]) / 60000; if (g > 0 && g <= 90) huecos.push(g) }
    }
    if (!huecos.length) return null
    huecos.sort((a, b) => a - b)
    const m = huecos.length >> 1
    return huecos.length % 2 ? huecos[m] : (huecos[m - 1] + huecos[m]) / 2
  }
  function resumen (filas) {
    const dias = new Set(filas.map(r => claveDia(new Date(r.client_at))))
    const n = filas.length
    return { n, dias: dias.size, porDia: dias.size ? n / dias.size : 0, ritmo: ritmo(filas) }
  }

  /* ---------- 1. Indicadores frente al período anterior ---------- */
  function indicadores (cont, o) {
    const a = resumen(o.filas), p = resumen(o.anteriores || [])
    const delta = (va, vp, mejorSiBaja, fmt) => {
      if (va == null || vp == null || !o.anteriores || !o.anteriores.length) return '<span class="kpi-d">Sin datos del ' + esc(o.nombreAnterior) + '</span>'
      const d = va - vp
      if (Math.abs(d) < 1e-9) return '<span class="kpi-d">Igual que el ' + esc(o.nombreAnterior) + '</span>'
      const bien = mejorSiBaja ? d < 0 : d > 0
      return '<span class="kpi-d ' + (bien ? 'bien' : 'mal') + '"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="' +
        (d > 0 ? 'M6 2.5 10 8H2Z' : 'M6 9.5 10 4H2Z') + '"/></svg>' + esc(fmt(Math.abs(d))) + ' frente al ' + esc(o.nombreAnterior) + '</span>'
    }
    const deltaPct = (va, vp) => vp ? Math.round(Math.abs(va - vp) / vp * 100) + ' %' : num(Math.abs(va - vp))
    const tiles = [
      { k: 'Autos lavados', v: num(a.n), d: delta(a.n, p.n, false, () => deltaPct(a.n, p.n)), spark: true },
      { k: 'Por día trabajado', v: a.dias ? num(a.porDia, 1) : '—', s: a.dias ? 'en ' + a.dias + (a.dias === 1 ? ' día' : ' días') : '',
        d: a.dias ? delta(a.porDia, p.dias ? p.porDia : null, false, x => num(x, 1)) : '' },
      { k: 'Ritmo', v: a.ritmo == null ? '—' : '1 cada ' + Math.round(a.ritmo) + ' min', s: 'mediana entre autos seguidos',
        d: a.ritmo == null ? '' : delta(a.ritmo, p.ritmo, true, x => Math.round(x) + ' min') },
      { k: 'VIN repetidos', v: num(o.repetidos || 0), s: o.repetidos ? 'revisa los marcados en rojo' : 'ningún auto apuntado dos veces',
        alerta: !!o.repetidos }
    ]
    cont.innerHTML = tiles.map((t, i) => '<div class="kpi' + (t.alerta ? ' alerta' : '') + '"><span class="kpi-k">' + esc(t.k) + '</span>' +
      '<b class="kpi-v">' + esc(t.v) + '</b>' + (t.s ? '<span class="kpi-s">' + esc(t.s) + '</span>' : '') + (t.d || '') +
      (t.spark ? '<svg class="kpi-spark" data-i="' + i + '" aria-hidden="true"></svg>' : '') + '</div>').join('')
    const sp = cont.querySelector('.kpi-spark')
    if (sp && o.serie && o.serie.length > 1) {
      const w = sp.clientWidth || 120, h = 30, mx = Math.max(1, ...o.serie)
      const pts = o.serie.map((v, i) => [i / (o.serie.length - 1) * (w - 4) + 2, h - 3 - v / mx * (h - 6)])
      sp.setAttribute('viewBox', `0 0 ${w} ${h}`)
      sp.appendChild(el('path', { d: 'M' + pts.map(p => p.map(x => x.toFixed(1)).join(',')).join('L') + `L${pts[pts.length - 1][0].toFixed(1)},${h}L2,${h}Z`, class: 'spark-area' }))
      sp.appendChild(el('path', { d: 'M' + pts.map(p => p.map(x => x.toFixed(1)).join(',')).join('L'), class: 'spark-linea' }))
      const u = pts[pts.length - 1]
      sp.appendChild(el('circle', { cx: u[0], cy: u[1], r: 3, class: 'spark-punto' }))
    }
  }

  /* ---------- 2. Tendencia: columnas del período, línea gris del anterior ---------- */
  function tendencia (cont, o) {
    const datos = o.cubetas
    cont.innerHTML = ''
    const leyenda = document.createElement('div')
    leyenda.className = 'viz-leyenda'
    leyenda.innerHTML = '<span><i class="ley-barra"></i>' + esc(o.nombreActual) + '</span>' +
      (o.conAnterior ? '<span><i class="ley-linea"></i>' + esc(o.nombreAnterior.charAt(0).toUpperCase() + o.nombreAnterior.slice(1)) + '</span>' : '')
    cont.appendChild(leyenda)
    const W = Math.max(260, cont.clientWidth - 32), H = 190, ejeY = 30, ejeX = 26, alto = H - ejeX - 12
    const mx = techo(Math.max(1, ...datos.map(d => Math.max(d.n, d.prev || 0))))
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img',
      'aria-label': o.titulo + ': ' + datos.map(d => d.etq + ' ' + d.n).join(', ') })
    const y = v => 12 + alto - v / mx * alto
    for (const t of [0, mx / 2, mx]) {
      svg.appendChild(el('line', { x1: ejeY, x2: W, y1: y(t), y2: y(t), class: t ? 'viz-rejilla' : 'viz-base' }))
      svg.appendChild(texto(ejeY - 8, y(t) + 4, num(t), { class: 'viz-eje', 'text-anchor': 'end' }))
    }
    const banda = (W - ejeY) / datos.length
    const ancho = Math.max(3, Math.min(30, banda * 0.62))
    /* Las etiquetas de abajo, sólo las que caben sin pisarse. */
    const cada = Math.max(1, Math.ceil(datos.length * 34 / (W - ejeY)))
    const imax = datos.reduce((b, d, i) => d.n > datos[b].n ? i : b, 0)
    datos.forEach((d, i) => {
      const cx = ejeY + banda * i + banda / 2
      if (d.n > 0) svg.appendChild(el('path', { d: barra(cx - ancho / 2, y(d.n), ancho, y(0) - y(d.n), 4), class: 'viz-col', 'data-marca': 'c' + i }))
      if (i % cada === 0 || i === datos.length - 1) svg.appendChild(texto(cx, H - 8, d.etq, { class: 'viz-eje', 'text-anchor': 'middle' }))
      if (i === imax && d.n > 0) svg.appendChild(texto(cx, y(d.n) - 6, num(d.n), { class: 'viz-valor', 'text-anchor': 'middle' }))
    })
    if (o.conAnterior) {
      const pts = datos.map((d, i) => d.prev == null ? null : [ejeY + banda * i + banda / 2, y(d.prev)])
      let tramo = ''
      pts.forEach((p, i) => { if (p) tramo += (tramo && pts[i - 1] ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1) })
      svg.appendChild(el('path', { d: tramo, class: 'viz-prev' }))
      if (datos.length <= 31) pts.forEach((p, i) => { if (p) svg.appendChild(el('circle', { cx: p[0], cy: p[1], r: 3.5, class: 'viz-prev-punto', 'data-marca': 'c' + i })) })
    }
    /* El área que responde: la columna entera, de arriba abajo. */
    datos.forEach((d, i) => {
      const tip = '<b>' + esc(d.largo || d.etq) + '</b>' + (d.futuro ? 'Todavía no ha llegado' : num(d.n) + (d.n === 1 ? ' auto' : ' autos')) +
        (o.conAnterior && d.prev != null ? '<span>' + esc(o.nombreAnterior.charAt(0).toUpperCase() + o.nombreAnterior.slice(1)) + ': ' + num(d.prev) + '</span>' : '')
      svg.appendChild(el('rect', { x: ejeY + banda * i, y: 0, width: banda, height: H - ejeX + 6, class: 'viz-hit', 'data-tip': tip, 'data-marca': 'c' + i }))
    })
    cont.appendChild(svg)
    conEtiqueta(cont)
  }

  /* ---------- 3. Mapa de calor: día de la semana × hora ---------- */
  function calor (cont, o) {
    const cuenta = Array.from({ length: 7 }, () => new Map())
    let hMin = 24, hMax = -1
    for (const r of o.filas) {
      const d = new Date(r.client_at); if (isNaN(d)) continue
      const h = d.getHours(), w = diaSemana(d)
      cuenta[w].set(h, (cuenta[w].get(h) || 0) + 1)
      hMin = Math.min(hMin, h); hMax = Math.max(hMax, h)
    }
    if (hMax < 0) { cont.innerHTML = '<p class="viz-vacio">Sin autos en este período.</p>'; return }
    hMin = Math.min(hMin, 7); hMax = Math.max(hMax, 17)
    const horas = []; for (let h = hMin; h <= hMax; h++) horas.push(h)
    const mx = Math.max(1, ...cuenta.flatMap(m => [...m.values()]))
    const paso = v => v <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil(v / mx * 5)))
    const W = Math.max(260, cont.clientWidth - 32), izq = 22, arriba = 4, abajo = 22
    const c = Math.min(34, (W - izq) / horas.length), fila = Math.min(30, Math.max(22, c)), H = arriba + fila * 7 + abajo
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': 'Autos por día de la semana y hora' })
    const g = 2
    for (let w = 0; w < 7; w++) {
      svg.appendChild(texto(izq - 8, arriba + fila * w + fila / 2 + 4, DIAS_C[w], { class: 'viz-eje', 'text-anchor': 'end' }))
      horas.forEach((h, i) => {
        const v = cuenta[w].get(h) || 0
        const x = izq + c * i, yy = arriba + fila * w
        const tip = '<b>' + DIAS[w] + ', ' + hh(h) + ' a ' + hh(h + 1) + '</b>' + num(v) + (v === 1 ? ' auto' : ' autos') +
          (o.semanas > 1 && v ? '<span>' + num(v / o.semanas, 1) + ' por semana de media</span>' : '')
        svg.appendChild(el('rect', { x: x + g / 2, y: yy + g / 2, width: c - g, height: fila - g, rx: 4, class: 'viz-celda p' + paso(v), 'data-tip': tip }))
      })
    }
    const cada = Math.max(1, Math.ceil(horas.length * 26 / (W - izq)))
    horas.forEach((h, i) => { if (i % cada === 0) svg.appendChild(texto(izq + c * i + c / 2, H - 6, String(h), { class: 'viz-eje', 'text-anchor': 'middle' })) })
    cont.innerHTML = ''
    cont.appendChild(svg)
    const ley = document.createElement('div')
    ley.className = 'viz-escala'
    ley.innerHTML = '<span>Hora del día</span><span class="esc">Menos ' + [1, 2, 3, 4, 5].map(k => '<i class="p' + k + '"></i>').join('') + ' Más</span>'
    cont.appendChild(ley)
    conEtiqueta(cont)
  }

  /* ---------- 4. Por trabajador: barra, ritmo y cambio frente al anterior ---------- */
  function trabajadores (cont, o) {
    const grupos = new Map()
    for (const r of o.filas) {
      const k = String(r.worker_name || '').trim()
      if (!k) continue
      const kk = k.toLowerCase()
      if (!grupos.has(kk)) grupos.set(kk, { nombre: k, filas: [] })
      grupos.get(kk).filas.push(r)
    }
    const lista = [...grupos.values()].map(g => Object.assign(g, resumen(g.filas))).sort((a, b) => b.n - a.n)
    if (!lista.length) { cont.innerHTML = '<p class="viz-vacio">Sin registros en este período.</p>'; return }
    const mx = lista[0].n, total = o.filas.length
    const antes = new Map()
    for (const r of o.anteriores || []) { const k = String(r.worker_name || '').trim().toLowerCase(); if (k) antes.set(k, (antes.get(k) || 0) + 1) }
    const hayAntes = !!(o.anteriores && o.anteriores.length)
    cont.innerHTML = lista.map(t => {
      const pa = antes.get(t.nombre.toLowerCase()) || 0, dd = t.n - pa
      const cambio = !hayAntes ? '' : !pa ? 'nuevo en este período' : dd === 0 ? 'igual que el ' + o.nombreAnterior : (dd > 0 ? '+' : '−') + num(Math.abs(dd)) + ' frente al ' + o.nombreAnterior
      const tip = '<b>' + esc(t.nombre) + '</b>' + num(t.n) + ' autos, el ' + Math.round(t.n / total * 100) + ' % del total' +
        '<span>' + (t.ritmo == null ? 'Ritmo sin datos' : 'Uno cada ' + Math.round(t.ritmo) + ' min') + '</span>' +
        '<span>' + t.dias + (t.dias === 1 ? ' día' : ' días') + ', ' + num(t.porDia, 1) + ' por día</span>' +
        (hayAntes ? '<span>' + num(pa) + ' en el ' + esc(o.nombreAnterior) + '</span>' : '')
      return '<div class="tr-fila" data-tip="' + esc(tip) + '"><div class="tr-cab"><b>' + esc(t.nombre) + '</b><span class="tr-n">' + num(t.n) + '</span></div>' +
        '<div class="tr-pista"><i style="width:' + Math.max(2, t.n / mx * 100).toFixed(1) + '%"></i></div>' +
        '<div class="tr-datos"><span>' + (t.ritmo == null ? 'ritmo —' : '1 cada ' + Math.round(t.ritmo) + ' min') + '</span>' +
        '<span>' + num(t.porDia, 1) + ' por día</span>' +
        (cambio ? '<span class="' + (pa && dd < 0 ? 'flojo' : '') + '">' + esc(cambio) + '</span>' : '') + '</div></div>'
    }).join('')
    conEtiqueta(cont)
  }

  /* ---------- 5. Jornada: del primer auto al último, cada día ---------- */
  function jornada (cont, o) {
    const dias = new Map()
    for (const r of o.filas) {
      const d = new Date(r.client_at); if (isNaN(d)) continue
      const k = claveDia(d)
      if (!dias.has(k)) dias.set(k, { fecha: new Date(d.getFullYear(), d.getMonth(), d.getDate()), t: [] })
      dias.get(k).t.push(d)
    }
    const lista = [...dias.values()].sort((a, b) => a.fecha - b.fecha)
    if (!lista.length) { cont.innerHTML = '<p class="viz-vacio">Sin autos en este período.</p>'; return }
    if (lista.length > 31) { cont.innerHTML = '<p class="viz-vacio">Para ver la jornada de cada día, elige Mes o un período más corto.</p>'; return }
    const minuto = d => d.getHours() * 60 + d.getMinutes()
    let m0 = 24 * 60, m1 = 0
    for (const d of lista) { d.t.sort((a, b) => a - b); m0 = Math.min(m0, minuto(d.t[0])); m1 = Math.max(m1, minuto(d.t[d.t.length - 1])) }
    m0 = Math.floor(Math.min(m0, 7 * 60) / 60) * 60; m1 = Math.ceil(Math.max(m1, 17 * 60) / 60) * 60
    const W = Math.max(260, cont.clientWidth - 32), izq = 54, fila = 26, abajo = 22, H = fila * lista.length + abajo + 4
    const x = m => izq + (m - m0) / (m1 - m0) * (W - izq - 8)
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': 'Hora del primer y del último auto de cada día' })
    for (let h = m0 / 60; h <= m1 / 60; h++) {
      const cada = Math.max(1, Math.ceil(((m1 - m0) / 60) * 30 / (W - izq)))
      if ((h - m0 / 60) % cada) continue
      svg.appendChild(el('line', { x1: x(h * 60), x2: x(h * 60), y1: 0, y2: H - abajo, class: 'viz-rejilla' }))
      svg.appendChild(texto(x(h * 60), H - 6, String(h), { class: 'viz-eje', 'text-anchor': 'middle' }))
    }
    lista.forEach((d, i) => {
      const yy = fila * i + fila / 2 + 2
      const a = d.t[0], b = d.t[d.t.length - 1], dur = (b - a) / 60000
      svg.appendChild(texto(izq - 8, yy + 4, DIAS_C[diaSemana(d.fecha)] + ' ' + d.fecha.getDate(), { class: 'viz-eje', 'text-anchor': 'end' }))
      svg.appendChild(el('rect', { x: x(minuto(a)) - 5, y: yy - 6, width: Math.max(10, x(minuto(b)) - x(minuto(a)) + 10), height: 12, rx: 6, class: 'viz-rango', 'data-marca': 'j' + i }))
      for (const t of d.t) svg.appendChild(el('circle', { cx: x(minuto(t)), cy: yy, r: 3.5, class: 'viz-auto', 'data-marca': 'j' + i }))
      const fecha = DIAS[diaSemana(d.fecha)] + ' ' + d.fecha.getDate() + '/' + (d.fecha.getMonth() + 1)
      const tip = '<b>' + fecha + '</b>De ' + hora(a) + ' a ' + hora(b) + (dur ? ' (' + min(dur) + ')' : '') +
        '<span>' + d.t.length + (d.t.length === 1 ? ' auto' : ' autos') + '</span>'
      svg.appendChild(el('rect', { x: 0, y: fila * i + 2, width: W, height: fila, class: 'viz-hit', 'data-tip': tip, 'data-marca': 'j' + i }))
    })
    cont.innerHTML = ''
    cont.appendChild(svg)
    const ley = document.createElement('div')
    ley.className = 'viz-escala'
    ley.innerHTML = '<span>Hora del día</span><span class="esc"><i class="ley-auto"></i> cada auto</span>'
    cont.appendChild(ley)
    conEtiqueta(cont)
  }

  /* ---------- 7. Marcas: las seis primeras y el resto ---------- */
  function marcas (cont, o) {
    const c = new Map()
    let sin = 0
    for (const r of o.filas) {
      const m = String(r.make || '').trim()
      if (!m) { sin++; continue }
      const k = m.toLowerCase()
      if (!c.has(k)) c.set(k, { etq: m.charAt(0).toUpperCase() + m.slice(1), n: 0 })
      c.get(k).n++
    }
    let l = [...c.values()].sort((a, b) => b.n - a.n)
    if (l.length > 7) { const resto = l.slice(6).reduce((a, x) => a + x.n, 0); l = l.slice(0, 6).concat([{ etq: 'Otras', n: resto, otras: true }]) }
    if (!l.length) { cont.innerHTML = '<p class="viz-vacio">Todavía no hay marcas apuntadas en este período.' + (sin ? ' ' + sin + ' autos sin marca.' : '') + '</p>'; return }
    const mx = Math.max(...l.map(x => x.n)), total = o.filas.length
    cont.innerHTML = l.map(x => '<div class="mc-fila" data-tip="' + esc('<b>' + esc(x.etq) + '</b>' + num(x.n) + ' autos, el ' + Math.round(x.n / total * 100) + ' %') + '">' +
      '<span class="mc-etq">' + esc(x.etq) + '</span><span class="mc-pista"><i class="' + (x.otras ? 'otras' : '') + '" style="width:' + Math.max(2, x.n / mx * 100).toFixed(1) + '%"></i></span>' +
      '<b>' + num(x.n) + '</b></div>').join('') + (sin ? '<p class="viz-nota">' + num(sin) + (sin === 1 ? ' auto sin marca apuntada.' : ' autos sin marca apuntada.') + '</p>' : '')
    conEtiqueta(cont)
  }

  window.Graficos = { indicadores, tendencia, calor, trabajadores, jornada, marcas, resumen, ritmo, ocultar }
})()
