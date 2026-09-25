/*
 * Parser de archivos VCD (Value Change Dump, IEEE 1364) y utilidades de formato.
 * Expone window.VCD (o module.exports en Node).
 */
(function (global) {
  'use strict';

  const UNIT = { s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };

  function parseTimescale(str) {
    const m = str.replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)(s|ms|us|µs|ns|ps|fs)$/i);
    if (!m) return 1e-9;
    return parseFloat(m[1]) * UNIT[m[2].toLowerCase()];
  }

  // Extiende un vector a `width` bits según las reglas de VCD:
  // si el bit más significativo es 0/1 se rellena con 0; si es x/z, con x/z.
  function extend(val, width) {
    if (val.length >= width) return val.length > width ? val.slice(-width) : val;
    const c = val[0];
    const pad = c === 'x' || c === 'z' ? c : '0';
    return pad.repeat(width - val.length) + val;
  }

  function normBit(c) {
    switch (c) {
      case '0': case 'l': case 'L': return '0';
      case '1': case 'h': case 'H': return '1';
      case 'z': case 'Z': return 'z';
      default: return 'x';
    }
  }

  function parseVCD(text) {
    const n = text.length;
    let p = 0;

    function tok() {
      while (p < n && text.charCodeAt(p) <= 32) p++;
      if (p >= n) return null;
      const s = p;
      while (p < n && text.charCodeAt(p) > 32) p++;
      return text.slice(s, p);
    }
    function untilEnd() {
      const parts = [];
      let t;
      while ((t = tok()) !== null && t !== '$end') parts.push(t);
      return parts;
    }

    const info = { date: '', version: '', timescale: 1e-9, timescaleStr: '1 ns' };
    const signals = new Map(); // id -> { id, width, isReal, times, values }
    const vars = [];
    const root = { name: '', type: 'root', children: [], vars: [], parent: null, path: '' };
    let scope = root;
    let sawDefinitions = false;
    let t;

    // --- Cabecera ---
    while ((t = tok()) !== null) {
      if (t === '$enddefinitions') { untilEnd(); sawDefinitions = true; break; }
      switch (t) {
        case '$timescale': {
          const s = untilEnd().join('');
          info.timescaleStr = s.replace(/^(\d+(?:\.\d+)?)/, '$1 ');
          info.timescale = parseTimescale(s);
          break;
        }
        case '$date': info.date = untilEnd().join(' '); break;
        case '$version': info.version = untilEnd().join(' '); break;
        case '$scope': {
          const parts = untilEnd();
          const name = parts[1] || parts[0] || '?';
          const child = {
            name, type: parts[0] || '', children: [], vars: [], parent: scope,
            path: scope.path ? scope.path + '.' + name : name,
          };
          scope.children.push(child);
          scope = child;
          break;
        }
        case '$upscope': untilEnd(); if (scope.parent) scope = scope.parent; break;
        case '$var': {
          const [type = 'wire', sizeStr = '1', id, ...ref] = untilEnd();
          if (!id) break;
          const width = parseInt(sizeStr, 10) || 1;
          const isReal = type === 'real' || type === 'realtime';
          let sig = signals.get(id);
          if (!sig) {
            sig = { id, width, isReal, times: [], values: [] };
            signals.set(id, sig);
          }
          const name = ref.join('') || id;
          const v = {
            uid: vars.length, name, type, width, id, sig,
            scope: scope.path, fullName: scope.path ? scope.path + '.' + name : name,
          };
          scope.vars.push(v);
          vars.push(v);
          break;
        }
        default:
          if (t[0] === '$') untilEnd();
      }
    }

    if (!sawDefinitions && vars.length === 0) {
      throw new Error('No parece un archivo VCD válido (falta $enddefinitions / $var).');
    }

    // --- Cambios de valor ---
    let time = 0;
    let tMin = Infinity, tMax = -Infinity;

    function push(sig, val) {
      const ts = sig.times, vs = sig.values, k = vs.length;
      if (k && ts[k - 1] === time) {
        // Varios cambios en el mismo instante: prevalece el último.
        if (k > 1 && vs[k - 2] === val) { ts.pop(); vs.pop(); } else vs[k - 1] = val;
        return;
      }
      if (k && vs[k - 1] === val) return;
      ts.push(time);
      vs.push(val);
    }

    while ((t = tok()) !== null) {
      const c = t[0];
      if (c === '#') {
        time = Number(t.slice(1));
        if (time < tMin) tMin = time;
        if (time > tMax) tMax = time;
        continue;
      }
      if (c === '$') {
        if (t === '$comment') untilEnd();
        continue; // $dumpvars, $dumpall, $dumpon, $dumpoff, $end
      }
      if (c === 'b' || c === 'B') {
        const id = tok();
        const sig = signals.get(id);
        if (sig) {
          let val = '';
          for (let i = 1; i < t.length; i++) val += normBit(t[i]);
          push(sig, extend(val || 'x', sig.width));
        }
        continue;
      }
      if (c === 'r' || c === 'R') {
        const id = tok();
        const sig = signals.get(id);
        if (sig) push(sig, parseFloat(t.slice(1)));
        continue;
      }
      // Cambio escalar: <valor><id>
      const sig = signals.get(t.slice(1));
      if (sig) {
        const b = normBit(c);
        push(sig, sig.width > 1 ? b.repeat(sig.width) : b);
      }
    }

    if (!isFinite(tMin)) { tMin = 0; tMax = 0; }
    if (tMax <= tMin) tMax = tMin + 1;

    return { info, root, vars, signals, tMin, tMax };
  }

  // Índice del primer elemento > t (arr ordenado ascendente).
  function upperBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function valueAt(sig, t) {
    const i = upperBound(sig.times, t) - 1;
    return i < 0 ? null : sig.values[i];
  }

  // 'n' normal, 'x' desconocido / mezcla, 'z' alta impedancia
  function valueKind(val) {
    if (typeof val === 'number') return isNaN(val) ? 'x' : 'n';
    if (val == null) return 'x';
    let hasX = false, allZ = true;
    for (let i = 0; i < val.length; i++) {
      const c = val[i];
      if (c !== 'z') allZ = false;
      if (c === 'x' || c === 'z') hasX = true;
    }
    if (allZ) return 'z';
    return hasX ? 'x' : 'n';
  }

  function formatValue(val, width, radix, isReal) {
    if (val == null) return '';
    if (isReal || typeof val === 'number') {
      return Number.isFinite(val) ? String(+val.toPrecision(6)) : String(val);
    }
    if (width === 1 || radix === 'bin') return val;
    const kind = valueKind(val);
    if (kind === 'z') return 'Z';

    if (radix === 'hex' || kind === 'x') {
      const padded = '0'.repeat((4 - (val.length % 4)) % 4) + val;
      let out = '';
      for (let i = 0; i < padded.length; i += 4) {
        const nib = padded.slice(i, i + 4);
        if (/^[01]{4}$/.test(nib)) out += parseInt(nib, 2).toString(16).toUpperCase();
        else if (/^z+$/.test(nib)) out += 'z';
        else if (/^x+$/.test(nib)) out += 'x';
        else out += /x/.test(nib) ? 'X' : 'Z';
      }
      return out;
    }
    if (radix === 'dec') return BigInt('0b' + val).toString();
    if (radix === 'sdec') {
      let v = BigInt('0b' + val);
      if (val[0] === '1') v -= 1n << BigInt(val.length);
      return v.toString();
    }
    if (radix === 'ascii') {
      const padded = '0'.repeat((8 - (val.length % 8)) % 8) + val;
      let out = '';
      for (let i = 0; i < padded.length; i += 8) {
        const code = parseInt(padded.slice(i, i + 8), 2);
        out += code >= 32 && code < 127 ? String.fromCharCode(code) : '·';
      }
      return "'" + out + "'";
    }
    return val;
  }

  const TIME_UNITS = [[1, 's'], [1e-3, 'ms'], [1e-6, 'µs'], [1e-9, 'ns'], [1e-12, 'ps'], [1e-15, 'fs']];

  function trimZeros(s) {
    return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
  }

  function timeUnitFor(sec) {
    const a = Math.abs(sec);
    for (const u of TIME_UNITS) if (a >= u[0] * 0.999999) return u;
    return TIME_UNITS[TIME_UNITS.length - 1];
  }

  function formatTime(sec, digits = 4) {
    if (!isFinite(sec)) return '—';
    if (sec === 0) return '0 s';
    const [m, u] = timeUnitFor(sec);
    return trimZeros((sec / m).toFixed(digits)) + ' ' + u;
  }

  function formatFreq(hz) {
    if (!isFinite(hz) || hz <= 0) return '—';
    const units = [[1e9, 'GHz'], [1e6, 'MHz'], [1e3, 'kHz'], [1, 'Hz']];
    for (const [m, u] of units) if (hz >= m * 0.999999) return trimZeros((hz / m).toFixed(4)) + ' ' + u;
    return trimZeros(hz.toFixed(4)) + ' Hz';
  }

  const api = {
    parseVCD, parseTimescale, upperBound, valueAt, valueKind,
    formatValue, formatTime, formatFreq, timeUnitFor, trimZeros,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.VCD = api;
})(typeof window !== 'undefined' ? window : globalThis);
