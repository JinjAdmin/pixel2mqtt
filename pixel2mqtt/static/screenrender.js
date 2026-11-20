// .scr info screens: a faithful JS port of pixeld's renderer (pixeld-h6631/src/screens.c), so the editor shows
// exactly what the panel draws. Spec: pixeld-h6631/docs/SCREENS.md; parity is checked against pixeld's golden
// frames (pixeld-h6631/tests/screens) by tests/test_screens.js. Where C uses float32 or printf rounding, so does this.
// Works in the browser (window.ScreenRender) and in Node (require).
(function (root) {
  "use strict";
  const W = 52, H = 32;
  const NVAL = 128, NSER = 64, NEL = 32, NERR = 8;
  const f32 = Math.fround;

  /* ------------------------------------------------------------------ fonts */
  // 5x7 ASCII 0x20..0x7E, column bytes, bit0 = top row (pixeld.c F5)
  const F5 = [
    [0,0,0,0,0],[0,0,0x5F,0,0],[0,7,0,7,0],[0x14,0x7F,0x14,0x7F,0x14],[0x24,0x2A,0x7F,0x2A,0x12],
    [0x23,0x13,8,0x64,0x62],[0x36,0x49,0x56,0x20,0x50],[0,5,3,0,0],[0,0x1C,0x22,0x41,0],[0,0x41,0x22,0x1C,0],
    [0x2A,0x1C,0x7F,0x1C,0x2A],[8,8,0x3E,8,8],[0,0x50,0x30,0,0],[8,8,8,8,8],[0,0x60,0x60,0,0],
    [0x20,0x10,8,4,2],[0x3E,0x51,0x49,0x45,0x3E],[0,0x42,0x7F,0x40,0],[0x42,0x61,0x51,0x49,0x46],[0x21,0x41,0x45,0x4B,0x31],
    [0x18,0x14,0x12,0x7F,0x10],[0x27,0x45,0x45,0x45,0x39],[0x3C,0x4A,0x49,0x49,0x30],[1,0x71,9,5,3],[0x36,0x49,0x49,0x49,0x36],
    [6,0x49,0x49,0x29,0x1E],[0,0x36,0x36,0,0],[0,0x56,0x36,0,0],[8,0x14,0x22,0x41,0],[0x14,0x14,0x14,0x14,0x14],
    [0,0x41,0x22,0x14,8],[2,1,0x51,9,6],[0x32,0x49,0x79,0x41,0x3E],[0x7E,0x11,0x11,0x11,0x7E],[0x7F,0x49,0x49,0x49,0x36],
    [0x3E,0x41,0x41,0x41,0x22],[0x7F,0x41,0x41,0x22,0x1C],[0x7F,0x49,0x49,0x49,0x41],[0x7F,9,9,9,1],[0x3E,0x41,0x49,0x49,0x7A],
    [0x7F,8,8,8,0x7F],[0,0x41,0x7F,0x41,0],[0x20,0x40,0x41,0x3F,1],[0x7F,8,0x14,0x22,0x41],[0x7F,0x40,0x40,0x40,0x40],
    [0x7F,2,0x0C,2,0x7F],[0x7F,4,8,0x10,0x7F],[0x3E,0x41,0x41,0x41,0x3E],[0x7F,9,9,9,6],[0x3E,0x41,0x51,0x21,0x5E],
    [0x7F,9,0x19,0x29,0x46],[0x46,0x49,0x49,0x49,0x31],[1,1,0x7F,1,1],[0x3F,0x40,0x40,0x40,0x3F],[0x1F,0x20,0x40,0x20,0x1F],
    [0x3F,0x40,0x38,0x40,0x3F],[0x63,0x14,8,0x14,0x63],[7,8,0x70,8,7],[0x61,0x51,0x49,0x45,0x43],[0,0x7F,0x41,0x41,0],
    [2,4,8,0x10,0x20],[0,0x41,0x41,0x7F,0],[4,2,1,2,4],[0x40,0x40,0x40,0x40,0x40],[0,1,2,4,0],
    [0x20,0x54,0x54,0x54,0x78],[0x7F,0x48,0x44,0x44,0x38],[0x38,0x44,0x44,0x44,0x20],[0x38,0x44,0x44,0x48,0x7F],[0x38,0x54,0x54,0x54,0x18],
    [8,0x7E,9,1,2],[0x0C,0x52,0x52,0x52,0x3E],[0x7F,8,4,4,0x78],[0,0x44,0x7D,0x40,0],[0x20,0x40,0x44,0x3D,0],
    [0x7F,0x10,0x28,0x44,0],[0,0x41,0x7F,0x40,0],[0x7C,4,0x18,4,0x78],[0x7C,8,4,4,0x78],[0x38,0x44,0x44,0x44,0x38],
    [0x7C,0x14,0x14,0x14,8],[8,0x14,0x14,0x18,0x7C],[0x7C,8,4,4,8],[0x48,0x54,0x54,0x54,0x20],[4,0x3F,0x44,0x40,0x20],
    [0x3C,0x40,0x40,0x20,0x7C],[0x1C,0x20,0x40,0x20,0x1C],[0x3C,0x40,0x30,0x40,0x3C],[0x44,0x28,0x10,0x28,0x44],[0x0C,0x50,0x50,0x50,0x3C],
    [0x44,0x64,0x54,0x4C,0x44],[0,8,0x36,0x41,0],[0,0,0x7F,0,0],[0,0x41,0x36,8,0],[0x10,8,8,0x10,8],
  ];
  // tiny 3x5 (features.c T3): rows, bit 4 = left column
  const T3 = {
    "0": [7,5,5,5,7], "1": [2,6,2,2,7], "2": [7,1,7,4,7], "3": [7,1,3,1,7], "4": [5,5,7,1,1], "5": [7,4,7,1,7],
    "6": [7,4,7,5,7], "7": [7,1,1,2,2], "8": [7,5,7,5,7], "9": [7,5,7,1,7], "-": [0,0,7,0,0], "+": [0,2,7,2,0],
    ".": [0,0,0,0,2], ":": [0,2,0,2,0], "%": [5,1,2,4,5], "/": [1,1,2,4,4], "*": [2,5,2,0,0], " ": [0,0,0,0,0],
    A: [2,5,7,5,5], B: [6,5,6,5,6], C: [7,4,4,4,7], D: [6,5,5,5,6], E: [7,4,6,4,7], F: [7,4,6,4,4],
    G: [7,4,5,5,7], H: [5,5,7,5,5], I: [7,2,2,2,7], J: [1,1,1,5,7], K: [5,5,6,5,5], L: [4,4,4,4,7],
    M: [5,7,7,5,5], N: [6,5,5,5,5], O: [7,5,5,5,7], P: [7,5,7,4,4], Q: [7,5,5,7,1], R: [6,5,6,5,5],
    S: [7,4,7,1,7], T: [7,2,2,2,2], U: [5,5,5,5,7], V: [5,5,5,5,2], W: [5,5,7,7,5], X: [5,5,2,5,5],
    Y: [5,5,2,2,2], Z: [7,1,2,4,7],
    ",": [0,0,0,2,4], "!": [2,2,2,0,2], "?": [7,1,2,0,2], "(": [1,2,2,2,1], ")": [4,2,2,2,4], "=": [0,7,0,7,0],
    "_": [0,0,0,0,7], "$": [3,6,2,3,6], "#": [5,7,5,7,5], "<": [1,2,4,2,1], ">": [4,2,1,2,4], "'": [2,2,0,0,0],
    '"': [5,5,0,0,0],
  };
  const FADV = [4, 6, 12, 18], FGW = [3, 5, 10, 15], FH = [5, 7, 14, 21];
  const FONT_IDS = { tiny: 0, small: 1, big: 2, huge: 3 }, FONT_NAMES = ["tiny", "small", "big", "huge"];
  const FONTS = { tiny: { gw: 3, gh: 5 }, small: { gw: 5, gh: 7 }, big: { gw: 10, gh: 14 }, huge: { gw: 15, gh: 21 } };

  /* ------------------------------------------------------------------ C helpers */
  const enc = new TextEncoder(), dec = new TextDecoder();
  const bytes = s => enc.encode(s);
  const cut = (s, n) => { const b = bytes(s); return b.length <= n ? s : dec.decode(b.subarray(0, n)); };   // snprintf into n+1
  const llround = x => x < 0 ? -Math.round(-x) : Math.round(x);   // round half away from zero
  // printf("%.*f"): exact binary ties round to even, like glibc
  function fixed(v, d) {
    if (!isFinite(v)) return String(v);
    const p = 10 ** d, x = Math.abs(v) * p, fl = Math.floor(x);
    if (x - fl === 0.5 && Number.isInteger(x * 2)) {
      const r = (fl % 2 === 0 ? fl : fl + 1) / p;
      return (v < 0 ? "-" : "") + r.toFixed(d);
    }
    return v.toFixed(d);
  }
  function strtodFull(s) {   // strtod with nothing left over; NaN if not a number
    if (typeof s !== "string") return NaN;
    const m = /^[ \t\n\r\f\v]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/.exec(s);
    return m ? parseFloat(m[1]) : NaN;
  }
  function strtodPrefix(s) {   // strtod: the number at the start and the rest, or null
    const m = /^[ \t\n\r\f\v]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(s);
    return m ? { v: parseFloat(m[1]), rest: s.slice(m[0].length) } : null;
  }
  const atoi = s => { const m = /^[ \t]*([+-]?\d+)/.exec(s || ""); return m ? parseInt(m[1], 10) : 0; };
  const atof = s => { const r = strtodPrefix(s || ""); return r ? r.v : 0; };
  const trimC = s => s.replace(/^[ \t]+|[ \t]+$/g, "");
  const unquote = s => s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0] ? s.slice(1, -1) : s;
  const strcasecmp = (a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; };
  const vnameOk = s => /^[a-z0-9_.-]{1,31}$/.test(s);
  const NAME_RE = /^[a-z0-9_.-]{1,31}$/;
  function numStr(v) {   // integers without decimals, else up to 2 decimals (4 below 1), zeros trimmed
    if (Math.abs(v - llround(v)) < 1e-9 && Math.abs(v) < 1e15) return String(llround(v));
    let s = fixed(v, Math.abs(v) < 1 ? 4 : 2);
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }
  function utf8cps(s) {   // pixeld's utf8_next over the UTF-8 bytes: 1-3 byte sequences, anything else -> '?'
    const b = typeof s === "string" ? bytes(s) : s, out = [];
    for (let i = 0; i < b.length;) {
      let cp = b[i++];
      if (cp >= 0xC0 && cp < 0xE0 && i < b.length && (b[i] & 0xC0) === 0x80) cp = ((cp & 31) << 6) | (b[i++] & 63);
      else if (cp >= 0xE0 && cp < 0xF0 && i + 1 < b.length && (b[i] & 0xC0) === 0x80 && (b[i + 1] & 0xC0) === 0x80) { cp = ((cp & 15) << 12) | ((b[i] & 63) << 6) | (b[i + 1] & 63); i += 2; }
      else if (cp >= 0x80) { while (i < b.length && (b[i] & 0xC0) === 0x80) i++; cp = 0x3F; }
      out.push(cp);
    }
    return out;
  }

  /* ------------------------------------------------------------------ values */
  // values: { name: {type: "num"|"str"|"ser", num, str, unit, ser: [float32], upd (s)} }
  // setValue applies one key of a values/set message; applyMessage a whole object (in key order).
  function setValue(values, key, raw, nowSec) {
    const name = String(key).toLowerCase();
    if (!vnameOk(name)) return false;
    const slot = () => {
      if (values[name]) return values[name];
      const keys = Object.keys(values);
      if (keys.length >= NVAL) { let o = keys[0]; for (const k of keys) if (values[k].upd < values[o].upd) o = k; delete values[o]; }
      return (values[name] = {});
    };
    if (raw === null) { delete values[name]; return true; }
    if (typeof raw === "string") { Object.assign(slot(), { type: "str", str: cut(raw.replace(/[\n\t]/g, " "), 63), unit: "", ser: [], upd: nowSec }); return true; }
    if (typeof raw === "boolean") { Object.assign(slot(), { type: "str", str: raw ? "true" : "false", unit: "", ser: [], upd: nowSec }); return true; }
    if (typeof raw === "number") { Object.assign(slot(), { type: "num", num: raw, unit: "", ser: [], upd: nowSec }); return true; }
    if (Array.isArray(raw)) {
      const ser = []; let unit = "";
      for (const x of raw) {
        if (typeof x === "string") { if (ser.length === 1 && !unit) unit = cut(x, 7); }
        else if (typeof x === "number") { if (ser.length < NSER) ser.push(f32(x)); else { ser.shift(); ser.push(f32(x)); } }
      }
      if (unit && ser.length === 1) Object.assign(slot(), { type: "num", num: ser[0], unit, ser: [], upd: nowSec });
      else Object.assign(slot(), { type: "ser", ser, unit: "", upd: nowSec });
      return true;
    }
    return false;   // objects aren't supported
  }
  function applyMessage(values, obj, nowSec) { let n = 0; for (const [k, v] of Object.entries(obj)) if (setValue(values, k, v, nowSec)) n++; return n; }

  const WDAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], MON3 = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const BUILTINS = ["time", "date", "weekday", "month", "day", "hour", "minute", "second", "year"];
  const pad2 = n => String(n).padStart(2, "0");
  function tm(ctx, sec) {   // localtime (or UTC when ctx.utc, like the golden frames' TZ=UTC0)
    const d = new Date(Math.floor(sec) * 1000);
    return ctx.utc ? { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay(), mon: d.getUTCMonth(), md: d.getUTCDate(), y: d.getUTCFullYear() }
      : { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds(), wd: d.getDay(), mon: d.getMonth(), md: d.getDate(), y: d.getFullYear() };
  }
  const fmtClock = (ctx, h, m) => ctx.h12 ? `${(h + 11) % 12 + 1}:${pad2(m)}` : `${pad2(h)}:${pad2(m)}`;
  function valGet(name, ctx) {
    const v = ctx.values[name];
    if (v) return v;
    const t = tm(ctx, ctx.now), b = { upd: ctx.now, unit: "", ser: [] };
    switch (name) {
      case "time": return Object.assign(b, { type: "str", str: fmtClock(ctx, t.h, t.m) });
      case "date": return Object.assign(b, { type: "str", str: `${WDAY[t.wd]} ${MON3[t.mon]} ${t.md}` });
      case "weekday": return Object.assign(b, { type: "str", str: WDAY[t.wd] });
      case "month": return Object.assign(b, { type: "str", str: MON3[t.mon] });
      case "day": return Object.assign(b, { type: "num", num: t.md });
      case "hour": return Object.assign(b, { type: "num", num: t.h });
      case "minute": return Object.assign(b, { type: "num", num: t.m });
      case "second": return Object.assign(b, { type: "num", num: t.s });
      case "year": return Object.assign(b, { type: "num", num: t.y });
    }
    if (name.length > 6 && name.endsWith(".trend")) {
      const s = ctx.values[name.slice(0, -6)];
      if (s && s.type === "ser" && s.ser.length >= 2) return Object.assign(b, { type: "num", num: f32(s.ser[s.ser.length - 1] - s.ser[0]), upd: s.upd });
    }
    return null;
  }
  function valText(v) {
    if (!v) return "";
    if (v.type === "str") return v.str;
    if (v.type === "num") return numStr(v.num);
    if (v.type === "ser" && v.ser.length) return numStr(v.ser[v.ser.length - 1]);
    return "";
  }
  function valNum(v) {   // number or NaN
    if (!v) return NaN;
    if (v.type === "num") return v.num;
    if (v.type === "ser" && v.ser.length) return v.ser[v.ser.length - 1];
    if (v.type === "str") return strtodFull(v.str);
    return NaN;
  }

  /* ------------------------------------------------------------------ conditions */
  const CERR = (ctx, msg) => { if (ctx.check) ctx.check.push(msg); };   // load-time check: collect expression errors
  function litCmp(v, lit) {
    const b = strtodFull(lit), a = valNum(v);
    if (!isNaN(b) && !isNaN(a)) return a < b ? -1 : a > b ? 1 : 0;
    return strcasecmp(cut(valText(v), 63), lit);
  }
  const OPS = ["==", "!=", "<=", ">=", "<", ">"];
  function termEval(term, ctx, st) {
    term = trimC(term);
    if (term[0] === "!") return !termEval(term.slice(1), ctx, st);
    if (!term) { CERR(ctx, "empty condition"); return false; }
    if (term.startsWith("has(") || term.startsWith("fresh(")) {
      const fr = term[0] === "f", a0 = term.indexOf("(") + 1, z = term.indexOf(")", a0);
      if (z < 0) { CERR(ctx, "missing ')'"); return false; }
      const v = valGet(trimC(term.slice(a0, z)), ctx);
      if (!v) return false;
      return fr ? ctx.now - v.upd <= ctx.stale : true;
    }
    const inAt = term.indexOf(" in ");
    if (inAt >= 0) {
      const name = trimC(cut(term.slice(0, inAt), 31)), v = valGet(name, ctx);
      if (!v) { if (!BUILTINS.includes(name)) st.missing = true; return false; }
      for (let it of cut(term.slice(inAt + 4), 159).split(",")) { if (!it) continue; it = unquote(trimC(it)); if (litCmp(v, it) === 0) return true; }
      return false;
    }
    let best = -1, op = -1;
    OPS.forEach((o, i) => { const f = term.indexOf(o); if (f >= 0 && (best < 0 || f < best)) { best = f; op = i; } });
    if (best < 0) {   // a bare name: true if it exists and isn't false/off/0/empty
      const v = valGet(term, ctx);
      if (!v) { if (!vnameOk(term)) CERR(ctx, `bad condition '${term.slice(0, 30)}'`); else st.missing = true; return false; }
      const t = cut(valText(v), 63);
      return !!t && t !== "0" && t.toLowerCase() !== "false" && t.toLowerCase() !== "off";
    }
    const name = trimC(cut(term.slice(0, best), 31)), lit = unquote(trimC(cut(term.slice(best + OPS[op].length), 63)));
    if (ctx.check && !vnameOk(name)) CERR(ctx, `bad value name '${name.slice(0, 24)}'`);
    const v = valGet(name, ctx);
    if (!v) { st.missing = true; return op === 1; }
    const c = litCmp(v, lit);
    return [c === 0, c !== 0, c <= 0, c >= 0, c < 0, c > 0][op];
  }
  function condEval(cond, ctx, st = {}) {
    if (!cond) return true;
    let any = false;
    for (const part of cut(cond, 399).split("||")) {
      let all = true;
      for (const t of part.split("&&")) if (!termEval(t, ctx, st)) all = false;
      if (all) any = true;
    }
    return any;
  }

  /* ------------------------------------------------------------------ colours: "#rrggbb", rules "cond:#c;cond:#c;#default" */
  function hexcol(s) {
    if (!/^#[0-9a-fA-F]{6}/.test(s)) return null;
    const m = /^#([0-9a-fA-F]+)/.exec(s), n = Number(BigInt("0x" + m[1]) & 0xFFFFFFn);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function colorEval(spec, def, ctx) {
    if (!spec) return def;
    for (let r of cut(spec, 399).split(";")) {
      if (!r) continue;
      r = trimC(r);
      const k = r.indexOf(":#");
      if (k < 0) { const c = hexcol(r); if (!c) CERR(ctx, `bad colour '${r.slice(0, 20)}'`); return c || def; }
      if (condEval(r.slice(0, k), ctx)) { const c = hexcol(r.slice(k + 1)); if (!c) CERR(ctx, `bad colour '${r.slice(k + 1, k + 21)}'`); return c || def; }
      if (ctx.check && !hexcol(r.slice(k + 1))) CERR(ctx, `bad colour '${r.slice(k + 1, k + 21)}'`);
    }
    return def;
  }

  /* ------------------------------------------------------------------ time parsing (time/ago): epoch, ISO 8601, "HH:MM" */
  function daysCivil(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    const era = Math.trunc((y >= 0 ? y : y - 399) / 400), yoe = y - era * 400;
    const doy = Math.trunc((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1, doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }
  function parseTs(s, ctx) {
    const v = strtodFull(s);
    if (!isNaN(v) && v > 1e8) return v;
    const m = /^\s*([+-]?\d+)-\s*([+-]?\d+)-\s*([+-]?\d+)[T ]+\s*([+-]?\d+):\s*([+-]?\d+)/.exec(s);
    if (!m) return null;
    const [Y, M, D, h, mi] = m.slice(1).map(Number);
    let p = s.slice(s.indexOf(":") + 3), sec = 0;
    if (p[0] === ":") { const r = strtodPrefix(p.slice(1)); if (r) { sec = r.v; p = r.rest; } else p = p.slice(1); }
    const ts = daysCivil(Y, M, D) * 86400 + h * 3600 + mi * 60;
    if (p[0] === "Z") return ts + sec;
    if (p[0] === "+" || p[0] === "-") { const o = /^(\d+)(?::(\d+))?/.exec(p.slice(1)) || [0, 0, 0]; return ts - ((+o[1] || 0) * 60 + (+o[2] || 0)) * 60 * (p[0] === "-" ? -1 : 1) + sec; }
    const local = ctx.utc ? Date.UTC(Y, M - 1, D, h, mi) : new Date(Y, M - 1, D, h, mi).getTime();
    return local / 1000 + sec;
  }

  /* ------------------------------------------------------------------ templates: "text {name|fmt|fmt:arg} text" */
  function applyFmt(f, fmt, ctx) {
    const c = fmt.indexOf(":");
    const name = (c >= 0 ? fmt.slice(0, c) : fmt).slice(0, 15), arg = c >= 0 ? cut(fmt.slice(c + 1), 95) : "";
    if (!f.isnum) { const d = strtodFull(f.s); if (!isNaN(d)) { f.isnum = true; f.num = d; } }
    switch (name) {
      case "int": if (f.isnum) { f.num = llround(f.num); f.s = numStr(f.num); f.fixed = true; } break;
      case "dec": if (f.isnum) { const n = Math.max(0, Math.min(6, atoi(arg))); f.s = fixed(f.num, n); f.fixed = true; } break;
      case "thousands": {
        if (f.isnum && !f.fixed && Math.abs(f.num) >= 1000) f.s = String(llround(f.num));
        const m = /^([+-]?)(\d*)([\s\S]*)$/.exec(f.s);
        f.s = cut(m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + m[3], 127);
        break;
      }
      case "pct": if (f.isnum) f.s = fixed(f.num, 1) + "%"; break;
      case "sign": if (f.isnum && f.num > 0 && f.s[0] !== "+") f.s = cut("+" + f.s, 127); break;
      case "dur": if (f.isnum) {
        const mul = arg === "h" ? 3600 : arg === "s" ? 1 : 60;
        let s = llround(f.num * mul); if (s < 0) s = 0;
        f.s = s < 60 ? `${s}S` : s < 3600 ? `${Math.floor(s / 60)}M` : s < 86400 ? `${Math.floor(s / 3600)}H${pad2(Math.floor(s / 60) % 60)}M` : `${Math.floor(s / 86400)}D${Math.floor(s / 3600) % 24}H`;
      } break;
      case "temp": if (f.isnum) {
        const inF = f.unit ? /[Ff]/.test(f.unit) : !!ctx.fahrenheit;
        const cc = inF ? (f.num - 32) * 5 / 9 : f.num, d = ctx.fahrenheit ? cc * 9 / 5 + 32 : cc;
        f.s = String(llround(d));
      } break;
      case "time": case "ago": {
        const hm = /^\s*([+-]?\d+):\s*([+-]?\d+)/.exec(f.s);
        let ts;
        if (name === "time" && bytes(f.s).length <= 8 && hm) f.s = fmtClock(ctx, +hm[1], +hm[2]);
        else if ((ts = parseTs(f.s, ctx)) !== null || (f.isnum && f.num > 1e8 && ((ts = f.num), true))) {
          if (name === "time") { const t = tm(ctx, ts); f.s = fmtClock(ctx, t.h, t.m); }
          else {
            let a = ctx.now - ts; if (a < 0) a = 0;
            f.s = a < 60 ? "JUST NOW" : a < 3600 ? `${Math.trunc(a / 60)}M AGO` : a < 86400 ? `${Math.trunc(a / 3600)}H AGO` : `${Math.trunc(a / 86400)}D AGO`;
          }
        }
        f.isnum = false; break;
      }
      case "upper": f.s = f.s.replace(/[a-z]/g, ch => ch.toUpperCase()); f.isnum = false; break;
      case "lower": f.s = f.s.replace(/[A-Z]/g, ch => ch.toLowerCase()); f.isnum = false; break;
      case "trunc": { const n = atoi(arg); if (n >= 0 && n < 128) f.s = dec.decode(bytes(f.s).subarray(0, n)); f.isnum = false; break; }
      case "replace": {
        const eq = arg.indexOf("=");
        if (eq <= 0) { CERR(ctx, "replace needs from=to"); return; }
        f.s = cut(f.s.split(arg.slice(0, eq)).join(arg.slice(eq + 1)), 127); f.isnum = false; break;
      }
      case "or": if (!f.s) { f.s = arg; f.isnum = false; } break;
      case "map": {
        let def = null;
        for (const it of arg.split(",")) {
          if (!it) continue;
          const eq = it.indexOf("=");
          if (eq < 0) { CERR(ctx, "map item without '='"); continue; }
          const k = it.slice(0, eq);
          if (k === "*") def = cut(it.slice(eq + 1), 47);
          else if (strcasecmp(k, f.s) === 0) { f.s = it.slice(eq + 1); f.isnum = false; return; }
        }
        if (def !== null) { f.s = def; f.isnum = false; }
        break;
      }
      default: CERR(ctx, `unknown formatter '${name.slice(0, 15)}'`);
    }
  }
  function tmplEval(t, ctx) {
    let out = "", i = 0;
    while (i < t.length) {
      if (t[i] === "{" && t[i + 1] === "{") { out += "{"; i += 2; continue; }
      if (t[i] === "}" && t[i + 1] === "}") { out += "}"; i += 2; continue; }
      if (t[i] !== "{") { out += t[i++]; continue; }
      const z = t.indexOf("}", i);
      if (z < 0) { CERR(ctx, "missing '}'"); break; }
      const parts = cut(t.slice(i + 1, z), 159).split("|").filter(Boolean);
      i = z + 1;
      const f = { s: "", isnum: false, fixed: false, num: 0, unit: "" };
      if (parts.length) {
        const nm = trimC(parts[0]);
        if (ctx.check && !vnameOk(nm)) CERR(ctx, `bad value name '${nm.slice(0, 24)}'`);
        const v = valGet(nm, ctx);
        if (v) { f.s = cut(valText(v), 127); const d = valNum(v); if (!isNaN(d)) { f.isnum = true; f.num = d; } f.unit = v.unit || ""; }
        for (let fm of parts.slice(1)) { fm = fm.replace(/^ +/, ""); if (!fm.includes(":")) fm = trimC(fm); applyFmt(f, fm, ctx); }
      }
      out += f.s;
    }
    return cut(out, 159);
  }

  /* ------------------------------------------------------------------ drawing */
  function newCtx(ctx0, scr) {
    const c = Object.assign({ values: {}, fahrenheit: false, h12: false, icons: {}, utc: false }, ctx0);
    if (c.now === undefined) c.now = c.nowMs !== undefined ? c.nowMs / 1000 : Date.now() / 1000;
    if (c.t === undefined) c.t = c.now;          // the animation clock: pixeld uses the wall clock (epoch seconds)
    c.stale = scr ? scr.stale : 6 * 3600;
    return c;
  }
  function makeFb() { return { px: new Uint8ClampedArray(W * H * 3), clip: [0, 0, W, H] }; }
  const put = (fb, x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) { const o = (y * W + x) * 3; fb.px[o] = c[0]; fb.px[o + 1] = c[1]; fb.px[o + 2] = c[2]; } };
  const cpx = (fb, x, y, c) => { const k = fb.clip; if (x >= k[0] && x < k[2] && y >= k[1] && y < k[3]) put(fb, x, y, c); };
  const phase = (t, hz, n) => Math.trunc((t * hz) % n);
  function strW(s, font, spacing) { const n = utf8cps(s).length; return n ? n * FADV[font] - (FADV[font] - FGW[font]) + spacing * (n - 1) : 0; }
  function drawCp(fb, cp, x, y, font, c) {
    const sc = font === 0 ? 1 : font;
    if (cp === 0xB0) { for (let dy = 0; dy < 3 * sc; dy++) for (let dx = 0; dx < 3 * sc; dx++) if (!(Math.trunc(dx / sc) === 1 && Math.trunc(dy / sc) === 1)) cpx(fb, x + dx, y + dy, c); return; }
    if (font === 0) {
      const g = T3[String.fromCharCode(cp < 128 ? cp : 0x3F).toUpperCase()];
      if (g) for (let r = 0; r < 5; r++) for (let b = 0; b < 3; b++) if (g[r] & (4 >> b)) cpx(fb, x + b, y + r, c);
      return;
    }
    let u = cp; if (u < 0x20 || u > 0x7E) u = 0x3F;
    const g = F5[u - 0x20];
    for (let col = 0; col < 5; col++) for (let row = 0; row < 7; row++) if (g[col] & (1 << row))
      for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) cpx(fb, x + col * sc + dx, y + row * sc + dy, c);
  }
  function drawStr(fb, s, x, y, font, spacing, c) {
    for (const cp of utf8cps(s)) { if (x > fb.clip[0] - 20 && x < fb.clip[2]) drawCp(fb, cp, x, y, font, c); x += FADV[font] + spacing; }
  }
  const tinySupported = cp => cp === 0xB0 || !!T3[String.fromCharCode(cp < 128 ? cp : 1).toUpperCase()];
  function drawMoon(fb, x, y) {
    const m = [255, 230, 140];
    for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) {
      const d1 = f32(f32((i - 5.5) * (i - 5.5)) + f32((j - 5.5) * (j - 5.5))), d2 = f32(f32((i - 8.5) * (i - 8.5)) + f32((j - 3.5) * (j - 3.5)));
      if (d1 < 30 && d2 > 22) put(fb, x + i, y + j, m);
    }
  }
  function coinIcon(fb, sym, x, y) {   // 9x9 badges: BTC, ETH, otherwise a gold coin with the first letter
    if (sym.toUpperCase() === "ETH") {
      const E = ["...A...", "..AAB..", ".AAABB.", "AAAABBB", ".AAABB.", "A.AAB.B", ".AAABB.", "..AAB..", "...A..."], a = [190, 200, 255], b = [110, 125, 230];
      for (let j = 0; j < 9; j++) for (let i = 0; i < 7; i++) if (E[j][i] !== ".") cpx(fb, x + 1 + i, y + j, E[j][i] === "A" ? a : b);
      return;
    }
    const btc = sym.toUpperCase() === "BTC", o = [247, 147, 26], g = [230, 190, 50], w = [255, 255, 255], d = [90, 60, 0];
    for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) { const dx = i - 4, dy = j - 4; if (dx * dx + dy * dy <= 20.5) cpx(fb, x + i, y + j, btc ? o : g); }
    drawCp(fb, btc ? 0x42 : (sym[0] ? sym[0].toUpperCase().charCodeAt(0) : 0x3F), x + 2, y + 1, 1, btc ? w : d);
    if (btc) { cpx(fb, x + 3, y, w); cpx(fb, x + 5, y, w); cpx(fb, x + 3, y + 8, w); cpx(fb, x + 5, y + 8, w); }
  }
  function builtinIcon(fb, n, x, y, c) {
    if (n === "@moon") { drawMoon(fb, x, y); return true; }
    if (n === "@degree") { drawCp(fb, 0xB0, x, y, 1, c); return true; }
    if (n === "@up" || n === "@down") {
      const up = n[1] === "u";
      for (let r = 0; r < 3; r++) { const yy = up ? y + r : y + 2 - r; for (let i = 2 - r; i <= 2 + r; i++) cpx(fb, x + i, yy, c); }
      return true;
    }
    if (n.startsWith("@coin:")) { coinIcon(fb, n.slice(6), x, y); return true; }
    return false;
  }
  const BUILTIN_SIZE = n => n === "@moon" ? [12, 12] : n.startsWith("@coin:") ? [9, 9] : n === "@degree" ? [3, 3] : [5, 3];
  function iconDraw(fb, ic, x, y, fi, ctx) {
    if (fi < 0) {
      fi = 0;
      if (ic.frames.length > 1 && ic.total) {
        let ms = Math.trunc((ctx.t * 1000) % ic.total);
        for (fi = 0; fi < ic.frames.length; fi++) { if (ms < ic.frames[fi].delay) break; ms -= ic.frames[fi].delay; }
        if (fi >= ic.frames.length) fi = 0;
      }
    }
    if (fi >= ic.frames.length) fi = ic.frames.length - 1;
    const s = ic.frames[fi].rgba;
    for (let j = 0; j < ic.h; j++) for (let i = 0; i < ic.w; i++) { const p = (j * ic.w + i) * 4; if (s[p + 3] >= 128) cpx(fb, x + i, y + j, [s[p], s[p + 1], s[p + 2]]); }
  }
  function getIcon(ctx, name) {
    const ic = ctx.icons && (ctx.icons[name] || ctx.icons[name + ".pxi"]);
    if (!ic || !ic.frames || !ic.frames.length) return null;
    if (ic.total === undefined) ic.total = ic.frames.reduce((a, f) => a + f.delay, 0);
    return ic;
  }
  function elNum(name, def, ctx) {
    if (!name) return def;
    const d = strtodFull(name); if (!isNaN(d)) return d;
    const v = valNum(valGet(name, ctx)); return isNaN(v) ? def : v;
  }
  function drawLine(fb, x0, y0, x1, y1, c) {
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let g = 0; g < 400; g++) { cpx(fb, x0, y0, c); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
  }
  const WHITE = [255, 255, 255];
  function textLayout(e, ctx) {   // -> {s, font, tw, th, bw, bh, x, y}
    const s = tmplEval(e.text || "", ctx);
    let font = e.font, tw = strW(s, font, e.spacing);
    if (e.ovf === 2 && e.w > 0) while (font > 0 && tw > e.w) { font--; tw = strW(s, font, e.spacing); }
    const bw = e.w > 0 ? e.w : tw, bh = e.h > 0 ? e.h : FH[font];
    const x = e.x + (e.align === 1 ? Math.trunc((bw - tw) / 2) : e.align === 2 ? bw - tw : 0);
    const y = e.y + (e.valign === 1 ? Math.trunc((bh - FH[font]) / 2) : e.valign === 2 ? bh - FH[font] : 0);
    return { s, font, tw, th: FH[font], bw, bh, x, y };
  }
  function iconName(e, ctx) {
    if (e.value) {
      const vs = cut(valText(valGet(e.value, ctx)), 63);
      if (e.map) {
        let def = null;
        for (const it of cut(e.map, 299).split(",")) {
          if (!it) continue;
          const k = it.indexOf(":");
          if (k < 0) { CERR(ctx, "map item without ':'"); continue; }
          const key = it.slice(0, k);
          if (key === "*") def = it.slice(k + 1);
          else if (strcasecmp(key, vs) === 0) return cut(it.slice(k + 1), 63);
        }
        return def !== null ? cut(def, 63) : "";
      }
      return vs;
    }
    return e.icon ? (e.icon.includes("{") ? cut(tmplEval(e.icon, ctx), 63) : cut(e.icon, 63)) : "";   // "@coin:{ticker.symbol}"
  }
  function elDraw(fb, e, ctx) {
    const c = colorEval(e.color, WHITE, ctx), t = ctx.t;
    switch (e.type) {
      case "text": {
        const L = textLayout(e, ctx);
        if (ctx.check && e.font === 0) for (const cp of utf8cps(L.s)) if (!tinySupported(cp) && cp !== 0x20) { CERR(ctx, `tiny font can't draw '${cp < 128 ? String.fromCharCode(cp) : "?"}'`); break; }
        if (e.w > 0 || e.h > 0) fb.clip = [e.x, e.y, e.x + L.bw, e.y + L.bh];
        if (e.ovf === 1 && e.w > 0 && L.tw > e.w) {
          const period = L.tw + 12, off = Math.trunc((t * (e.speed > 0 ? e.speed : 15)) % period);
          drawStr(fb, L.s, e.x - off, L.y, L.font, e.spacing, c); drawStr(fb, L.s, e.x - off + period, L.y, L.font, e.spacing, c);
        } else drawStr(fb, L.s, L.x, L.y, L.font, e.spacing, c);
        fb.clip = [0, 0, W, H];
        break;
      }
      case "icon": {
        const name = iconName(e, ctx);
        if (!name) break;
        if (name[0] === "@") { if (!builtinIcon(fb, name, e.x, e.y, c)) CERR(ctx, `unknown built-in '${name.slice(0, 20)}'`); break; }
        const ic = getIcon(ctx, name);
        let fi = -1;
        if (e.frame) {
          if (ic && ic.frames.length > 1) {
            const v = elNum(e.frame, e.vmin, ctx);
            let f = e.vmax > e.vmin ? (v - e.vmin) / (e.vmax - e.vmin) : 0;
            if (f < 0) f = 0; if (f > 1) f = 1;
            fi = llround(f * (ic.frames.length - 1));
          } else fi = 0;
        }
        if (ic) iconDraw(fb, ic, e.x, e.y, fi, ctx);
        else if (ctx.check && !e.value && ctx.iconNames && !ctx.iconNames.has(name)) CERR(ctx, `icon '${name.slice(0, 24)}' not found`);
        break;
      }
      case "bar": {
        const v = elNum(e.value, e.vmin, ctx);
        let f = e.vmax > e.vmin ? (v - e.vmin) / (e.vmax - e.vmin) : 0;
        if (f < 0) f = 0; if (f > 1) f = 1;
        let a = c, b = c, grad = false;
        if (e.fill) {
          const d = e.fill.indexOf("..");
          a = hexcol(e.fill); if (!a) { CERR(ctx, `bad fill '${e.fill.slice(0, 20)}'`); a = [0, 0, 0]; }
          if (d >= 0) { const bb = hexcol(e.fill.slice(d + 2)); if (bb) { b = bb; grad = true; } else { CERR(ctx, `bad fill '${e.fill.slice(0, 20)}'`); b = [0, 0, 0]; } } else b = a;
        }
        const bg = e.bg ? hexcol(e.bg) : null;
        if (e.bg && !bg) CERR(ctx, `bad bg '${e.bg.slice(0, 20)}'`);
        const horiz = e.dir === 0 || e.dir === 1, len = horiz ? e.w : e.h, fillen = llround(f * len);
        for (let i = 0; i < len; i++) {
          const pos = (e.dir === 1 || e.dir === 2) ? len - 1 - i : i;
          let col;
          if (i < fillen) { const g = len > 1 ? f32(i / (len - 1)) : 0; col = [0, 1, 2].map(k => grad ? Math.trunc(f32(a[k] + f32((b[k] - a[k]) * g))) & 255 : a[k]); }
          else if (bg) col = bg; else continue;
          if (e.pulse && i === fillen && fillen > 0 && fillen < len && phase(t, 2, 2)) col = WHITE;
          if (horiz) for (let y = 0; y < e.h; y++) cpx(fb, e.x + pos, e.y + y, col);
          else for (let x = 0; x < e.w; x++) cpx(fb, e.x + x, e.y + pos, col);
        }
        break;
      }
      case "spark": {
        const v = e.series ? valGet(e.series, ctx) : null;
        if (!v || v.type !== "ser" || v.ser.length < 2 || e.w < 2 || e.h < 1) break;
        const n = v.ser.length;
        let lo = v.ser[0], hi = v.ser[0];
        for (let i = 1; i < n; i++) { if (v.ser[i] < lo) lo = v.ser[i]; if (v.ser[i] > hi) hi = v.ser[i]; }
        let rng = f32(hi - lo); if (rng < 1e-9) rng = 1;
        const dim = c.map(x => Math.trunc(x / 5));
        let prev = -1, y = 0;
        for (let xi = 0; xi < e.w; xi++) {
          const fx = f32(f32(xi * (n - 1)) / (e.w - 1));
          let k = Math.trunc(fx); if (k >= n - 1) k = n - 2;
          const val = f32(v.ser[k] + f32(f32(v.ser[k + 1] - v.ser[k]) * f32(fx - k)));
          y = e.y + e.h - 1 - llround(f32(f32(f32(val - lo) / rng) * (e.h - 1)));
          if (e.area) for (let yy = y + 1; yy < e.y + e.h; yy++) cpx(fb, e.x + xi, yy, dim);
          if (prev >= 0) for (let yy = Math.min(prev, y); yy <= Math.max(prev, y); yy++) cpx(fb, e.x + xi, yy, c);
          else cpx(fb, e.x + xi, y, c);
          prev = y;
        }
        if (e.dot && phase(t, 1, 2)) cpx(fb, e.x + e.w - 1, y, WHITE);
        break;
      }
      case "rect":
        for (let j = 0; j < e.h; j++) for (let i = 0; i < e.w; i++) if (e.fillrect || i === 0 || j === 0 || i === e.w - 1 || j === e.h - 1) cpx(fb, e.x + i, e.y + j, c);
        break;
      case "line": drawLine(fb, e.x, e.y, e.x2, e.y2, c); break;
      case "pixel": cpx(fb, e.x, e.y, c); break;
    }
  }

  /* ------------------------------------------------------------------ parsing */
  // C's next_tok: quotes may appear anywhere in a token (key="a b"). -> {v, q (2 = starts with a quote), end}
  function nextTok(s, i) {
    while (s[i] === " " || s[i] === "\t") i++;
    if (i >= s.length) return null;
    let out = "", q = s[i] === '"' ? 2 : 0;
    while (i < s.length && s[i] !== " " && s[i] !== "\t") {
      if (s[i] === '"') {
        if (!q) q = 1;
        i++;
        while (i < s.length && s[i] !== '"') { if (s[i] === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) i++; out += s[i]; i++; }
        if (s[i] === '"') i++;
      } else out += s[i++];
    }
    return { v: out, q, end: i };
  }
  function stripComment(l) {   // '#' at the start or after whitespace, followed by whitespace/end; never inside quotes
    let q = false;
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '"' && (i === 0 || l[i - 1] !== "\\")) q = !q;
      if (!q && l[i] === "#" && (i === 0 || l[i - 1] === " " || l[i - 1] === "\t") && (i + 1 >= l.length || l[i + 1] === " " || l[i + 1] === "\t")) return l.slice(0, i);
    }
    return l;
  }
  function tokenize(line) {   // for the editor's import: [{k?, v, q}]
    const s = stripComment(line), out = [];
    let i = 0, t;
    while ((t = nextTok(s, i))) {
      i = t.end;
      const eq = t.q === 2 ? -1 : t.v.indexOf("=");
      out.push(eq > 0 ? { k: t.v.slice(0, eq), v: t.v.slice(eq + 1), q: !!t.q } : { v: t.v, q: !!t.q });
    }
    return out;
  }
  function parseDur(s) {
    const r = strtodPrefix(s); if (!r) return -1;
    switch (r.rest[0]) { case undefined: case "s": return r.v; case "m": return r.v * 60; case "h": return r.v * 3600; case "d": return r.v * 86400; default: return -1; }
  }
  const KW = ["text", "icon", "bar", "spark", "rect", "line", "pixel"], NPOS = [2, 2, 2, 2, 2, 4, 2], NMAX = [2, 2, 4, 4, 4, 4, 2];
  function scrError(scr, line, msg) { if (scr.errors.length < NERR) scr.errors.push({ line, msg: cut(msg, 55) }); }
  function parseElement(scr, ln, kw, rest) {
    const type = KW.indexOf(kw);
    if (type < 0) return scrError(scr, ln, `unknown keyword '${kw.slice(0, 20)}'`);
    if (scr.elements.length >= NEL) return scrError(scr, ln, `too many elements (max ${NEL})`);
    const e = { type: kw, line: ln, x: 0, y: 0, w: 0, h: 0, x2: 0, y2: 0, font: 1, align: 0, valign: 0, ovf: 0, spacing: 0, fillrect: false, area: false, dot: false, pulse: false,
      dir: 0, blink: 0, speed: 0, vmin: 0, vmax: 100, text: null, cond: null, color: null, icon: null, value: null, map: null, frame: null, fill: null, bg: null, series: null };
    const pos = []; let i = 0;
    while (pos.length < NMAX[type]) {
      const t = nextTok(rest, i);
      if (!t) break;
      if (!/^[ \t\n]*[+-]?\d+$/.test(t.v)) {
        if (pos.length < NPOS[type]) return scrError(scr, ln, `${kw}: expected a number, got '${t.v.slice(0, 16)}'`);
        break;
      }
      pos.push(parseInt(t.v, 10)); i = t.end;
    }
    if (pos.length < NPOS[type]) return scrError(scr, ln, `${kw} needs ${NPOS[type]} numbers`);
    e.x = pos[0]; e.y = pos[1];
    if (kw === "line") { e.x2 = pos[2]; e.y2 = pos[3]; } else if (pos.length === 4) { e.w = pos[2]; e.h = pos[3]; }
    let t;
    while ((t = nextTok(rest, i))) {
      i = t.end;
      const tok = cut(t.v, 399), eq = t.q === 2 ? -1 : tok.indexOf("=");
      if (eq < 0) {
        if (kw === "text" && e.text === null) e.text = tok;
        else if (kw === "icon" && e.icon === null) e.icon = tok;
        else scrError(scr, ln, `unexpected '${tok.slice(0, 20)}'`);
        continue;
      }
      const k = tok.slice(0, eq), v = tok.slice(eq + 1);
      switch (k) {
        case "font": { const f = FONT_IDS[v]; if (f === undefined) scrError(scr, ln, `unknown font '${v.slice(0, 10)}'`); else e.font = f; break; }
        case "w": e.w = atoi(v); break;
        case "h": e.h = atoi(v); break;
        case "align": e.align = v === "center" ? 1 : v === "right" ? 2 : 0; break;
        case "valign": e.valign = v === "middle" ? 1 : v === "bottom" ? 2 : 0; break;
        case "overflow": e.ovf = v === "scroll" ? 1 : v === "shrink" ? 2 : 0; if (!["scroll", "shrink", "clip"].includes(v)) scrError(scr, ln, `unknown overflow '${v.slice(0, 10)}'`); break;
        case "spacing": e.spacing = atoi(v); break;
        case "speed": e.speed = f32(atof(v)); break;
        case "color": e.color = v; break;
        case "if": e.cond = v; break;
        case "value": e.value = v; break;
        case "series": e.series = v; break;
        case "map": e.map = v; break;
        case "frame": e.frame = v; break;
        case "range": { const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(v); if (!m) scrError(scr, ln, "range needs min,max"); else { e.vmin = f32(+m[1]); e.vmax = f32(+m[2]); } break; }
        case "min": e.vmin = f32(atof(v)); break;
        case "max": e.vmax = f32(atof(v)); break;
        case "fill": if (kw === "rect") e.fillrect = atoi(v) !== 0; else e.fill = v; break;
        case "bg": e.bg = v; break;
        case "dir": e.dir = v === "left" ? 1 : v === "up" ? 2 : v === "down" ? 3 : 0; break;
        case "pulse": e.pulse = atoi(v) !== 0; break;
        case "area": e.area = atoi(v) !== 0; break;
        case "dot": e.dot = atoi(v) !== 0; break;
        case "blink": e.blink = atoi(v); if (e.blink < 50 || e.blink > 10000) { scrError(scr, ln, "blink must be 50..10000 ms"); e.blink = 0; } break;
        default: scrError(scr, ln, `${kw}: unknown option '${k.slice(0, 16)}'`);
      }
    }
    if (kw === "text" && e.text === null) e.text = "";
    if (kw === "icon" && !e.icon && !e.value) scrError(scr, ln, "icon needs a name or value=");
    if (kw === "bar" && !e.value) scrError(scr, ln, "bar needs value=");
    if (kw === "spark" && !e.series) scrError(scr, ln, "spark needs series=");
    scr.elements.push(e);
  }
  // .scr text -> {name, needs, show, linger, lingerSecs, stale, time, order, bg, elements, errors}. Then the load-time
  // check pixeld does: every element is evaluated once with ctx (values, icons, iconNames) to report template, colour
  // and icon problems against its line.
  function parse(text, fileName, ctx0) {
    const scr = { file: (fileName || "") + ".scr", name: cut(fileName || "", 47), needs: null, show: null, linger: null, lingerSecs: 0, stale: 6 * 3600, time: 0, order: 100, bg: null, elements: [], errors: [] };
    const lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    let magic = false;
    for (let li = 0; li < lines.length; li++) {
      const ln = li + 1;
      let l = lines[li];
      if (bytes(l).length > 518) { scrError(scr, ln, "line too long"); continue; }
      l = l.replace(/\r/g, "");
      if (!magic) { if (!l.startsWith("PXS1")) { scrError(scr, ln, "not a PXS1 file"); break; } magic = true; continue; }
      l = trimC(stripComment(l));
      if (!l) continue;
      const ws = l.search(/[ \t]/), kl = ws < 0 ? l.length : ws, kw = l.slice(0, Math.min(kl, 15));
      const rest = l.slice(kl).replace(/^[ \t]+/, "");
      switch (kw) {
        case "name": { const t = unquote(cut(rest, 63)); if (t) scr.name = cut(t, 47); break; }
        case "needs": scr.needs = rest; break;
        case "show": scr.show = rest; break;
        case "linger": { const sp = rest.lastIndexOf(" "), d = sp >= 0 ? parseDur(rest.slice(sp + 1)) : -1; if (d < 0) scrError(scr, ln, "linger needs a condition and a duration"); else { scr.linger = rest.slice(0, sp); scr.lingerSecs = d; } break; }
        case "stale": { const d = parseDur(rest); if (d <= 0) scrError(scr, ln, `bad duration '${rest.slice(0, 10)}'`); else scr.stale = d; break; }
        case "time": { const v = atoi(rest); if (v < 2 || v > 600) scrError(scr, ln, "time must be 2..600 s"); else scr.time = v; break; }
        case "order": scr.order = atoi(rest); break;
        case "bg": { const c = hexcol(rest); if (c) scr.bg = c; else scrError(scr, ln, `bad colour '${rest.slice(0, 10)}'`); break; }
        default: parseElement(scr, ln, kw, rest);
      }
    }
    if (!magic && !scr.errors.length) scrError(scr, 1, "empty file");
    const ctx = newCtx(ctx0, scr), fb = makeFb();
    const run = (line, fn) => { ctx.check = []; fn(); for (const m of ctx.check) scrError(scr, line, m); ctx.check = null; };
    if (scr.show) run(0, () => condEval(scr.show, ctx));
    if (scr.linger) run(0, () => condEval(scr.linger, ctx));
    for (const e of scr.elements) run(e.line, () => { if (e.cond) condEval(e.cond, ctx); elDraw(fb, e, ctx); });
    return scr;
  }

  // -> Uint8ClampedArray 52*32*3 (RGB). ctx: {values, now (s) or nowMs, t (animation clock, s; default now),
  //    fahrenheit, h12, utc, icons: {name: {w, h, frames: [{delay, rgba}]}}}
  function render(scr, ctx0) {
    const ctx = newCtx(ctx0, scr), fb = makeFb();
    if (scr.bg) for (let i = 0; i < W * H; i++) fb.px.set(scr.bg, i * 3);
    for (const e of scr.elements) {
      if (e.hidden || (e.cond && !condEval(e.cond, ctx))) continue;
      if (e.blink && phase(ctx.t, 1000 / e.blink, 2)) continue;   // blink=<ms>: shown for ms, hidden for ms
      elDraw(fb, e, ctx);
    }
    return fb.px;
  }
  // what pixeld's rotation would do: needs (present and fresh), show, linger
  function visibility(scr, ctx0) {
    const ctx = newCtx(ctx0, scr), missing = [];
    if (scr.needs) for (const n of scr.needs.split(/[ ,]+/).filter(Boolean)) { const v = valGet(n, ctx); if (!v || (!BUILTINS.includes(n) && ctx.now - v.upd > scr.stale)) missing.push(n); }
    return { missing, show: !missing.length && condEval(scr.show, ctx), lingerCond: scr.linger ? condEval(scr.linger, ctx) : false };
  }
  function formatText(tpl, ctx0) { const ctx = newCtx(ctx0); ctx.check = []; const s = tmplEval(tpl, ctx); return { text: s, errors: ctx.check }; }

  // for the editor: an element's box, and warnings worth showing
  function bounds(e, ctx0) {
    const ctx = newCtx(ctx0);
    if (e.type === "text") { const L = textLayout(e, ctx); return { x: e.x, y: e.y, w: L.bw, h: L.bh, L }; }
    if (e.type === "icon") {
      const n = iconName(e, ctx) || e.icon || (e.map ? ((e.map.split(",")[0] || "").split(":")[1] || "") : "");
      if (n && n[0] === "@") { const s = BUILTIN_SIZE(n); return { x: e.x, y: e.y, w: s[0], h: s[1] }; }
      const ic = n && getIcon(ctx, n);
      return { x: e.x, y: e.y, w: ic ? ic.w : 8, h: ic ? ic.h : 8 };
    }
    if (e.type === "line") return { x: Math.min(e.x, e.x2), y: Math.min(e.y, e.y2), w: Math.abs(e.x2 - e.x) + 1, h: Math.abs(e.y2 - e.y) + 1 };
    if (e.type === "pixel") return { x: e.x, y: e.y, w: 1, h: 1 };
    return { x: e.x, y: e.y, w: e.w, h: e.h };
  }
  function warnings(e, ctx0) {
    const ctx = newCtx(ctx0), out = [], b = bounds(e, ctx);
    if (b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= W || b.y >= H) out.push("off the panel");
    else if (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) out.push("partly off the panel");
    if (e.type === "text") {
      const L = b.L;
      if (e.w > 0 && L.tw > e.w && e.ovf !== 1) out.push(`text is ${L.tw - e.w} px wider than its box`);
      if (e.h > 0 && L.th > e.h) out.push("text is taller than its box");
      if (L.font === 0) { const bad = [...new Set(utf8cps(L.s).filter(cp => !tinySupported(cp) && cp !== 0x20).map(cp => String.fromCodePoint(cp)))]; if (bad.length) out.push(`tiny font can't draw ${bad.map(c => `'${c}'`).join(" ")}`); }
    }
    return out;
  }
  const textWidth = (s, fontName, spacing = 0) => strW(s, FONT_IDS[fontName], spacing);

  const api = { W, H, FONTS, FONT_IDS, FONT_NAMES, NAME_RE, BUILTINS, parse, render, visibility, formatText, bounds, warnings, textWidth, tokenize,
    setValue, applyMessage, valText };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ScreenRender = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
