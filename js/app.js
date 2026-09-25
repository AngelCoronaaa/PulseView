/*
 * PulseWeb — visor de formas de onda VCD al estilo PulseView.
 */
(function () {
  'use strict';

  const {
    parseVCD, upperBound, valueAt, valueKind,
    formatValue, formatTime, formatFreq, timeUnitFor, trimZeros,
  } = window.VCD;

  const ROW_H = 36;
  const MAX_INITIAL_ROWS = 64;
  const SNAP_PX = 8;
  const PALETTE = ['#4ade80', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa', '#22d3ee', '#fb923c', '#a3e635', '#e879f9', '#94a3b8'];
  const RADIXES = ['hex', 'dec', 'sdec', 'bin', 'ascii'];
  const RADIX_LABEL = { hex: 'HEX', dec: 'DEC', sdec: '±DEC', bin: 'BIN', ascii: 'ASCII' };
  const C = {
    bg: '#14161b',
    rowAlt: '#171a20',
    rowHover: 'rgba(255,255,255,0.04)',
    grid: 'rgba(255,255,255,0.055)',
    rulerBg: '#1b1e25',
    rulerTick: '#5b6372',
    text: '#d8dde6',
    muted: '#8a93a3',
    x: '#ef4444',
    z: '#eab308',
    a: '#38bdf8',
    b: '#f97316',
    region: 'rgba(56,189,248,0.07)',
    hover: 'rgba(255,255,255,0.35)',
    mono: '11px ui-monospace, Menlo, Consolas, monospace',
    sans: '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    layout: $('layout'), fileInput: $('fileInput'), fileInfo: $('fileInfo'),
    btnSidebar: $('btnSidebar'), btnOpen: $('btnOpen'), btnDemo: $('btnDemo'),
    btnZoomIn: $('btnZoomIn'), btnZoomOut: $('btnZoomOut'), btnFit: $('btnFit'),
    btnZoomAB: $('btnZoomAB'), btnClear: $('btnClear'), btnHelp: $('btnHelp'), snap: $('snap'),
    search: $('search'), btnShowAll: $('btnShowAll'), btnHideAll: $('btnHideAll'), tree: $('tree'),
    namesHeader: $('namesHeader'), names: $('names'), rowsScroll: $('rowsScroll'),
    waveCol: $('waveCol'), wave: $('wave'), ruler: $('ruler'), empty: $('empty'),
    dropOverlay: $('dropOverlay'), tooltip: $('tooltip'), toast: $('toast'), help: $('help'),
    stHover: $('stHover'), stA: $('stA'), stB: $('stB'), stDelta: $('stDelta'),
    stFreq: $('stFreq'), stZoom: $('stZoom'),
  };

  const wctx = el.wave.getContext('2d');
  const rctx = el.ruler.getContext('2d');

  const S = {
    doc: null,
    fileName: '',
    rows: [],          // { v, color, radix }
    rowEls: [],
    start: 0,          // tiempo (en ticks) en el borde izquierdo
    scale: 1,          // ticks por píxel
    cursorA: null,
    cursorB: null,
    hoverX: null,
    hoverRow: -1,
    W: 0, H: 0, RW: 0, dpr: 1,
  };

  // ---------------------------------------------------------------- utilidades
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tToX = (t) => (t - S.start) / S.scale;
  const xToT = (x) => S.start + x * S.scale;
  const ticksToSec = (t) => t * S.doc.info.timescale;
  const fmtT = (t) => formatTime(ticksToSec(t), 4);

  let toastTimer = 0;
  function toast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.className = 'toast' + (isError ? ' error' : ''); }, isError ? 5000 : 2600);
  }

  // ---------------------------------------------------------------- carga
  function loadText(text, name) {
    let doc;
    try {
      doc = parseVCD(text);
    } catch (err) {
      console.error(err);
      toast('Error al leer ' + name + ': ' + err.message, true);
      return;
    }
    if (!doc.vars.length) {
      toast('El archivo no contiene señales ($var).', true);
      return;
    }
    S.doc = doc;
    S.fileName = name;
    S.cursorA = S.cursorB = null;
    S.rows = doc.vars.slice(0, MAX_INITIAL_ROWS).map(makeRow);
    el.empty.classList.add('hidden');
    el.search.value = '';
    const nTrans = [...doc.signals.values()].reduce((a, s) => a + s.times.length, 0);
    el.fileInfo.innerHTML =
      '<b>' + esc(name) + '</b> · ' + doc.vars.length + ' señales · ' +
      nTrans.toLocaleString('es') + ' transiciones · escala ' + esc(doc.info.timescaleStr);
    document.title = name + ' — PulseWeb';
    buildTree();
    renderNames();
    resize();
    fit();
    if (doc.vars.length > MAX_INITIAL_ROWS) {
      toast('Se muestran las primeras ' + MAX_INITIAL_ROWS + ' de ' + doc.vars.length + ' señales. Añade más desde el panel izquierdo.');
    }
  }

  function loadFile(file) {
    if (!file) return;
    el.fileInfo.textContent = 'Cargando ' + file.name + '…';
    file.text().then((text) => loadText(text, file.name), (err) => toast('No se pudo leer el archivo: ' + err.message, true));
  }

  function loadDemo() {
    loadText(window.generateDemoVCD(), 'demo.vcd');
  }

  function makeRow(v) {
    return { v, color: PALETTE[v.uid % PALETTE.length], radix: 'hex' };
  }

  // ---------------------------------------------------------------- árbol de señales
  function buildTree() {
    const doc = S.doc;
    if (!doc) return;
    const shown = new Set(S.rows.map((r) => r.v.uid));
    const q = el.search.value.trim().toLowerCase();

    const varHtml = (v, showPath) =>
      '<label><input type="checkbox" data-uid="' + v.uid + '"' + (shown.has(v.uid) ? ' checked' : '') + '>' +
      (showPath && v.scope ? '<span class="path">' + esc(v.scope) + '.</span>' : '') +
      '<span>' + esc(v.name) + '</span>' +
      '<span class="w">' + (v.sig.isReal ? 'real' : v.width > 1 ? v.width + 'b' : '') + '</span></label>';

    if (q) {
      const hits = doc.vars.filter((v) => v.fullName.toLowerCase().includes(q));
      el.tree.innerHTML = hits.length
        ? '<div class="flat">' + hits.map((v) => varHtml(v, true)).join('') + '</div>'
        : '<p class="muted pad">Sin coincidencias.</p>';
      return;
    }

    const scopeHtml = (sc) =>
      '<details open><summary>' + esc(sc.name) + '<span class="kind">' + esc(sc.type) + '</span></summary>' +
      sc.vars.map((v) => varHtml(v, false)).join('') +
      sc.children.map(scopeHtml).join('') +
      '</details>';

    el.tree.innerHTML =
      doc.root.vars.map((v) => varHtml(v, false)).join('') +
      doc.root.children.map(scopeHtml).join('');
  }

  function visibleTreeVars() {
    return [...el.tree.querySelectorAll('input[data-uid]')].map((i) => S.doc.vars[+i.dataset.uid]);
  }

  el.tree.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-uid]');
    if (!input || !S.doc) return;
    const v = S.doc.vars[+input.dataset.uid];
    if (input.checked) {
      if (!S.rows.some((r) => r.v === v)) S.rows.push(makeRow(v));
    } else {
      S.rows = S.rows.filter((r) => r.v !== v);
    }
    renderNames();
    requestDraw();
  });

  el.search.addEventListener('input', buildTree);

  el.btnShowAll.addEventListener('click', () => {
    if (!S.doc) return;
    const have = new Set(S.rows.map((r) => r.v));
    for (const v of visibleTreeVars()) if (!have.has(v)) S.rows.push(makeRow(v));
    buildTree(); renderNames(); requestDraw();
  });

  el.btnHideAll.addEventListener('click', () => {
    if (!S.doc) return;
    const hide = new Set(visibleTreeVars());
    S.rows = S.rows.filter((r) => !hide.has(r.v));
    buildTree(); renderNames(); requestDraw();
  });

  // ---------------------------------------------------------------- columna de nombres
  function renderNames() {
    el.names.innerHTML = '';
    S.rowEls = S.rows.map((row, i) => {
      const v = row.v;
      const div = document.createElement('div');
      div.className = 'sig-row';
      div.draggable = true;
      div.dataset.i = i;
      div.title = v.fullName + (v.width > 1 ? ' [' + v.width + ' bits]' : '');
      const isBus = v.width > 1 && !v.sig.isReal;
      div.innerHTML =
        '<span class="chip" title="Cambiar color" style="background:' + row.color + '"></span>' +
        '<div class="label"><span class="nm" style="color:' + row.color + '">' + esc(v.name) + '</span><span class="val"></span></div>' +
        (isBus ? '<button class="radix" title="Cambiar base">' + RADIX_LABEL[row.radix] + '</button>' : '') +
        '<button class="rm" title="Ocultar señal">×</button>';
      el.names.appendChild(div);
      return div;
    });
    el.namesHeader.textContent = S.doc ? 'Señales (' + S.rows.length + ')' : 'Señales';
    updateNameValues();
  }

  el.names.addEventListener('click', (e) => {
    const rowEl = e.target.closest('.sig-row');
    if (!rowEl) return;
    const i = +rowEl.dataset.i;
    const row = S.rows[i];
    if (e.target.closest('.rm')) {
      S.rows.splice(i, 1);
      buildTree(); renderNames(); requestDraw();
    } else if (e.target.closest('.radix')) {
      row.radix = RADIXES[(RADIXES.indexOf(row.radix) + 1) % RADIXES.length];
      e.target.textContent = RADIX_LABEL[row.radix];
      requestDraw();
    } else if (e.target.closest('.chip')) {
      row.color = PALETTE[(PALETTE.indexOf(row.color) + 1) % PALETTE.length];
      renderNames(); requestDraw();
    }
  });

  el.names.addEventListener('mousemove', (e) => {
    const rowEl = e.target.closest('.sig-row');
    setHoverRow(rowEl ? +rowEl.dataset.i : -1);
  });
  el.names.addEventListener('mouseleave', () => setHoverRow(-1));

  // Reordenar arrastrando
  let dragFrom = -1;
  el.names.addEventListener('dragstart', (e) => {
    const rowEl = e.target.closest('.sig-row');
    if (!rowEl) return;
    dragFrom = +rowEl.dataset.i;
    rowEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-pulseweb-row', String(dragFrom));
  });
  el.names.addEventListener('dragover', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    const rowEl = e.target.closest('.sig-row');
    clearDropMarks();
    if (!rowEl) return;
    const r = rowEl.getBoundingClientRect();
    rowEl.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  el.names.addEventListener('drop', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rowEl = e.target.closest('.sig-row');
    let to = S.rows.length;
    if (rowEl) {
      const r = rowEl.getBoundingClientRect();
      to = +rowEl.dataset.i + (e.clientY < r.top + r.height / 2 ? 0 : 1);
    }
    const [moved] = S.rows.splice(dragFrom, 1);
    if (to > dragFrom) to--;
    S.rows.splice(to, 0, moved);
    dragFrom = -1;
    renderNames();
    requestDraw();
  });
  el.names.addEventListener('dragend', () => {
    dragFrom = -1;
    clearDropMarks();
    el.names.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  });
  function clearDropMarks() {
    el.names.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  }

  function setHoverRow(i) {
    if (S.hoverRow === i) return;
    if (S.rowEls[S.hoverRow]) S.rowEls[S.hoverRow].classList.remove('hover');
    S.hoverRow = i;
    if (S.rowEls[i]) S.rowEls[i].classList.add('hover');
    requestDraw();
  }

  // Valor mostrado bajo cada nombre: en la posición del ratón, o del cursor A.
  function updateNameValues() {
    if (!S.doc) return;
    const t = S.hoverX != null ? xToT(S.hoverX) : S.cursorA;
    S.rowEls.forEach((div, i) => {
      const row = S.rows[i];
      const span = div.children[1].children[1];
      const text = t == null ? '' : formatValue(valueAt(row.v.sig, t), row.v.width, row.radix, row.v.sig.isReal);
      if (span.textContent !== text) span.textContent = text;
    });
  }

  // ---------------------------------------------------------------- vista / zoom
  function span() { return S.doc.tMax - S.doc.tMin; }

  function clampView() {
    if (!S.doc || !S.W) return;
    const maxScale = (span() * 2) / S.W;
    const minScale = Math.min(1e-3, maxScale);
    S.scale = Math.min(maxScale, Math.max(minScale, S.scale));
    const vis = S.W * S.scale;
    const lo = S.doc.tMin - vis * 0.5;
    const hi = S.doc.tMax - vis * 0.5;
    S.start = Math.min(hi, Math.max(lo, S.start));
  }

  function fit() {
    if (!S.doc || !S.W) return;
    const margin = 16;
    S.scale = span() / Math.max(1, S.W - margin * 2);
    S.start = S.doc.tMin - margin * S.scale;
    clampView();
    requestDraw();
  }

  function zoomAt(factor, x) {
    if (!S.doc) return;
    const t = xToT(x);
    S.scale *= factor;
    clampView();
    S.start = t - x * S.scale;
    clampView();
    requestDraw();
  }

  function zoomAB() {
    if (!S.doc || S.cursorA == null || S.cursorB == null || S.cursorA === S.cursorB) {
      toast('Coloca los cursores A (clic) y B (Shift+clic) primero.');
      return;
    }
    const a = Math.min(S.cursorA, S.cursorB), b = Math.max(S.cursorA, S.cursorB);
    const pad = (b - a) * 0.08;
    S.scale = (b - a + pad * 2) / S.W;
    S.start = a - pad;
    clampView();
    requestDraw();
  }

  function panPx(dx) {
    if (!S.doc) return;
    S.start += dx * S.scale;
    clampView();
    requestDraw();
  }

  // ---------------------------------------------------------------- tamaño
  function resize() {
    S.dpr = window.devicePixelRatio || 1;
    S.W = Math.max(1, el.waveCol.clientWidth);
    S.H = Math.max(1, el.rowsScroll.clientHeight);
    S.RW = Math.max(1, el.ruler.clientWidth);
    for (const [cv, w, h] of [[el.wave, S.W, S.H], [el.ruler, S.RW, 34]]) {
      cv.width = Math.round(w * S.dpr);
      cv.height = Math.round(h * S.dpr);
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
    }
    clampView();
    requestDraw();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(el.rowsScroll);
  ro.observe(el.waveCol);
  window.addEventListener('resize', resize);
  el.rowsScroll.addEventListener('scroll', () => requestDraw());

  // ---------------------------------------------------------------- dibujo
  let drawPending = false;
  function requestDraw() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => {
      drawPending = false;
      draw();
    });
  }

  function draw() {
    drawWave();
    drawRuler();
    updateStatus();
    updateNameValues();
  }

  function tickStep() {
    // Paso "bonito" (1, 2, 5 × 10^k) en ticks para que haya ≥ 90 px entre marcas.
    const raw = 90 * S.scale;
    const e = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (m * e >= raw) return { step: m * e, minor: m === 2 ? 4 : 5 };
    return { step: 10 * e, minor: 5 };
  }

  function drawRuler() {
    const ctx = rctx, W = S.RW, H = 34;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.fillStyle = C.rulerBg;
    ctx.fillRect(0, 0, W, H);
    if (!S.doc) return;

    const { step, minor } = tickStep();
    const tEnd = xToT(W);
    const [unitMul, unitName] = timeUnitFor(ticksToSec(Math.max(Math.abs(S.start), Math.abs(tEnd))));
    const stepInUnit = ticksToSec(step) / unitMul;
    const decimals = Math.max(0, Math.min(9, Math.ceil(-Math.log10(stepInUnit) - 1e-9)));

    ctx.strokeStyle = C.rulerTick;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const mstep = step / minor;
    const k0 = Math.floor(S.start / mstep), k1 = Math.ceil(tEnd / mstep);
    for (let k = k0; k <= k1; k++) {
      const x = Math.round(tToX(k * mstep)) + 0.5;
      const major = k % minor === 0;
      ctx.moveTo(x, H);
      ctx.lineTo(x, H - (major ? 10 : 4));
    }
    ctx.stroke();

    ctx.fillStyle = C.muted;
    ctx.font = C.sans;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (let k = Math.floor(S.start / step); k * step <= tEnd; k++) {
      const t = k * step;
      const x = tToX(t);
      const label = trimZeros((ticksToSec(t) / unitMul).toFixed(decimals)) + ' ' + unitName;
      ctx.fillText(label, Math.round(x) + 3, 6);
    }

    // Etiquetas de cursores y ratón
    const flag = (t, color, text, yTop) => {
      const x = Math.round(tToX(t)) + 0.5;
      if (x < -40 || x > W + 40) return;
      ctx.font = 'bold ' + C.sans;
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = color;
      ctx.fillRect(x - w / 2, yTop, w, 15);
      ctx.fillStyle = '#0b0d10';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, yTop + 8);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    };
    if (S.cursorA != null) flag(S.cursorA, C.a, 'A', H - 15);
    if (S.cursorB != null) flag(S.cursorB, C.b, 'B', H - 15);
    if (S.hoverX != null) flag(xToT(S.hoverX), '#cbd5e1', fmtT(xToT(S.hoverX)), 2);
  }

  function drawWave() {
    const ctx = wctx, W = S.W, H = S.H;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    if (!S.doc) return;

    const scrollTop = el.rowsScroll.scrollTop;
    const first = Math.max(0, Math.floor(scrollTop / ROW_H));
    const last = Math.min(S.rows.length - 1, Math.floor((scrollTop + H) / ROW_H));

    // Fondo de filas alternas y fila bajo el ratón
    for (let i = first; i <= last; i++) {
      const y = i * ROW_H - scrollTop;
      if (i % 2) { ctx.fillStyle = C.rowAlt; ctx.fillRect(0, y, W, ROW_H); }
      if (i === S.hoverRow) { ctx.fillStyle = C.rowHover; ctx.fillRect(0, y, W, ROW_H); }
    }

    // Región entre cursores
    if (S.cursorA != null && S.cursorB != null) {
      const xa = tToX(S.cursorA), xb = tToX(S.cursorB);
      ctx.fillStyle = C.region;
      ctx.fillRect(Math.min(xa, xb), 0, Math.abs(xb - xa), H);
    }

    // Rejilla vertical
    const { step } = tickStep();
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = Math.floor(S.start / step), tEnd = xToT(W); k * step <= tEnd; k++) {
      const x = Math.round(tToX(k * step)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    ctx.stroke();

    // Zona fuera de la captura
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const x0 = tToX(S.doc.tMin), x1 = tToX(S.doc.tMax);
    if (x0 > 0) ctx.fillRect(0, 0, x0, H);
    if (x1 < W) ctx.fillRect(x1, 0, W - x1, H);

    for (let i = first; i <= last; i++) {
      const row = S.rows[i];
      const y = i * ROW_H - scrollTop;
      const sig = row.v.sig;
      if (sig.isReal) drawAnalog(ctx, sig, y, row.color);
      else if (sig.width === 1) drawBit(ctx, sig, y, row.color);
      else drawBus(ctx, sig, y, row);
    }

    // Cursores
    const vline = (t, color, dash) => {
      const x = Math.round(tToX(t)) + 0.5;
      if (x < -1 || x > W + 1) return;
      ctx.strokeStyle = color;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (S.hoverX != null) vline(xToT(S.hoverX), C.hover, [3, 3]);
    if (S.cursorA != null) vline(S.cursorA, C.a);
    if (S.cursorB != null) vline(S.cursorB, C.b);
  }

  // Recorre los segmentos visibles de una señal. Cuando hay varias transiciones
  // dentro de un mismo píxel, las agrupa en un bloque "denso" y salta con
  // búsqueda binaria, de modo que el coste depende del ancho en píxeles y no del
  // número de transiciones.
  function forEachSegment(sig, onSeg, onDense) {
    const { times, values } = sig;
    const n = times.length;
    if (!n) return;
    const tEnd = xToT(S.W + 2);
    const end = S.doc.tMax;
    let i = Math.max(0, upperBound(times, S.start) - 1);
    while (i < n && times[i] <= tEnd) {
      const x0 = tToX(times[i]);
      const x1 = i + 1 < n ? tToX(times[i + 1]) : tToX(end);
      if (x1 - x0 < 1 && i + 1 < n) {
        const j = upperBound(times, xToT(Math.floor(x0) + 2)) - 1;
        if (j > i + 1) {
          onDense(x0, tToX(times[j]), i, j);
          i = j;
          continue;
        }
      }
      onSeg(x0, x1, values[i], i);
      i++;
    }
  }

  function drawBit(ctx, sig, y, color) {
    const top = y + 8.5, bot = y + ROW_H - 8.5, mid = Math.round((top + bot) / 2) + 0.5;
    const W = S.W;
    const line = new Path2D(), fill = new Path2D(), xPath = new Path2D(), zPath = new Path2D(), dense = new Path2D();
    let prevY = null;

    forEachSegment(sig, (x0, x1, v) => {
      const xa = Math.round(Math.max(x0, -2)) + 0.5;
      const xb = Math.round(Math.min(x1, W + 2)) + 0.5;
      if (v === '1' || v === '0' || v === 'z') {
        const yy = v === '1' ? top : v === '0' ? bot : mid;
        if (prevY !== null && prevY !== yy && x0 >= -2) {
          line.moveTo(xa, prevY);
          line.lineTo(xa, yy);
        }
        if (v === 'z') {
          zPath.moveTo(xa, yy);
          zPath.lineTo(xb, yy);
        } else {
          line.moveTo(xa, yy);
          line.lineTo(xb, yy);
        }
        if (v === '1') fill.rect(xa, top, xb - xa, bot - top);
        prevY = yy;
      } else {
        xPath.rect(xa, top, xb - xa, bot - top);
        prevY = null;
      }
    }, (x0, x1) => {
      const xa = Math.round(Math.max(x0, -2)), xb = Math.round(Math.min(Math.max(x1, x0 + 1), W + 2));
      dense.rect(xa, top, Math.max(1, xb - xa), bot - top);
      prevY = null;
    });

    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = color;
    ctx.fill(fill);
    ctx.globalAlpha = 0.55;
    ctx.fill(dense);
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = C.x;
    ctx.fill(xPath);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = C.x;
    ctx.stroke(xPath);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke(line);
    ctx.lineWidth = 1;
    ctx.stroke(dense);
    ctx.strokeStyle = C.z;
    ctx.setLineDash([4, 3]);
    ctx.stroke(zPath);
    ctx.setLineDash([]);
  }

  function realRange(sig) {
    if (!sig.range) {
      let lo = Infinity, hi = -Infinity;
      for (const v of sig.values) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (hi === lo) { hi += 0.5; lo -= 0.5; }
      sig.range = [lo, hi];
    }
    return sig.range;
  }

  function drawAnalog(ctx, sig, y, color) {
    const top = y + 5, bot = y + ROW_H - 5;
    const [lo, hi] = realRange(sig);
    const yOf = (v) => bot - ((v - lo) / (hi - lo)) * (bot - top);
    const W = S.W;
    const path = new Path2D();
    let open = false;
    const to = (x, yy) => { if (open) path.lineTo(x, yy); else { path.moveTo(x, yy); open = true; } };

    forEachSegment(sig, (x0, x1, v) => {
      if (!Number.isFinite(v)) { open = false; return; }
      const yy = yOf(v);
      to(Math.max(x0, -2), yy);
      path.lineTo(Math.min(x1, W + 2), yy);
    }, (x0, x1, i, j) => {
      // Muchas muestras en pocos píxeles: dibuja la envolvente mín/máx.
      let mn = Infinity, mx = -Infinity;
      const stride = Math.max(1, Math.floor((j - i) / 2000));
      for (let k = i; k < j; k += stride) {
        const v = sig.values[k];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (!isFinite(mn)) return;
      const xa = Math.max(x0, -2);
      to(xa, yOf(sig.values[i]));
      path.lineTo(xa, yOf(mx));
      path.lineTo(xa, yOf(mn));
      path.lineTo(Math.max(x1, xa + 1), yOf(sig.values[j]));
    });

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, Math.round(top) + 0.5, W - 1, Math.round(bot - top));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke(path);
    ctx.lineWidth = 1;
  }

  function drawBus(ctx, sig, y, row) {
    const top = y + 8.5, bot = y + ROW_H - 8.5, mid = (top + bot) / 2;
    const W = S.W;
    const width = row.v.width;
    const texts = [];

    ctx.lineWidth = 1;
    ctx.font = C.mono;
    forEachSegment(sig, (x0, x1, v) => {
      const kind = valueKind(v);
      const s = Math.min(4, (x1 - x0) / 2);
      // Recorta a la zona visible (con margen) para evitar coordenadas enormes.
      const L = Math.max(x0, -10), R = Math.min(x1, W + 10);
      const sl = x0 >= -10 ? s : 0, sr = x1 <= W + 10 ? s : 0;
      const p = new Path2D();
      if (kind === 'z') {
        p.moveTo(L, mid);
        p.lineTo(R, mid);
        ctx.strokeStyle = C.z;
        ctx.setLineDash([4, 3]);
        ctx.stroke(p);
        ctx.setLineDash([]);
      } else {
        p.moveTo(L, mid);
        p.lineTo(L + sl, top);
        p.lineTo(R - sr, top);
        p.lineTo(R, mid);
        p.lineTo(R - sr, bot);
        p.lineTo(L + sl, bot);
        p.closePath();
        const color = kind === 'x' ? C.x : row.color;
        ctx.fillStyle = color;
        ctx.globalAlpha = kind === 'x' ? 0.25 : 0.14;
        ctx.fill(p);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.stroke(p);
      }
      // Texto del valor centrado en la parte visible del segmento
      const vx0 = Math.max(x0 + s, 0), vx1 = Math.min(x1 - s, W);
      const avail = vx1 - vx0 - 8;
      if (avail > 8) {
        let text = formatValue(v, width, row.radix, sig.isReal);
        let tw = ctx.measureText(text).width;
        if (tw > avail) {
          let lo = 0, hi = text.length;
          while (lo < hi) {
            const m = (lo + hi + 1) >> 1;
            if (ctx.measureText(text.slice(0, m) + '…').width <= avail) lo = m; else hi = m - 1;
          }
          text = lo > 0 ? text.slice(0, lo) + '…' : '';
        }
        if (text) texts.push([text, (vx0 + vx1) / 2, kind]);
      }
    }, (x0, x1) => {
      const xa = Math.max(x0, -2), xb = Math.min(Math.max(x1, x0 + 1), W + 2);
      ctx.fillStyle = row.color;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(xa, top, xb - xa, bot - top);
      ctx.globalAlpha = 1;
    });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [text, x, kind] of texts) {
      ctx.fillStyle = kind === 'x' ? '#fecaca' : kind === 'z' ? C.z : C.text;
      ctx.fillText(text, x, mid + 0.5);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // ---------------------------------------------------------------- estado
  function updateStatus() {
    if (!S.doc) return;
    el.stHover.textContent = S.hoverX != null ? fmtT(xToT(S.hoverX)) : '—';
    el.stA.textContent = S.cursorA != null ? fmtT(S.cursorA) : '—';
    el.stB.textContent = S.cursorB != null ? fmtT(S.cursorB) : '—';
    if (S.cursorA != null && S.cursorB != null) {
      const d = Math.abs(ticksToSec(S.cursorB - S.cursorA));
      el.stDelta.textContent = formatTime(d, 4);
      el.stFreq.textContent = d > 0 ? formatFreq(1 / d) : '—';
    } else {
      el.stDelta.textContent = el.stFreq.textContent = '—';
    }
    el.stZoom.textContent = formatTime(ticksToSec(S.W * S.scale), 3);
  }

  // ---------------------------------------------------------------- ratón en el canvas
  function snapTime(t, rowIdx) {
    if (!el.snap.checked || !S.rows[rowIdx]) return t;
    const { times } = S.rows[rowIdx].v.sig;
    const i = upperBound(times, t);
    let best = t, bestPx = SNAP_PX + 1;
    for (const j of [i - 1, i]) {
      if (j < 0 || j >= times.length) continue;
      const d = Math.abs(tToX(times[j]) - tToX(t));
      if (d < bestPx) { bestPx = d; best = times[j]; }
    }
    return bestPx <= SNAP_PX ? best : t;
  }

  function canvasPos(e) {
    const r = el.wave.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function rowAtY(y) {
    const i = Math.floor((y + el.rowsScroll.scrollTop) / ROW_H);
    return i >= 0 && i < S.rows.length ? i : -1;
  }

  function nearCursor(x) {
    if (S.cursorA != null && Math.abs(tToX(S.cursorA) - x) <= 5) return 'A';
    if (S.cursorB != null && Math.abs(tToX(S.cursorB) - x) <= 5) return 'B';
    return null;
  }

  let drag = null;

  el.wave.addEventListener('pointerdown', (e) => {
    if (!S.doc || e.button !== 0 || e.ctrlKey) return;
    const { x } = canvasPos(e);
    el.wave.setPointerCapture(e.pointerId);
    const hit = nearCursor(x);
    drag = { mode: hit || 'pan', x0: x, start0: S.start, moved: false, shift: e.shiftKey };
    if (!hit) el.wave.classList.add('panning');
  });

  el.wave.addEventListener('pointermove', (e) => {
    if (!S.doc) return;
    const { x, y } = canvasPos(e);
    const rowIdx = rowAtY(y);
    S.hoverX = x;
    setHoverRow(rowIdx);

    if (drag) {
      if (Math.abs(x - drag.x0) > 3) drag.moved = true;
      if (drag.mode === 'pan' && drag.moved) {
        S.start = drag.start0 - (x - drag.x0) * S.scale;
        clampView();
      } else if (drag.mode === 'A') {
        S.cursorA = snapTime(xToT(x), rowIdx);
      } else if (drag.mode === 'B') {
        S.cursorB = snapTime(xToT(x), rowIdx);
      }
      hideTooltip();
    } else {
      el.wave.classList.toggle('on-cursor', !!nearCursor(x));
      showTooltip(e, rowIdx, xToT(x));
    }
    requestDraw();
  });

  el.wave.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const { x, y } = canvasPos(e);
    if (drag.mode === 'pan' && !drag.moved) {
      const t = snapTime(xToT(x), rowAtY(y));
      if (drag.shift) S.cursorB = t; else S.cursorA = t;
    }
    drag = null;
    el.wave.classList.remove('panning');
    requestDraw();
  });

  el.wave.addEventListener('pointerleave', () => {
    if (drag) return;
    el.wave.classList.remove('on-cursor');
    S.hoverX = null;
    setHoverRow(-1);
    hideTooltip();
    requestDraw();
  });

  el.wave.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!S.doc) return;
    const { x, y } = canvasPos(e);
    S.cursorB = snapTime(xToT(x), rowAtY(y));
    requestDraw();
  });

  el.wave.addEventListener('wheel', (e) => {
    if (!S.doc) return;
    e.preventDefault();
    const { x } = canvasPos(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? S.W : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.shiftKey && !e.ctrlKey) {
      panPx(dy || dx);
    } else if (Math.abs(dx) > Math.abs(dy)) {
      panPx(dx);
    } else {
      // Pellizcar en trackpad llega como ctrl+rueda con deltas pequeños
      const k = e.ctrlKey ? 0.01 : 0.0025;
      zoomAt(Math.exp(dy * k), x);
    }
    hideTooltip();
  }, { passive: false });

  // Clic en la regla: cursor A (Shift: B)
  el.ruler.addEventListener('click', (e) => {
    if (!S.doc) return;
    const x = e.clientX - el.ruler.getBoundingClientRect().left;
    if (e.shiftKey) S.cursorB = xToT(x); else S.cursorA = xToT(x);
    requestDraw();
  });
  el.ruler.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!S.doc) return;
    S.cursorB = xToT(e.clientX - el.ruler.getBoundingClientRect().left);
    requestDraw();
  });

  // ---------------------------------------------------------------- tooltip con mediciones
  function hideTooltip() { el.tooltip.style.display = 'none'; }

  function showTooltip(e, rowIdx, t) {
    const row = S.rows[rowIdx];
    if (!row) return hideTooltip();
    const sig = row.v.sig;
    const { times, values } = sig;
    const i = upperBound(times, t) - 1;
    if (i < 0) return hideTooltip();

    const segStart = times[i];
    const segEnd = i + 1 < times.length ? times[i + 1] : S.doc.tMax;
    const hasEnd = i + 1 < times.length;
    const v = values[i];
    const rows = [];

    if (sig.width === 1 && !sig.isReal) {
      rows.push(['Valor', v === '1' ? '1 (alto)' : v === '0' ? '0 (bajo)' : v === 'z' ? 'Z (alta imp.)' : 'X (desconocido)']);
      rows.push(['Ancho de pulso', hasEnd ? fmtT(segEnd - segStart) : '≥ ' + fmtT(segEnd - segStart)]);
      // Periodo entre flancos de subida consecutivos
      let rise = -1, nextRise = -1;
      if (v === '1' && i + 2 < times.length && values[i + 2] === '1' && values[i + 1] === '0') { rise = i; nextRise = i + 2; }
      else if (v === '0' && i >= 1 && values[i - 1] === '1' && i + 1 < times.length && values[i + 1] === '1') { rise = i - 1; nextRise = i + 1; }
      if (rise >= 0) {
        const period = times[nextRise] - times[rise];
        const high = times[rise + 1] - times[rise];
        rows.push(['Periodo', fmtT(period)]);
        rows.push(['Frecuencia', formatFreq(1 / ticksToSec(period))]);
        rows.push(['Ciclo útil', trimZeros(((100 * high) / period).toFixed(1)) + ' %']);
      }
    } else {
      const w = row.v.width;
      if (sig.isReal) {
        rows.push(['Valor', formatValue(v, w, 'hex', true)]);
        const [lo, hi] = realRange(sig);
        rows.push(['Rango', formatValue(lo, w, 'hex', true) + ' … ' + formatValue(hi, w, 'hex', true)]);
      } else if (valueKind(v) === 'n') {
        rows.push(['Hex', '0x' + formatValue(v, w, 'hex')]);
        rows.push(['Dec', formatValue(v, w, 'dec') + (v[0] === '1' ? '  (' + formatValue(v, w, 'sdec') + ')' : '')]);
        rows.push(['Bin', v.length > 32 ? v.slice(0, 32) + '…' : v]);
      } else {
        rows.push(['Valor', formatValue(v, w, 'hex')]);
        rows.push(['Bin', v.length > 32 ? v.slice(0, 32) + '…' : v]);
      }
      rows.push(['Duración', hasEnd ? fmtT(segEnd - segStart) : '≥ ' + fmtT(segEnd - segStart)]);
    }
    rows.push(['Desde', fmtT(segStart)]);

    el.tooltip.innerHTML =
      '<div class="tt-title"><i style="background:' + row.color + '"></i>' + esc(row.v.fullName) + '</div>' +
      '<table>' + rows.map(([k, val]) => '<tr><td>' + k + '</td><td>' + esc(val) + '</td></tr>').join('') + '</table>';
    el.tooltip.style.display = 'block';
    const tw = el.tooltip.offsetWidth, th = el.tooltip.offsetHeight;
    let left = e.clientX + 16, top = e.clientY + 16;
    if (left + tw > window.innerWidth - 8) left = e.clientX - tw - 16;
    if (top + th > window.innerHeight - 8) top = e.clientY - th - 16;
    el.tooltip.style.left = Math.max(8, left) + 'px';
    el.tooltip.style.top = Math.max(8, top) + 'px';
  }

  // ---------------------------------------------------------------- botones y teclado
  el.btnOpen.addEventListener('click', () => el.fileInput.click());
  el.btnDemo.addEventListener('click', loadDemo);
  el.fileInput.addEventListener('change', () => {
    loadFile(el.fileInput.files[0]);
    el.fileInput.value = '';
  });
  el.empty.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'open') el.fileInput.click();
    else loadDemo();
  });
  el.btnZoomIn.addEventListener('click', () => zoomAt(0.5, S.W / 2));
  el.btnZoomOut.addEventListener('click', () => zoomAt(2, S.W / 2));
  el.btnFit.addEventListener('click', fit);
  el.btnZoomAB.addEventListener('click', zoomAB);
  el.btnClear.addEventListener('click', () => { S.cursorA = S.cursorB = null; requestDraw(); });
  el.btnHelp.addEventListener('click', () => el.help.showModal());
  el.btnSidebar.addEventListener('click', () => {
    const mobile = window.matchMedia('(max-width: 760px)').matches;
    el.layout.classList.toggle(mobile ? 'show-sidebar' : 'no-sidebar');
    requestAnimationFrame(resize);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea') || el.help.open) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      el.fileInput.click();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case '+': case '=': zoomAt(0.5, S.hoverX ?? S.W / 2); break;
      case '-': case '_': zoomAt(2, S.hoverX ?? S.W / 2); break;
      case 'f': case 'F': fit(); break;
      case 'z': case 'Z': zoomAB(); break;
      case 'ArrowLeft': panPx(-S.W * 0.15); break;
      case 'ArrowRight': panPx(S.W * 0.15); break;
      case 'Escape': S.cursorA = S.cursorB = null; requestDraw(); break;
      case '?': el.help.showModal(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------------------------------------------------------------- arrastrar y soltar archivos
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    el.dropOverlay.classList.add('show');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; el.dropOverlay.classList.remove('show'); }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropOverlay.classList.remove('show');
    loadFile(e.dataTransfer.files[0]);
  });

  // ---------------------------------------------------------------- inicio
  resize();
  if (new URLSearchParams(location.search).has('demo')) loadDemo();
})();
