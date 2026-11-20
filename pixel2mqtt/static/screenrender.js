// .scr info screens: parser, templates, conditions and renderer (52x32 RGB). A port of pixeld's renderer, so the
// editor shows exactly what the panel will. Spec: pixeld-h6631/docs/SCREENS.md. Works in the browser
// (window.ScreenRender) and in Node (require) for the parity tests against pixeld's golden frames.
(function (root) {
  "use strict";
  const W = 52, H = 32;
  const LIMITS = { elements: 32, conds: 8, values: 128, points: 64, lineBytes: 512, fileBytes: 16384 };

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
  };
  const DEG = [[1,0],[0,1],[2,1],[1,2]];   // 3x3 ring (degree())
  const FONTS = {
    tiny: { gw: 3, gh: 5, gap: 1, scale: 1 }, small: { gw: 5, gh: 7, gap: 1, scale: 1 },
    big: { gw: 10, gh: 14, gap: 2, scale: 2 }, huge: { gw: 15, gh: 21, gap: 3, scale: 3 },
  };
  const SMALLER = { huge: "big", big: "small", small: "tiny", tiny: null };
  const tinyOk = ch => ch === "°" || T3[ch.toUpperCase()] !== undefined;
  function glyphW(font, ch) { const f = FONTS[font]; return ch === "°" ? 3 * f.scale : f.gw; }
  function textWidth(s, font, spacing = 0) {
    const f = FONTS[font], cs = [...s];
    if (!cs.length) return 0;
    let w = 0;
    for (const ch of cs) w += glyphW(font, ch);
    return w + (cs.length - 1) * (f.gap + spacing);
  }

  /* ------------------------------------------------------------------ tokens */
  function tokenize(line) {   // -> [{k, v, q}] (k = key for key=value, q = quoted)
    const out = [];
    let i = 0;
    const n = line.length;
    const readQuoted = () => {   // at a quote
      let s = ""; i++;
      while (i < n && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < n) { s += line[i + 1]; i += 2; } else s += line[i++];
      }
      if (i >= n) throw new Error("unterminated quote");
      i++; return s;
    };
    while (i < n) {
      const c = line[i];
      if (c === " " || c === "\t") { i++; continue; }
      if (c === "#") break;
      if (c === '"') { out.push({ v: readQuoted(), q: true }); continue; }
      let s = "";
      while (i < n && line[i] !== " " && line[i] !== "\t") {
        if (line[i] === '"') { s += "\u0000" + readQuoted(); continue; }   // key="quoted value"
        s += line[i++];
      }
      const eq = s.indexOf("=");
      if (eq > 0 && /^[a-z]+$/.test(s.slice(0, eq)) && s[eq + 1] !== "=") {
        let v = s.slice(eq + 1); const qd = v.startsWith("\u0000");
        out.push({ k: s.slice(0, eq), v: v.replace(/\u0000/g, ""), q: qd });
      } else out.push({ v: s.replace(/\u0000/g, "") });
    }
    return out;
  }

  /* ------------------------------------------------------------------ values */
  const NAME_RE = /^[a-z0-9_.-]{1,31}$/;
  // values: { name: { v, unit, at (ms) } }; v = number | string | number[]
  function setValue(values, name, raw, now) {
    if (!NAME_RE.test(name)) return false;
    if (raw === null) { delete values[name]; return true; }
    let v = raw, unit = null;
    if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === "number" && typeof raw[1] === "string") { v = raw[0]; unit = raw[1]; }
    else if (Array.isArray(raw)) v = raw.filter(x => typeof x === "number").slice(-LIMITS.points);
    else if (typeof raw === "string") v = utf8Trunc(raw, 63);
    else if (typeof raw === "boolean") v = raw ? 1 : 0;
    else if (typeof raw !== "number") return false;
    if (!(name in values) && Object.keys(values).length >= LIMITS.values) return false;
    values[name] = { v, unit, at: now };
    return true;
  }
  function utf8Trunc(s, max) {
    let out = "", n = 0;
    for (const ch of s) { const b = ch.codePointAt(0) < 0x80 ? 1 : ch.codePointAt(0) < 0x800 ? 2 : ch.codePointAt(0) < 0x10000 ? 3 : 4; if (n + b > max) break; out += ch; n += b; }
    return out;
  }
  const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const pad2 = n => String(n).padStart(2, "0");
  function builtin(name, ctx) {
    const d = ctx.now;
    switch (name) {
      case "time": return { v: pad2(d.getHours()) + ":" + pad2(d.getMinutes()) };
      case "date": return { v: `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}` };
      case "weekday": return { v: DAYS[d.getDay()] };
      case "month": return { v: MONTHS[d.getMonth()] };
      case "day": return { v: d.getDate() };
      case "hour": return { v: d.getHours() };
      case "minute": return { v: d.getMinutes() };
      case "second": return { v: d.getSeconds() };
    }
    return null;
  }
  function lookup(name, ctx) {   // -> {v, unit, at} or null
    const r = ctx.values[name];
    if (r) return r;
    if (name.endsWith(".trend")) {
      const s = ctx.values[name.slice(0, -6)];
      if (s && Array.isArray(s.v) && s.v.length) return { v: s.v[s.v.length - 1] - s.v[0], at: s.at };
    }
    return builtin(name, ctx);
  }
  const isNum = s => typeof s === "number" ? isFinite(s) : typeof s === "string" && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(s);
  const num = s => typeof s === "number" ? s : parseFloat(s);

  /* ------------------------------------------------------------------ conditions */
  // condition text -> [[atom, ...] (AND), ...] (OR); atom = {op, name, lit}
  function parseCond(text) {
    text = text.trim();
    if (!text) throw new Error("empty condition");
    let count = 0;
    const ors = text.split("||").map(part => part.split("&&").map(a => {
      a = a.trim(); count++;
      let m = a.match(/^(has|fresh)\(\s*([a-z0-9_.-]+)\s*\)$/);
      if (m) return { op: m[1], name: m[2] };
      m = a.match(/^([a-z0-9_.-]+)\s+in\s+(.+)$/);
      if (m) return { op: "in", name: m[1], lit: m[2].split(",").map(s => s.trim().toLowerCase()) };
      m = a.match(/^([a-z0-9_.-]+)\s*(==|!=|<=|>=|<|>)\s*(.*)$/);
      if (m && m[3] !== "") return { op: m[2], name: m[1], lit: m[3].trim().replace(/^"(.*)"$/, "$1") };
      throw new Error(`bad condition '${a}'`);
    }));
    if (count > LIMITS.conds) throw new Error(`more than ${LIMITS.conds} conditions`);
    return ors;
  }
  function evalAtom(a, ctx) {
    const r = lookup(a.name, ctx);
    if (a.op === "has") return !!r && r.v !== "";
    if (a.op === "fresh") return !!r && (r.at === undefined || ctx.nowMs - r.at <= (ctx.stale || 6 * 3600) * 1000);
    if (!r) return a.op === "!=";
    const v = Array.isArray(r.v) ? (r.v.length ? r.v[r.v.length - 1] : "") : r.v;
    if (a.op === "in") return a.lit.includes(String(v).toLowerCase());
    let c;
    if (isNum(v) && isNum(a.lit)) { const x = num(v), y = num(a.lit); c = x < y ? -1 : x > y ? 1 : 0; }
    else { const x = String(v).toLowerCase(), y = a.lit.toLowerCase(); c = x < y ? -1 : x > y ? 1 : 0; }
    return { "==": c === 0, "!=": c !== 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[a.op];
  }
  const evalCond = (cond, ctx) => !cond || cond.some(and => and.every(a => evalAtom(a, ctx)));

  /* ------------------------------------------------------------------ colours */
  function parseHex(s) {
    const m = /^#([0-9a-f]{6})$/i.exec(s.trim());
    if (!m) throw new Error(`bad colour '${s}'`);
    const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255];
  }
  function parseColor(text) {   // "#c" or "cond:#c,cond:#c,#default" -> {rules: [[cond, rgb]], def}
    const parts = [], segs = text.split(",");
    let acc = "";
    for (const s of segs) { acc = acc ? acc + "," + s : s; if (/#[0-9a-f]{6}\s*$/i.test(acc)) { parts.push(acc); acc = ""; } }
    if (acc) throw new Error(`bad colour '${text}'`);
    const rules = [];
    let def = [255, 255, 255];
    for (const p of parts) {
      const i = p.lastIndexOf(":#");
      if (i < 0) def = parseHex(p); else rules.push([parseCond(p.slice(0, i)), parseHex(p.slice(i + 1))]);
    }
    return { rules, def };
  }
  function colorOf(c, ctx) { if (!c) return [255, 255, 255]; for (const [cond, rgb] of c.rules) if (evalCond(cond, ctx)) return rgb; return c.def; }

  /* ------------------------------------------------------------------ templates */
  function parseTemplate(s) {   // -> [string | {name, fmts: [[name, arg]]}]
    const out = [];
    let lit = "", i = 0;
    while (i < s.length) {
      if (s.startsWith("{{", i)) { lit += "{"; i += 2; continue; }
      if (s.startsWith("}}", i)) { lit += "}"; i += 2; continue; }
      if (s[i] === "{") {
        const j = s.indexOf("}", i);
        if (j < 0) throw new Error("unclosed {");
        if (lit) { out.push(lit); lit = ""; }
        const [name, ...fs] = s.slice(i + 1, j).split("|");
        if (!NAME_RE.test(name.trim())) throw new Error(`bad value name '${name}'`);
        out.push({ name: name.trim(), fmts: fs.map(f => { const k = f.indexOf(":"); return k < 0 ? [f.trim(), ""] : [f.slice(0, k).trim(), f.slice(k + 1)]; }) });
        for (const [f] of out[out.length - 1].fmts) if (!FORMATTERS.has(f)) throw new Error(`unknown formatter '${f}'`);
        i = j + 1; continue;
      }
      lit += s[i++];
    }
    if (lit) out.push(lit);
    return out;
  }
  const FORMATTERS = new Set(["int", "dec", "thousands", "pct", "sign", "dur", "temp", "time", "ago", "upper", "lower", "trunc", "or", "map"]);
  const roundAway = (x, d = 0) => { const p = 10 ** d; return Math.sign(x) * Math.round(Math.abs(x) * p) / p; };
  function show(v) {   // a value as text
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return String(roundAway(v, 2));
    if (Array.isArray(v)) return v.length ? show(v[v.length - 1]) : "";
    return String(v);
  }
  function toEpochMs(v) {
    if (typeof v === "number") return v > 1e12 ? v : v * 1000;
    if (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v)) { const t = Date.parse(v); return isNaN(t) ? null : t; }
    return null;
  }
  function format(tpl, ctx) {
    let s = "";
    for (const part of tpl) {
      if (typeof part === "string") { s += part; continue; }
      const r = lookup(part.name, ctx);
      let v = r ? r.v : "", unit = r ? r.unit : null;
      for (const [f, arg] of part.fmts) {
        const n = isNum(v) ? num(v) : NaN;
        switch (f) {
          case "int": if (!isNaN(n)) v = String(roundAway(n)); break;
          case "dec": if (!isNaN(n)) v = roundAway(n, +arg || 0).toFixed(+arg || 0); break;
          case "thousands": if (!isNaN(n)) { const r2 = roundAway(n); v = (r2 < 0 ? "-" : "") + String(Math.abs(r2)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); } break;
          case "pct": if (!isNaN(n)) v = roundAway(n, 1).toFixed(1) + "%"; break;
          case "sign": if (!isNaN(n) && n > 0 && !String(v).startsWith("+")) v = "+" + show(v); else if (!isNaN(parseFloat(v)) && parseFloat(v) > 0 && !String(v).startsWith("+")) v = "+" + v; break;
          case "dur": if (!isNaN(n)) {
            const mins = Math.floor(arg === "s" ? n / 60 : arg === "h" ? n * 60 : n);
            v = mins >= 60 ? `${Math.floor(mins / 60)}H${mins % 60}M` : `${Math.max(0, mins)}M`;
          } break;
          case "temp": if (!isNaN(n)) {
            const isF = unit ? /f/i.test(unit) : !!ctx.fahrenheit;
            let x = n;
            if (isF && !ctx.fahrenheit) x = (n - 32) * 5 / 9; else if (!isF && ctx.fahrenheit) x = n * 9 / 5 + 32;
            v = String(roundAway(x));
          } break;
          case "time": {
            let hh, mm;
            const m = typeof v === "string" && v.match(/^(\d{1,2}):(\d\d)/);
            if (m && !/^\d{4}-/.test(v)) { hh = +m[1]; mm = +m[2]; }
            else { const t = toEpochMs(v); if (t !== null) { const d = new Date(t); hh = d.getHours(); mm = d.getMinutes(); } }
            if (hh !== undefined) v = ctx.h12 ? `${(hh % 12) || 12}:${pad2(mm)}` : `${pad2(hh)}:${pad2(mm)}`;
          } break;
          case "ago": { const t = toEpochMs(v); if (t !== null) {
            const s2 = Math.max(0, (ctx.nowMs - t) / 1000);
            v = s2 < 60 ? "JUST NOW" : s2 < 3600 ? `${Math.floor(s2 / 60)}M AGO` : s2 < 86400 ? `${Math.floor(s2 / 3600)}H AGO` : `${Math.floor(s2 / 86400)}D AGO`;
          } } break;
          case "upper": v = show(v).toUpperCase(); break;
          case "lower": v = show(v).toLowerCase(); break;
          case "trunc": v = [...show(v)].slice(0, +arg || 0).join(""); break;
          case "or": if (show(v) === "") v = arg; break;
          case "map": {
            const key = show(v).toLowerCase(); let hit = null, star = null;
            for (const pair of arg.split(",")) { const k = pair.indexOf("="); if (k < 0) continue; const a = pair.slice(0, k).trim().toLowerCase(), b = pair.slice(k + 1); if (a === "*") star = b; else if (a === key && hit === null) hit = b; }
            v = hit !== null ? hit : star !== null ? star : v;
          } break;
        }
        unit = f === "temp" ? null : unit;
      }
      s += show(v);
    }
    return s;
  }

  /* ------------------------------------------------------------------ durations, directives */
  function parseDur(s) {
    const m = /^(\d+)(s|m|h|d)$/.exec(s || "");
    if (!m) throw new Error(`bad duration '${s}'`);
    return +m[1] * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  }
  const int = (s, what) => { if (!/^-?\d+$/.test(s || "")) throw new Error(`${what}: expected a whole number, got '${s === undefined ? "" : s}'`); return parseInt(s, 10); };

  /* ------------------------------------------------------------------ parse */
  function parse(text, fileName) {
    const scr = { name: fileName || "", needs: [], show: null, linger: null, stale: 6 * 3600, time: null, order: 100, bg: [0, 0, 0], elements: [], errors: [] };
    const lines = text.replace(/\r/g, "").split("\n");
    const err = (line, msg) => scr.errors.push({ line, msg });
    if ((lines[0] || "").trim() !== "PXS1") { err(1, "first line must be PXS1"); return scr; }
    if (new TextEncoder().encode(text).length > LIMITS.fileBytes) err(1, "file larger than 16 KB");
    for (let li = 1; li < lines.length; li++) {
      const raw = lines[li], ln = li + 1;
      if (new TextEncoder().encode(raw).length > LIMITS.lineBytes) { err(ln, "line longer than 512 bytes"); continue; }
      let toks;
      try { toks = tokenize(raw); } catch (e) { err(ln, e.message); continue; }
      if (!toks.length) continue;
      const kw = toks[0].v, rest = toks.slice(1);
      const restText = () => raw.replace(/^\s*\S+\s*/, "").replace(/\s+#.*$/, "").trim();
      try {
        switch (kw) {
          case "name": scr.name = rest.map(t => t.v).join(" "); break;
          case "needs": for (const t of rest) { if (!NAME_RE.test(t.v)) throw new Error(`bad value name '${t.v}'`); scr.needs.push(t.v); } break;
          case "show": scr.show = parseCond(restText()); break;
          case "linger": { const rt = restText(), k = rt.lastIndexOf(" "); if (k < 0) throw new Error("linger needs a condition and a duration"); scr.linger = { cond: parseCond(rt.slice(0, k)), secs: parseDur(rt.slice(k + 1)) }; break; }
          case "stale": scr.stale = parseDur(rest[0] && rest[0].v); break;
          case "time": scr.time = int(rest[0] && rest[0].v, "time"); break;
          case "order": scr.order = int(rest[0] && rest[0].v, "order"); break;
          case "bg": scr.bg = parseHex(rest[0] ? rest[0].v : ""); break;
          case "text": case "icon": case "bar": case "spark": case "rect": case "line": case "pixel": {
            if (scr.elements.length >= LIMITS.elements) throw new Error(`more than ${LIMITS.elements} elements`);
            scr.elements.push(parseElement(kw, rest, ln));
            break;
          }
          default: throw new Error(`unknown directive '${kw}'`);
        }
      } catch (e) { err(ln, e.message); }
    }
    return scr;
  }
  const NUMARGS = { text: 2, icon: 2, bar: 4, spark: 4, rect: 4, line: 4, pixel: 2 };
  const OPTS = {
    text: ["font", "w", "h", "align", "valign", "overflow", "speed", "spacing"],
    icon: ["map", "value", "frame", "range"], bar: ["value", "min", "max", "fill", "bg", "dir", "pulse"],
    spark: ["series", "area", "dot"], rect: ["fill"], line: [], pixel: [],
  };
  function parseElement(type, toks, line) {
    const pos = toks.filter(t => !t.k && !t.q), opts = {}, el = { type, line };
    let n = NUMARGS[type];
    const boxOpts = ["bar", "spark", "rect"].includes(type) && pos.length === 2;   // "bar 0 23 w=52 h=3" (as the spec's example)
    if (boxOpts) n = 2;
    if (pos.length < n) throw new Error(`${type} needs ${n} numbers`);
    const nums = pos.slice(0, n).map(t => int(t.v, type));
    if (boxOpts) { const ow = toks.find(t => t.k === "w"), oh = toks.find(t => t.k === "h"); if (!ow || !oh) throw new Error(`${type} needs x y w h`); nums.push(int(ow.v, "w"), int(oh.v, "h")); }
    let extra = pos.slice(n);
    for (const t of toks) if (t.k) {
      if (t.k !== "if" && t.k !== "color" && !OPTS[type].includes(t.k) && !(boxOpts && (t.k === "w" || t.k === "h"))) throw new Error(`unknown option '${t.k}' for ${type}`);
      opts[t.k] = t.v;
    }
    if (opts.if) el.cond = parseCond(opts.if);
    if (opts.color) el.color = parseColor(opts.color);
    if (type === "text") {
      [el.x, el.y] = nums;
      const q = toks.filter(t => t.q && !t.k);
      if (q.length !== 1 || extra.length) throw new Error('text needs one "template"');
      el.tpl = parseTemplate(q[0].v); el.src = q[0].v;
      el.font = opts.font || "small";
      if (!FONTS[el.font]) throw new Error(`unknown font '${el.font}'`);
      if (opts.w !== undefined) el.w = int(opts.w, "w");
      if (opts.h !== undefined) el.h = int(opts.h, "h");
      el.align = opts.align || "left"; if (!["left", "center", "right"].includes(el.align)) throw new Error(`bad align '${el.align}'`);
      el.valign = opts.valign || "top"; if (!["top", "middle", "bottom"].includes(el.valign)) throw new Error(`bad valign '${el.valign}'`);
      el.overflow = opts.overflow || "clip"; if (!["clip", "scroll", "shrink"].includes(el.overflow)) throw new Error(`bad overflow '${el.overflow}'`);
      el.speed = opts.speed !== undefined ? int(opts.speed, "speed") : 15;
      el.spacing = opts.spacing !== undefined ? int(opts.spacing, "spacing") : 0;
    } else if (type === "icon") {
      [el.x, el.y] = nums;
      if (extra.length > 1) throw new Error("icon takes one name");
      el.icon = extra[0] ? extra[0].v : null;
      if (opts.map) {
        el.map = opts.map.split(",").map(p => { const k = p.indexOf(":"); if (k < 0) throw new Error(`bad map entry '${p}'`); return [p.slice(0, k).trim().toLowerCase(), p.slice(k + 1).trim()]; });
        if (!opts.value) throw new Error("map= needs value=");
      }
      if (opts.value) el.value = opts.value;
      if (opts.frame) {
        el.frame = opts.frame;
        const r = (opts.range || "0,100").split(",");
        if (r.length !== 2 || !isNum(r[0]) || !isNum(r[1])) throw new Error(`bad range '${opts.range}'`);
        el.range = [num(r[0]), num(r[1])];
      }
      if (!el.icon && !el.map) throw new Error("icon needs a name or map=");
    } else {
      if (extra.length) throw new Error(`unexpected '${extra[0].v}'`);
      if (type === "line") [el.x1, el.y1, el.x2, el.y2] = nums;
      else if (type === "pixel") [el.x, el.y] = nums;
      else [el.x, el.y, el.w, el.h] = nums;
      if (type === "bar") {
        if (!opts.value) throw new Error("bar needs value=");
        el.value = opts.value;
        el.min = opts.min !== undefined ? num(opts.min) : 0; el.max = opts.max !== undefined ? num(opts.max) : 100;
        if (isNaN(el.min) || isNaN(el.max)) throw new Error("bad min/max");
        if (opts.fill) { const [a, b] = opts.fill.split(".."); el.fill = [parseHex(a), parseHex(b || a)]; }
        if (opts.bg) el.bg = parseHex(opts.bg);
        el.dir = opts.dir || "right"; if (!["right", "left", "up", "down"].includes(el.dir)) throw new Error(`bad dir '${el.dir}'`);
        el.pulse = opts.pulse === "1";
      }
      if (type === "spark") { if (!opts.series) throw new Error("spark needs series="); el.series = opts.series; el.area = opts.area === "1"; el.dot = opts.dot === "1"; }
      if (type === "rect") el.fill = opts.fill === "1";
    }
    return el;
  }

  /* ------------------------------------------------------------------ drawing */
  function canvas(bg) { const fb = new Uint8ClampedArray(W * H * 3); for (let i = 0; i < W * H; i++) fb.set(bg, i * 3); return fb; }
  function px(fb, x, y, c, clip) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    if (clip && (x < clip[0] || y < clip[1] || x >= clip[2] || y >= clip[3])) return;
    fb.set(c, (y * W + x) * 3);
  }
  function drawText(fb, s, font, x, y, c, spacing, clip) {
    const f = FONTS[font];
    for (const ch0 of s) {
      const ch = font === "tiny" ? ch0.toUpperCase() : ch0, sc = f.scale;
      if (ch === "°") for (const [dx, dy] of DEG) { for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) px(fb, x + dx * sc + a, y + dy * sc + b, c, clip); }
      else if (font === "tiny") {
        const g = T3[ch];
        if (g) for (let r = 0; r < 5; r++) for (let b = 0; b < 3; b++) if (g[r] & (4 >> b)) px(fb, x + b, y + r, c, clip);
      } else {
        let u = ch.codePointAt(0); if (u < 0x20 || u > 0x7e) u = 0x3f;
        const g = F5[u - 0x20];
        for (let col = 0; col < 5; col++) for (let row = 0; row < 7; row++) if (g[col] & (1 << row))
          for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) px(fb, x + col * sc + a, y + row * sc + b, c, clip);
      }
      x += glyphW(font, ch) + f.gap + spacing;
    }
  }
  function lineTo(x0, y0, x1, y1, fn) {   // Bresenham
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) { fn(x0, y0); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
  }
  const blinkOn = t => Math.floor(t * 2) % 2 === 0;
  // text box after fitting: {font, tw, th, x, y, w, h, s}
  function textLayout(el, ctx) {
    const s = format(el.tpl, ctx);
    let font = el.font, tw = textWidth(s, font, el.spacing);
    if (el.overflow === "shrink" && el.w !== undefined) while (tw > el.w && SMALLER[font]) { font = SMALLER[font]; tw = textWidth(s, font, el.spacing); }
    const th = FONTS[font].gh;
    return { s, font, tw, th, w: el.w !== undefined ? el.w : tw, h: el.h !== undefined ? el.h : th };
  }
  function iconFor(el, ctx) {
    let name = el.icon;
    if (el.map) {
      const r = lookup(el.value, ctx), key = r ? show(r.v).toLowerCase() : null;
      const hit = el.map.find(([k]) => k === key) || el.map.find(([k]) => k === "*");
      name = hit ? hit[1] : null;
    }
    return name;
  }
  function builtinIcon(name, ctx) {   // -> [[x, y, rgb?]] relative, or null
    if (name === "@degree") return DEG.map(([x, y]) => [x, y]);
    if (name === "@up") return [[2, 0], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2], [4, 2]];
    if (name === "@down") return [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [1, 1], [2, 1], [3, 1], [2, 2]];
    if (name === "@moon") {   // PROVISIONAL until pixeld's design: 7x7 disc lit by today's phase
      const days = (ctx.nowMs / 86400000 - 10957.5 - 6.3) % 29.530589, ph = ((days < 0 ? days + 29.530589 : days) / 29.530589);
      const out = [];
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const dx = x - 3, dy = y - 3; if (dx * dx + dy * dy > 10) continue;
        const term = Math.cos(ph * 2 * Math.PI) * Math.sqrt(Math.max(0, 10 - dy * dy)), lit = ph < 0.5 ? dx > -term : dx < term;
        out.push([x, y, lit ? null : [40, 40, 50]]);
      }
      return out;
    }
    if (name.startsWith("@coin:")) {   // PROVISIONAL: 9x9 gold disc with the symbol's first letter
      const out = [], sym = name.slice(6).toUpperCase();
      for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) { const dx = x - 4, dy = y - 4; if (dx * dx + dy * dy <= 18) out.push([x, y, [200, 150, 30]]); }
      const g = T3[sym[0]];
      if (g) for (let r = 0; r < 5; r++) for (let b = 0; b < 3; b++) if (g[r] & (4 >> b)) out.push([3 + b, 2 + r, [255, 240, 200]]);
      return out;
    }
    return null;
  }
  function drawIcon(fb, el, ctx, c, t) {
    const name = iconFor(el, ctx);
    if (!name) return;
    if (name.startsWith("@")) { const pts = builtinIcon(name, ctx); if (pts) for (const [x, y, col] of pts) px(fb, el.x + x, el.y + y, col || c); return; }
    const ic = ctx.icons && (ctx.icons[name] || ctx.icons[name + ".pxi"]);
    if (!ic || !ic.frames.length) return;
    let f = ic.frames[0];
    if (el.frame) {
      const r = lookup(el.frame, ctx), v = r && isNum(Array.isArray(r.v) ? r.v[r.v.length - 1] : r.v) ? num(Array.isArray(r.v) ? r.v[r.v.length - 1] : r.v) : null;
      if (v !== null) { const k = Math.round(Math.min(1, Math.max(0, (v - el.range[0]) / ((el.range[1] - el.range[0]) || 1))) * (ic.frames.length - 1)); f = ic.frames[k]; }
    } else if (ic.frames.length > 1) {
      const total = ic.frames.reduce((a, x) => a + Math.max(20, x.delay), 0);
      let tt = Math.floor(t * 1000) % total;
      for (const x of ic.frames) { const d = Math.max(20, x.delay); if (tt < d) { f = x; break; } tt -= d; }
    }
    for (let y = 0; y < ic.h; y++) for (let x = 0; x < ic.w; x++) {
      const i = (y * ic.w + x) * 4;
      if (f.rgba[i + 3] >= 128) px(fb, el.x + x, el.y + y, [f.rgba[i], f.rgba[i + 1], f.rgba[i + 2]]);
    }
  }
  const lerp = (a, b, k) => [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * k));
  function numberOf(name, ctx) {
    const r = lookup(name, ctx); if (!r) return null;
    const v = Array.isArray(r.v) ? r.v[r.v.length - 1] : r.v;
    return isNum(v) ? num(v) : null;
  }

  // ctx: {values, now: Date, nowMs, t (s since shown), fahrenheit, h12, icons: {name: {w, h, frames: [{delay, rgba}]}}}
  function render(scr, ctx0) {
    const ctx = Object.assign({ values: {}, t: 0, fahrenheit: false, h12: false, icons: {} }, ctx0);
    if (!ctx.now) ctx.now = new Date(ctx.nowMs || Date.now());
    if (!ctx.nowMs) ctx.nowMs = ctx.now.getTime();
    ctx.stale = scr.stale;
    const fb = canvas(scr.bg), t = ctx.t;
    for (const el of scr.elements) {
      if (el.hidden || !evalCond(el.cond, ctx)) continue;
      const c = colorOf(el.color, ctx);
      switch (el.type) {
        case "text": {
          const L = textLayout(el, ctx);
          const boxed = el.w !== undefined || el.h !== undefined;
          const clip = boxed ? [el.x, el.y, el.x + L.w, el.y + L.h] : null;
          let x = el.x, y = el.y;
          if (L.h > L.th) y += el.valign === "middle" ? Math.floor((L.h - L.th) / 2) : el.valign === "bottom" ? L.h - L.th : 0;
          if (el.overflow === "scroll" && L.tw > L.w) {
            const period = L.tw + 8, s = Math.floor(t * el.speed) % period;
            drawText(fb, L.s, L.font, x - s, y, c, el.spacing, clip);
            drawText(fb, L.s, L.font, x - s + period, y, c, el.spacing, clip);
          } else {
            x += el.align === "center" ? Math.floor((L.w - L.tw) / 2) : el.align === "right" ? L.w - L.tw : 0;   // also when it overflows: right keeps the end in view
            drawText(fb, L.s, L.font, x, y, c, el.spacing, clip);
          }
          break;
        }
        case "icon": drawIcon(fb, el, ctx, c, t); break;
        case "bar": {
          const horiz = el.dir === "right" || el.dir === "left", len = horiz ? el.w : el.h;
          const v = numberOf(el.value, ctx);
          const fr = v === null ? 0 : Math.min(1, Math.max(0, (v - el.min) / ((el.max - el.min) || 1)));
          const n = v === null ? 0 : Math.round(fr * len);
          for (let i = 0; i < len; i++) {
            const filled = i < n;
            let col = filled ? (el.fill ? lerp(el.fill[0], el.fill[1], len > 1 ? i / (len - 1) : 0) : c) : el.bg;
            if (filled && el.pulse && i === n - 1 && !blinkOn(t)) col = el.bg;
            if (!col) continue;
            for (let j = 0; j < (horiz ? el.h : el.w); j++) {
              if (el.dir === "right") px(fb, el.x + i, el.y + j, col);
              else if (el.dir === "left") px(fb, el.x + el.w - 1 - i, el.y + j, col);
              else if (el.dir === "down") px(fb, el.x + j, el.y + i, col);
              else px(fb, el.x + j, el.y + el.h - 1 - i, col);
            }
          }
          break;
        }
        case "spark": {
          const r = lookup(el.series, ctx);
          const pts = r && Array.isArray(r.v) ? r.v : r && isNum(r.v) ? [num(r.v)] : [];
          if (!pts.length) break;
          const lo = Math.min(...pts), hi = Math.max(...pts), n = pts.length;
          const P = pts.map((v, i) => [el.x + (n > 1 ? Math.round(i * (el.w - 1) / (n - 1)) : 0),
            el.y + (hi === lo ? Math.floor((el.h - 1) / 2) : (el.h - 1) - Math.round((v - lo) / (hi - lo) * (el.h - 1)))]);
          const line = new Map();
          const mark = (x, y) => { line.set(x + "," + y, [x, y]); };
          if (n === 1) mark(...P[0]); else for (let i = 1; i < n; i++) lineTo(P[i - 1][0], P[i - 1][1], P[i][0], P[i][1], mark);
          if (el.area) {
            const dim = c.map(v => Math.floor(v * 0.35)), top = new Map();
            for (const [x, y] of line.values()) if (!top.has(x) || y > top.get(x)) top.set(x, y);
            for (const [x, y] of top) for (let yy = y + 1; yy <= el.y + el.h - 1; yy++) px(fb, x, yy, dim);
          }
          for (const [x, y] of line.values()) px(fb, x, y, c);
          if (el.dot && blinkOn(t)) px(fb, P[n - 1][0], P[n - 1][1], [255, 255, 255]);
          break;
        }
        case "rect":
          for (let y = el.y; y < el.y + el.h; y++) for (let x = el.x; x < el.x + el.w; x++)
            if (el.fill || y === el.y || y === el.y + el.h - 1 || x === el.x || x === el.x + el.w - 1) px(fb, x, y, c);
          break;
        case "line": lineTo(el.x1, el.y1, el.x2, el.y2, (x, y) => px(fb, x, y, c)); break;
        case "pixel": px(fb, el.x, el.y, c); break;
      }
    }
    return fb;
  }

  // Would the screen show in the rotation now? (needs + stale + show; linger needs history, so it's reported apart)
  function visibility(scr, ctx) {
    const missing = scr.needs.filter(n => { const r = ctx.values[n]; return !r || (r.at !== undefined && ctx.nowMs - r.at > scr.stale * 1000); });
    const c = Object.assign({ stale: scr.stale }, ctx);
    return { missing, show: !missing.length && evalCond(scr.show, c), lingerCond: scr.linger ? evalCond(scr.linger.cond, c) : false };
  }

  // the box an element occupies (for the editor), and problems worth a warning
  function bounds(el, ctx) {
    if (el.type === "text") { const L = textLayout(el, ctx); return { x: el.x, y: el.y, w: L.w, h: L.h, L }; }
    if (el.type === "icon") {
      const name = iconFor(el, ctx) || el.icon || (el.map && el.map[0] && el.map[0][1]);
      if (name && name.startsWith("@")) { const s = name === "@moon" ? [7, 7] : name.startsWith("@coin:") ? [9, 9] : name === "@degree" ? [3, 3] : [5, 3]; return { x: el.x, y: el.y, w: s[0], h: s[1] }; }
      const ic = name && ctx.icons && (ctx.icons[name] || ctx.icons[name + ".pxi"]);
      return { x: el.x, y: el.y, w: ic ? ic.w : 8, h: ic ? ic.h : 8 };
    }
    if (el.type === "line") return { x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2), w: Math.abs(el.x2 - el.x1) + 1, h: Math.abs(el.y2 - el.y1) + 1 };
    if (el.type === "pixel") return { x: el.x, y: el.y, w: 1, h: 1 };
    return { x: el.x, y: el.y, w: el.w, h: el.h };
  }
  function warnings(el, ctx) {
    const out = [], b = bounds(el, ctx);
    if (b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= W || b.y >= H) out.push("off the panel");
    else if (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) out.push("partly off the panel");
    if (el.type === "text") {
      const L = b.L;
      if (el.w !== undefined && L.tw > L.w && el.overflow !== "scroll") out.push(`text is ${L.tw - L.w} px wider than its box`);
      if (el.h !== undefined && L.th > L.h) out.push("text is taller than its box");
      if (L.font === "tiny") { const bad = [...new Set([...L.s].filter(ch => !tinyOk(ch)))]; if (bad.length) out.push(`tiny font can't draw ${bad.map(c => `'${c}'`).join(" ")}`); }
    }
    return out;
  }

  const api = { W, H, LIMITS, FONTS, NAME_RE, parse, render, format, parseTemplate, parseCond, parseColor, evalCond, setValue, textWidth,
    textLayout, bounds, warnings, visibility, tokenize, lookup, show, tinyOk };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ScreenRender = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
