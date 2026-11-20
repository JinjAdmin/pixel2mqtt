"use strict";
// Screen editor: info screens (.scr) for pixeld - layout, value bindings to Home Assistant entities, sample values.
// The preview is always render(parse(compile(project))), so what the canvas shows is exactly what is sent.
// Uses screenrender.js (ScreenRender) and app.js helpers (api, el, toast, ask, askText, cur, lib, getIcon, ...).
const Screens = (() => {
  const R = ScreenRender, S = 16;               // canvas cell size (px)
  const BUILTIN = new Set(["time", "date", "weekday", "month", "day", "hour", "minute", "second"]);
  const OPS = ["==", "!=", "<", ">", "<=", ">=", "in", "has", "fresh"];
  const FONT_LABEL = { tiny: "Tiny 3×5", small: "Small 5×7", big: "Big 10×14", huge: "Huge 15×21" };
  const KIND_CHIPS = [["num", "Number"], ["text", "Text/state"], ["onoff", "On/off"], ["weather", "Weather"], ["hist", "Has history"]];
  const root = $("#screenMain");
  let st = null;            // the open project: {name, rev, sent, edited, doc}
  let selId = null, undoStack = [], redoStack = [], mode = "sample", live = {}, liveErr = "", t0 = performance.now(), playing = true;
  let ha = { available: false }, reg = null, regAt = 0, report = null, compiled = null, parsed = null, lineOf = new Map();
  const icons = {};          // name -> {w, h, frames} from the display's icon library
  let drag = null, guides = [], dirty = true;
  const uid = () => Math.random().toString(36).slice(2, 9);

  /* ================================================================ model */
  function newDoc(name) {
    return { settings: { name, needs: [], show: [], linger: [], lingerFor: "30m", stale: "", time: "", order: "", bg: "#000000" },
      elements: [], bindings: {}, samples: {} };
  }
  const DEFAULTS = {
    text: () => ({ type: "text", x: 2, y: 2, w: null, h: null, font: "small", align: "left", valign: "top", overflow: "clip", speed: 15, spacing: 0, text: "Text" }),
    icon: () => ({ type: "icon", x: 20, y: 8, icon: "", frame: "", range: "0,100" }),
    iconmap: () => ({ type: "icon", x: 20, y: 8, byValue: true, value: "", map: [{ k: "*", icon: "" }] }),
    bar: () => ({ type: "bar", x: 2, y: 24, w: 48, h: 3, value: "", min: 0, max: 100, fill: "#00a0ff", fill2: "", bg: "#1e1e2a", dir: "right", pulse: false }),
    spark: () => ({ type: "spark", x: 2, y: 10, w: 48, h: 12, series: "", area: false, dot: false }),
    rect: () => ({ type: "rect", x: 10, y: 8, w: 32, h: 16, fill: false }),
    line: () => ({ type: "line", x: 4, y: 16, x2: 47, y2: 16 }),
    pixel: () => ({ type: "pixel", x: 26, y: 16 }),
  };
  function newElement(kind) {
    const e = Object.assign({ id: uid(), hidden: false, locked: false, color: { base: kind === "rect" || kind === "line" ? "#5a5a6e" : "#ffffff", rules: [] }, show: [] }, DEFAULTS[kind]());
    return e;
  }
  const doc = () => st.doc;
  const elById = id => doc().elements.find(e => e.id === id);
  const sel = () => elById(selId);

  /* ================================================================ compile (project -> .scr) */
  const q = s => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const atom = r => r.op === "has" || r.op === "fresh" ? `${r.op}(${r.name})` : r.op === "in" ? `${r.name} in ${r.lit}` : `${r.name}${r.op}${r.lit}`;
  const condText = rows => rows.filter(r => r.name).map((r, i) => (i ? ` ${r.join || "&&"} ` : "") + atom(r)).join("");
  const opt = (k, v) => (/[\s"]/.test(String(v)) ? `${k}=${q(v)}` : `${k}=${v}`);
  function colorOpt(c) {
    const rules = (c.rules || []).filter(r => r.name && r.color);
    if (!rules.length) return c.base && c.base.toLowerCase() !== "#ffffff" ? opt("color", c.base) : "";
    return opt("color", rules.map(r => `${atom(r)}:${r.color}`).join(",") + "," + (c.base || "#ffffff"));
  }
  function elementLine(e) {
    const o = [];
    const common = () => { const c = colorOpt(e.color || { base: "#ffffff" }), s = condText(e.show || []); if (c) o.push(c); if (s) o.push(opt("if", s)); };
    switch (e.type) {
      case "text":
        o.push("text", e.x, e.y);
        if (e.font !== "small") o.push("font=" + e.font);
        if (e.w !== null && e.w !== undefined && e.w !== "") o.push("w=" + e.w);
        if (e.h !== null && e.h !== undefined && e.h !== "") o.push("h=" + e.h);
        if (e.align !== "left") o.push("align=" + e.align);
        if (e.valign !== "top") o.push("valign=" + e.valign);
        if (e.overflow !== "clip") o.push("overflow=" + e.overflow);
        if (e.overflow === "scroll" && +e.speed !== 15) o.push("speed=" + e.speed);
        if (+e.spacing) o.push("spacing=" + e.spacing);
        common(); o.push(q(e.text || ""));
        break;
      case "icon":
        o.push("icon", e.x, e.y);
        if (e.byValue) { o.push("value=" + (e.value || "x")); o.push(opt("map", e.map.filter(m => m.k && m.icon).map(m => `${m.k}:${m.icon}`).join(","))); }
        else { o.push(e.icon || "@degree"); if (e.frame) { o.push("frame=" + e.frame); if (e.range && e.range !== "0,100") o.push("range=" + e.range); } }
        common(); break;
      case "bar":
        o.push("bar", e.x, e.y, e.w, e.h, "value=" + (e.value || "x"));
        if (+e.min !== 0) o.push("min=" + e.min);
        if (+e.max !== 100) o.push("max=" + e.max);
        if (e.fill) o.push("fill=" + e.fill + (e.fill2 ? ".." + e.fill2 : ""));
        if (e.bg) o.push("bg=" + e.bg);
        if (e.dir !== "right") o.push("dir=" + e.dir);
        if (e.pulse) o.push("pulse=1");
        common(); break;
      case "spark":
        o.push("spark", e.x, e.y, e.w, e.h, "series=" + (e.series || "x"));
        if (e.area) o.push("area=1");
        if (e.dot) o.push("dot=1");
        common(); break;
      case "rect": o.push("rect", e.x, e.y, e.w, e.h); if (e.fill) o.push("fill=1"); common(); break;
      case "line": o.push("line", e.x, e.y, e.x2, e.y2); common(); break;
      case "pixel": o.push("pixel", e.x, e.y); common(); break;
    }
    return o.join(" ");
  }
  function compile(d, { preview = false } = {}) {
    const s = d.settings, out = ["PXS1"], map = new Map();
    out.push("name " + (s.name || st.name));
    const needs = (s.needs || []).filter(Boolean);
    if (needs.length) out.push("needs " + needs.join(" "));
    if (condText(s.show || [])) out.push("show " + condText(s.show));
    if (condText(s.linger || []) && s.lingerFor) out.push(`linger ${condText(s.linger)} ${s.lingerFor}`);
    if (s.stale) out.push("stale " + s.stale);
    if (s.time !== "" && s.time !== null && s.time !== undefined) out.push("time " + s.time);
    if (s.order !== "" && s.order !== null && s.order !== undefined) out.push("order " + s.order);
    if (s.bg && s.bg.toLowerCase() !== "#000000") out.push("bg " + s.bg);
    out.push("");
    for (const e of d.elements) {
      if (preview && e.hidden) continue;
      map.set(out.length + 1, e.id); out.push(elementLine(e));
    }
    return { text: out.join("\n") + "\n", lineOf: map };
  }
  // value names a project uses (for bindings, needs and the Values panel)
  function usedNames(d) {
    const names = new Set(), add = n => { if (n && !BUILTIN.has(n)) names.add(n.endsWith(".trend") ? n.slice(0, -6) : n); };
    const conds = rows => (rows || []).forEach(r => add(r.name));
    for (const e of d.elements) {
      conds(e.show); (e.color && e.color.rules || []).forEach(r => add(r.name));
      if (e.type === "text") for (const m of (e.text || "").matchAll(/\{([a-z0-9_.-]+)/g)) add(m[1]);
      ["value", "series", "frame"].forEach(k => e[k] && add(e[k]));
    }
    conds(d.settings.show); conds(d.settings.linger); (d.settings.needs || []).forEach(add);
    return [...names];
  }

  /* ================================================================ decompile (.scr -> project), for examples and imports */
  function rowsFromCond(text) {
    if (!text) return [];
    const rows = [];
    text.split("||").forEach((part, i) => part.split("&&").forEach((a, j) => {
      a = a.trim(); const join = !rows.length ? "&&" : j === 0 ? "||" : "&&";
      let m = a.match(/^(has|fresh)\(\s*([a-z0-9_.-]+)\s*\)$/);
      if (m) return rows.push({ join, op: m[1], name: m[2], lit: "" });
      m = a.match(/^([a-z0-9_.-]+)\s+in\s+(.+)$/);
      if (m) return rows.push({ join, op: "in", name: m[1], lit: m[2].trim() });
      m = a.match(/^([a-z0-9_.-]+)\s*(==|!=|<=|>=|<|>)\s*(.*)$/);
      if (m) rows.push({ join, op: m[2], name: m[1], lit: m[3].trim() });
    }));
    return rows;
  }
  function colorFromOpt(text) {
    if (!text) return { base: "#ffffff", rules: [] };
    const parts = []; let acc = "";
    for (const s of text.split(",")) { acc = acc ? acc + "," + s : s; if (/#[0-9a-f]{6}\s*$/i.test(acc)) { parts.push(acc); acc = ""; } }
    const c = { base: "#ffffff", rules: [] };
    for (const p of parts) { const i = p.lastIndexOf(":#"); if (i < 0) c.base = p.trim(); else c.rules.push(Object.assign(rowsFromCond(p.slice(0, i))[0] || {}, { color: p.slice(i + 1).trim() })); }
    return c;
  }
  function fromScr(text, name) {
    const d = newDoc(name), s = d.settings;
    const lines = text.replace(/\r/g, "").split("\n");
    for (const raw of lines.slice(1)) {
      let toks; try { toks = R.tokenize(raw); } catch (e) { continue; }
      if (!toks.length) continue;
      const kw = toks[0].v, rest = toks.slice(1), restText = raw.replace(/^\s*\S+\s*/, "").replace(/\s+#.*$/, "").trim();
      const o = {}; for (const t of rest) if (t.k) o[t.k] = t.v;
      const nums = rest.filter(t => !t.k && !t.q).map(t => t.v);
      if (kw === "name") s.name = rest.map(t => t.v).join(" ");
      else if (kw === "needs") s.needs = rest.map(t => t.v);
      else if (kw === "show") s.show = rowsFromCond(restText);
      else if (kw === "linger") { const k = restText.lastIndexOf(" "); s.linger = rowsFromCond(restText.slice(0, k)); s.lingerFor = restText.slice(k + 1); }
      else if (kw === "stale") s.stale = nums[0] || "";
      else if (kw === "time") s.time = nums[0] || "";
      else if (kw === "order") s.order = nums[0] || "";
      else if (kw === "bg") s.bg = nums[0] || "#000000";
      else if (DEFAULTS[kw]) {
        const e = newElement(kw === "icon" && o.map ? "iconmap" : kw);
        e.color = colorFromOpt(o.color); e.show = rowsFromCond(o.if);
        const n = nums.map(Number);
        if (kw === "text") {
          Object.assign(e, { x: n[0], y: n[1], text: (rest.find(t => t.q && !t.k) || { v: "" }).v, font: o.font || "small", align: o.align || "left",
            valign: o.valign || "top", overflow: o.overflow || "clip", speed: +(o.speed || 15), spacing: +(o.spacing || 0),
            w: o.w !== undefined ? +o.w : null, h: o.h !== undefined ? +o.h : null });
        } else if (kw === "icon") {
          Object.assign(e, { x: n[0], y: n[1] });
          if (o.map) { e.value = o.value || ""; e.map = o.map.split(",").map(p => { const k = p.indexOf(":"); return { k: p.slice(0, k), icon: p.slice(k + 1) }; }); }
          else Object.assign(e, { icon: nums[2] || "", frame: o.frame || "", range: o.range || "0,100" });
        } else if (kw === "bar") {
          const [a, b] = (o.fill || "").split("..");
          Object.assign(e, { x: n[0], y: n[1], w: n.length > 2 ? n[2] : +o.w, h: n.length > 3 ? n[3] : +o.h, value: o.value || "", min: +(o.min || 0), max: +(o.max || 100),
            fill: a || "", fill2: b || "", bg: o.bg || "", dir: o.dir || "right", pulse: o.pulse === "1" });
        } else if (kw === "spark") Object.assign(e, { x: n[0], y: n[1], w: n.length > 2 ? n[2] : +o.w, h: n.length > 3 ? n[3] : +o.h, series: o.series || "", area: o.area === "1", dot: o.dot === "1" });
        else if (kw === "rect") Object.assign(e, { x: n[0], y: n[1], w: n.length > 2 ? n[2] : +o.w, h: n.length > 3 ? n[3] : +o.h, fill: o.fill === "1" });
        else if (kw === "line") Object.assign(e, { x: n[0], y: n[1], x2: n[2], y2: n[3] });
        else Object.assign(e, { x: n[0], y: n[1] });
        d.elements.push(e);
      }
    }
    return d;
  }

  /* ================================================================ values for the preview */
  const nowMs = () => Date.now();
  function sampleValue(raw) {   // the sample editor's text -> a value (number, text, list, [n, unit], or null)
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") return raw;
    const s = raw.trim();
    if (s === "") return undefined;
    if (s === "null") return null;
    if (/^\[.*\]$/.test(s)) { try { return JSON.parse(s); } catch (e) { /* plain text */ } }
    if (/^-?\d+(\.\d+)?(\s*,\s*-?\d+(\.\d+)?)+$/.test(s)) return s.split(",").map(Number);   // 1, 2, 3 -> list
    const u = s.match(/^(-?\d+(?:\.\d+)?)\s*(°[CF]|%|[a-zA-Z/°µ]+)$/);
    if (u) return [+u[1], u[2]];
    if (/^-?\d+(\.\d+)?$/.test(s)) return +s;
    return s;
  }
  function currentValues() {
    const vals = {}, t = nowMs(), d = doc();
    for (const [k, raw] of Object.entries(d.samples)) { const v = sampleValue(raw); if (v !== undefined && v !== null) R.setValue(vals, k, v, t); }
    if (mode === "live") for (const [k, v] of Object.entries(live)) { if (v === null) delete vals[k]; else R.setValue(vals, k, v, t); }
    return vals;
  }
  function ctx() {
    const d = display();
    const state = (d && d.state) || {};
    const f = Object.entries(state).find(([k]) => /fahrenheit/i.test(k)), h = Object.entries(state).find(([k]) => /12.?h/i.test(k));
    return { values: currentValues(), nowMs: nowMs(), t: playing ? (performance.now() - t0) / 1000 : 0, icons,
      fahrenheit: f ? /^(on|true|1)$/i.test(f[1]) : false, h12: h ? /^(on|true|1)$/i.test(h[1]) : false };
  }
  async function loadIcons() {   // icons the screen uses, from the display's library
    const names = new Set();
    for (const e of doc().elements) if (e.type === "icon") { if (e.byValue) e.map.forEach(m => m.icon && names.add(m.icon)); else if (e.icon) names.add(e.icon); }
    for (const n of names) if (!n.startsWith("@") && !icons[n] && cur && lib.icons.some(f => stem(f.name) === n)) {
      try { const ic = await getIcon(n); icons[n] = { w: ic.w, h: ic.h, frames: ic.frames.map(f => ({ delay: f.delay, rgba: f.rgba })) }; dirty = true; } catch (e) { /* not on this display */ }
    }
  }

  /* ================================================================ undo / edits */
  const snap = () => JSON.stringify(doc());
  function edit(fn, { soft = false } = {}) {   // every change goes through here
    if (!soft) { undoStack.push(snap()); if (undoStack.length > 60) undoStack.shift(); redoStack = []; }
    fn(); st.edited = true; recompile(); syncDoc();
  }
  function undo() { if (!undoStack.length) return; redoStack.push(snap()); st.doc = JSON.parse(undoStack.pop()); st.edited = true; afterLoad(); }
  function redo() { if (!redoStack.length) return; undoStack.push(snap()); st.doc = JSON.parse(redoStack.pop()); st.edited = true; afterLoad(); }
  function recompile() {
    const c = compile(doc(), { preview: true });
    compiled = c.text; lineOf = c.lineOf; parsed = R.parse(compiled, st.name);
    dirty = true; renderLayers(); renderErrors();
  }

  /* ================================================================ UI skeleton */
  root.innerHTML = `
  <div class="stagebar">
    <span class="docbar">
      <button id="scrHome" title="Back to all projects (saves first)">◂ Projects</button>
      <span class="badge">Screen</span>
      <button id="scrName" class="docname" title="Rename"></button>
      <span id="scrStatus" class="chip"></span>
      <button id="scrSave">Save</button>
      <button id="scrSend" class="primary" title="Upload to the display and turn on its value bindings">Send to display</button>
      <button id="scrRemove" title="Remove this screen from the display (its bindings stop)">Remove from display</button>
    </span>
    <span class="grow"></span>
    <span class="segs" id="scrMode" title="Preview values"><button data-m="sample" class="on">Sample</button><button data-m="live">Live</button></span>
    <label class="toggle" title="Stream the preview to the display"><input id="scrLive" type="checkbox"> <b>Live on display</b></label>
  </div>
  <div class="scr-grid">
    <div class="scr-left card">
      <h3>Add</h3>
      <div class="scr-palette" id="scrPalette"></div>
      <h3 style="margin-top:12px">Elements <span class="muted small">(top = drawn last)</span></h3>
      <div id="scrLayers" class="scr-layers"></div>
    </div>
    <div class="scr-center">
      <div class="canvaswrap"><canvas id="scrCv" width="${52 * S}" height="${32 * S}"></canvas></div>
      <div class="stagebar small"><button id="scrPlay" title="Animate scrolling, blinking and animated icons">⏸</button>
        <span id="scrVis" class="small"></span><span class="grow"></span><span id="scrPos" class="muted small">–</span></div>
      <div id="scrErrors" class="scr-errors"></div>
    </div>
    <div class="scr-right">
      <div class="segs wide" id="scrTabs"><button data-t="el" class="on">Element</button><button data-t="values">Values</button><button data-t="screen">Screen</button><button data-t="file">.scr</button></div>
      <div id="scrPaneEl" class="card scr-pane"></div>
      <div id="scrPaneValues" class="card scr-pane hidden"></div>
      <div id="scrPaneScreen" class="card scr-pane hidden"></div>
      <div id="scrPaneFile" class="card scr-pane hidden"><pre id="scrFile" class="scr-file"></pre></div>
    </div>
  </div>`;
  const cv = $("#scrCv"), g = cv.getContext("2d");
  const PALETTE = [["text", "Text", "T"], ["value", "Value", "{x}"], ["icon", "Icon", "◆"], ["iconmap", "Icon by value", "◆?"],
    ["bar", "Progress bar", "▬"], ["spark", "Sparkline", "∿"], ["rect", "Rectangle", "▭"], ["line", "Line", "╱"]];
  $("#scrPalette").replaceChildren(...PALETTE.map(([k, label, glyph]) => {
    const b = el("button", { draggable: "true", title: `Add ${label.toLowerCase()} (click, or drag onto the canvas)`, onclick: () => addElement(k) }, el("span", { cls: "g" }, glyph), label);
    b.addEventListener("dragstart", ev => ev.dataTransfer.setData("text/x-screen-el", k));
    return b;
  }));
  cv.addEventListener("dragover", ev => { if ([...ev.dataTransfer.types].includes("text/x-screen-el")) ev.preventDefault(); });
  cv.addEventListener("drop", ev => { const k = ev.dataTransfer.getData("text/x-screen-el"); if (!k) return; ev.preventDefault(); const [x, y] = cellAt(ev); addElement(k, x, y); });

  /* ================================================================ open / save / send */
  function syncDoc() {
    if (!st) return;
    $("#scrName").textContent = st.name + (st.edited ? " •" : "");
    const s = !st.sent || st.sent.as !== st.name ? ["Draft", "draft"] : st.sent.rev === st.rev && !st.edited ? ["On display", "ok"] : ["Changed since sent", "warn"];
    $("#scrStatus").textContent = s[0]; $("#scrStatus").className = "chip " + s[1];
    $("#scrRemove").classList.toggle("hidden", !(st.sent && st.sent.as));
  }
  function projectJSON() {
    return JSON.stringify({ version: 1, w: 52, h: 32, bg: [0, 0, 0], layers: [], meta: { type: "screen", rev: st.rev, sent: st.sent }, screen: doc() });
  }
  async function save(quiet) {
    if (!st) return;
    if (st.edited) st.rev++;
    const was = st.edited; st.edited = false; syncDoc();
    try { await api(`/scenes/${enc(st.name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: projectJSON() }); }
    catch (e) { if (was) { st.edited = true; syncDoc(); } throw e; }
    try { localStorage.setItem("p2m.lastProject", st.name); } catch (e) { /* private mode */ }
    if (!quiet) toast(`Saved "${st.name}"`);
  }
  function afterLoad() { selId = doc().elements.length ? doc().elements[doc().elements.length - 1].id : null; recompile(); renderAll(); loadIcons(); syncDoc(); }
  function open(name, data, opts = {}) {
    st = { name, rev: (data.meta && data.meta.rev) || 0, sent: (data.meta && data.meta.sent) || null, edited: !!opts.edited, doc: data.screen || newDoc(name) };
    for (const e of st.doc.elements) if (!e.id) e.id = uid();
    undoStack = []; redoStack = []; live = {}; report = null; t0 = performance.now();
    root.classList.remove("hidden"); afterLoad(); refreshHA(); fetchReport();
    if (opts.edited) save(true).catch(e => toast(e.message, true));
  }
  function close() { st = null; root.classList.add("hidden"); $("#scrLive").checked = false; }
  const isOpen = () => !!st;
  async function send() {
    if (!cur) return toast("Adopt a display first", true);
    const c = compile(doc());
    const errs = R.parse(c.text, st.name).errors;
    if (errs.length && !await ask(`This screen has ${errs.length} problem${errs.length > 1 ? "s" : ""} (see the list under the canvas). The display skips those lines. Send anyway?`, { ok: "Send" })) return;
    const names = usedNames(doc()), bindings = {};
    for (const n of names) if (doc().bindings[n]) bindings[n] = doc().bindings[n];
    try {
      await save(true);
      await api(`/displays/${cur}/screens/${enc(st.name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scr: c.text, bindings }) });
      st.sent = { as: st.name, rev: st.rev }; await save(true); syncDoc();
      const unbound = names.filter(n => !doc().bindings[n]);
      toast(`"${st.name}" is on the display` + (Object.keys(bindings).length ? `, with ${Object.keys(bindings).length} value${Object.keys(bindings).length > 1 ? "s" : ""} from Home Assistant` : "") +
        (unbound.length ? `. Not bound: ${unbound.join(", ")}` : ""));
      setTimeout(fetchReport, 1500);
    } catch (e) { toast(e.message, true); }
  }
  async function removeFromDisplay() {
    if (!cur || !st.sent) return;
    if (!await ask(`Remove "${st.sent.as}" from the display? Its value bindings stop. The project stays here.`, { ok: "Remove", danger: true })) return;
    try { await api(`/displays/${cur}/screens/${enc(st.sent.as)}`, { method: "DELETE" }); st.sent = null; st.edited = true; await save(true); syncDoc(); toast("Removed from the display"); }
    catch (e) { toast(e.message, true); }
  }
  async function fetchReport() {   // what the display says about its screens (errors, visibility, missing values)
    report = null;
    if (!cur || !st) return renderErrors();
    try { const r = await api(`/displays/${cur}/screens`); report = (Array.isArray(r) ? r : r.screens || []).find(s => s.name === st.name || s.file === st.name + ".scr") || null; }
    catch (e) { report = { unavailable: e.message }; }
    renderErrors();
  }
  $("#scrHome").addEventListener("click", async () => { try { if (st && st.edited) await save(true); } catch (e) { return toast(e.message, true); } close(); Editor.showProjects(); });
  $("#scrSave").addEventListener("click", () => save().catch(e => toast(e.message, true)));
  $("#scrSend").addEventListener("click", send);
  $("#scrRemove").addEventListener("click", removeFromDisplay);
  $("#scrName").addEventListener("click", async () => {
    const n = await askText("Project name (also the screen's file name on the display)", st.name, { ok: "Rename" }); if (!n) return;
    const name = n.trim().replace(/[\\/"\x00-\x1f]+/g, " ").trim(); if (!name || name === st.name) return;
    const old = st.name; st.name = name; st.edited = true;
    if (doc().settings.name === old) doc().settings.name = name;
    try { await save(true); await api(`/scenes/${enc(old)}`, { method: "DELETE" }); syncDoc(); recompile(); toast(`Renamed to "${name}"` + (st.sent ? ". Send again to put it on the display under the new name." : "")); }
    catch (e) { st.name = old; toast(e.message, true); }
  });
  setInterval(() => { if (st && st.edited && !drag) save(true).catch(() => {}); }, 5000);
  document.addEventListener("visibilitychange", () => { if (document.hidden && st && st.edited) save(true).catch(() => {}); });

  /* ================================================================ canvas */
  function cellAt(ev) { const r = cv.getBoundingClientRect(); return [Math.floor((ev.clientX - r.left) / r.width * 52), Math.floor((ev.clientY - r.top) / r.height * 32)]; }
  function boxOf(e, c) {   // editor box (from the parsed element, so text boxes follow their content)
    if (e.type === "line") return { x: Math.min(e.x, e.x2), y: Math.min(e.y, e.y2), w: Math.abs(e.x2 - e.x) + 1, h: Math.abs(e.y2 - e.y) + 1 };
    const p = parsedOf(e);
    if (p) return R.bounds(p, c);
    return { x: e.x, y: e.y, w: e.w || 8, h: e.h || 8 };
  }
  function parsedOf(e) { if (!parsed) return null; for (const [line, id] of lineOf) if (id === e.id) return parsed.elements.find(p => p.line === line) || null; return null; }
  const resizable = e => ["bar", "spark", "rect"].includes(e.type) || e.type === "text";
  function handles(e, b) {
    if (e.type === "line") return [["p1", e.x + .5, e.y + .5], ["p2", e.x2 + .5, e.y2 + .5]];
    if (!resizable(e)) return [];
    return [["se", b.x + b.w, b.y + b.h], ["e", b.x + b.w, b.y + b.h / 2], ["s", b.x + b.w / 2, b.y + b.h]];
  }
  function draw() {
    if (!st) return;
    const c = ctx(), fb = parsed ? R.render(parsed, c) : new Uint8ClampedArray(52 * 32 * 3);
    st.lastFrame = fb;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 52; x++) {
      const i = (y * 52 + x) * 3; g.fillStyle = `rgb(${fb[i]},${fb[i + 1]},${fb[i + 2]})`; g.fillRect(x * S, y * S, S, S);
    }
    g.strokeStyle = "rgba(255,255,255,.06)"; g.lineWidth = 1; g.beginPath();
    for (let x = 1; x < 52; x++) { g.moveTo(x * S + .5, 0); g.lineTo(x * S + .5, 32 * S); }
    for (let y = 1; y < 32; y++) { g.moveTo(0, y * S + .5); g.lineTo(52 * S, y * S + .5); }
    g.stroke();
    for (const gd of guides) { g.strokeStyle = "#ff3dbb"; g.lineWidth = 1; g.beginPath(); if (gd.x !== undefined) { g.moveTo(gd.x * S + .5, 0); g.lineTo(gd.x * S + .5, 32 * S); } else { g.moveTo(0, gd.y * S + .5); g.lineTo(52 * S, gd.y * S + .5); } g.stroke(); }
    const e = sel();
    if (e && !e.hidden) {
      const b = boxOf(e, c), warn = parsedOf(e) && R.warnings(parsedOf(e), c).length;
      g.setLineDash([4, 3]); g.strokeStyle = warn ? "#e5534b" : "#e8a33a"; g.lineWidth = 2;
      g.strokeRect(b.x * S + 1, b.y * S + 1, b.w * S - 2, b.h * S - 2); g.setLineDash([]);
      if (!e.locked) for (const [, hx, hy] of handles(e, b)) { g.fillStyle = "#fff"; g.fillRect(hx * S - 4, hy * S - 4, 8, 8); g.strokeStyle = "#000"; g.strokeRect(hx * S - 4 + .5, hy * S - 4 + .5, 7, 7); }
    }
  }
  function hit(x, y, c) {
    const els = doc().elements;
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i]; if (e.hidden) continue;
      const b = boxOf(e, c); if (x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h) return e;
    }
    return null;
  }
  function snapTargets(moving) {   // panel edges and centre lines, other elements' edges and centres
    const xs = [0, 26, 52], ys = [0, 16, 32], c = ctx();
    for (const o of doc().elements) if (o.id !== moving.id && !o.hidden) { const b = boxOf(o, c); xs.push(b.x, b.x + b.w, b.x + Math.floor(b.w / 2)); ys.push(b.y, b.y + b.h, b.y + Math.floor(b.h / 2)); }
    return { xs, ys };
  }
  cv.addEventListener("pointerdown", ev => {
    if (!st) return;
    try { cv.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic */ }
    const r = cv.getBoundingClientRect(), fx = (ev.clientX - r.left) / r.width * 52, fy = (ev.clientY - r.top) / r.height * 32, [x, y] = cellAt(ev), c = ctx();
    const cs = sel();
    if (cs && !cs.locked) {   // a handle of the selected element?
      const b = boxOf(cs, c);
      for (const [name, hx, hy] of handles(cs, b)) if (Math.abs(fx - hx) * S <= 10 && Math.abs(fy - hy) * S <= 10) {
        undoStack.push(snap()); redoStack = [];
        drag = { kind: "resize", h: name, id: cs.id, x0: x, y0: y, orig: JSON.parse(JSON.stringify(cs)), box: b }; return;
      }
    }
    const e = hit(x, y, c);
    selId = e ? e.id : null; renderLayers(); renderInspector(); dirty = true;
    if (e && !e.locked) { undoStack.push(snap()); redoStack = []; drag = { kind: "move", id: e.id, x0: x, y0: y, orig: JSON.parse(JSON.stringify(e)), box: boxOf(e, c), moved: false }; }
  });
  cv.addEventListener("pointermove", ev => {
    if (!st) return;
    const [x, y] = cellAt(ev); $("#scrPos").textContent = `x ${x}, y ${y}`;
    if (!drag) return;
    const e = elById(drag.id), o = drag.orig, dx = x - drag.x0, dy = y - drag.y0;
    guides = [];
    if (drag.kind === "move") {
      if (!dx && !dy && !drag.moved) return;
      drag.moved = true;
      let nx = drag.box.x + dx, ny = drag.box.y + dy;
      if (!ev.altKey) {   // snap the box's left/centre/right (top/middle/bottom) to a target within 1 px
        const { xs, ys } = snapTargets(e), b = drag.box;
        const sx = [[nx, 0], [nx + Math.floor(b.w / 2), Math.floor(b.w / 2)], [nx + b.w, b.w]], sy = [[ny, 0], [ny + Math.floor(b.h / 2), Math.floor(b.h / 2)], [ny + b.h, b.h]];
        snapX: for (const [v, off] of sx) for (const tx of xs) if (Math.abs(v - tx) <= 1) { nx = tx - off; guides.push({ x: tx }); break snapX; }
        snapY: for (const [v, off] of sy) for (const ty of ys) if (Math.abs(v - ty) <= 1) { ny = ty - off; guides.push({ y: ty }); break snapY; }
      }
      const mx = nx - drag.box.x, my = ny - drag.box.y;
      e.x = o.x + mx; e.y = o.y + my;
      if (e.type === "line") { e.x2 = o.x2 + mx; e.y2 = o.y2 + my; }
    } else {
      if (drag.h === "p1") { e.x = x; e.y = y; } else if (drag.h === "p2") { e.x2 = x; e.y2 = y; }
      else {
        const b = drag.box;
        if (drag.h !== "s") e.w = Math.max(1, b.w + dx);
        if (drag.h !== "e") e.h = Math.max(1, b.h + dy);
        if (e.type === "text") { if (drag.h === "s") e.w = b.w; if (drag.h === "e") e.h = b.h; }
      }
    }
    st.edited = true; recompile(); syncDoc();
  });
  cv.addEventListener("pointerup", () => {
    if (drag && drag.kind === "move" && !drag.moved) undoStack.pop();
    drag = null; guides = []; dirty = true; renderInspector();
  });
  cv.addEventListener("pointerleave", () => { $("#scrPos").textContent = "–"; });
  document.addEventListener("keydown", ev => {
    if (!st || root.classList.contains("hidden") || !$("#tab-editor").classList.contains("active")) return;
    if (ev.target.matches && ev.target.matches("input, select, textarea, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === "z") { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === "y") { ev.preventDefault(); redo(); return; }
    const e = sel(); if (!e) return;
    if (k === "delete" || k === "backspace") { ev.preventDefault(); return removeElement(e); }
    if (k.startsWith("arrow") && !e.locked) {
      ev.preventDefault();
      const n = ev.shiftKey ? 5 : 1, dx = k === "arrowleft" ? -n : k === "arrowright" ? n : 0, dy = k === "arrowup" ? -n : k === "arrowdown" ? n : 0;
      edit(() => { e.x += dx; e.y += dy; if (e.type === "line") { e.x2 += dx; e.y2 += dy; } });
      renderInspector();
    }
  });
  function frame() {
    if (st && !root.classList.contains("hidden") && (dirty || playing)) { draw(); dirty = false; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  $("#scrPlay").addEventListener("click", () => { playing = !playing; $("#scrPlay").textContent = playing ? "⏸" : "▶"; t0 = performance.now(); dirty = true; });

  /* ================================================================ elements list */
  const describe = e => e.type === "text" ? (e.text || "(empty text)") : e.type === "icon" ? (e.byValue ? `icon by ${e.value || "?"}` : `icon ${e.icon || "?"}`)
    : e.type === "bar" ? `bar ${e.value || "?"}` : e.type === "spark" ? `sparkline ${e.series || "?"}` : e.type;
  function errorsFor(e) {
    const out = [];
    if (!parsed) return out;
    for (const [line, id] of lineOf) if (id === e.id) {
      for (const er of parsed.errors) if (er.line === line) out.push(er.msg);
      if (report && report.errors) for (const er of report.errors) if (er.line === line) out.push("display: " + er.msg);
    }
    const p = parsedOf(e); if (p) out.push(...R.warnings(p, ctx()));
    return out;
  }
  let dragRow = null;
  function renderLayers() {
    if (!st) return;
    const els = doc().elements;
    $("#scrLayers").replaceChildren(...(els.length ? [...els].reverse().map(e => {
      const errs = errorsFor(e);
      const row = el("div", { cls: "ly" + (e.id === selId ? " sel" : "") + (e.hidden ? " off" : ""), draggable: "true", title: errs.join("\n"),
        onclick: () => { selId = e.id; renderLayers(); renderInspector(); setTab("el"); dirty = true; } },
        el("button", { title: e.hidden ? "Show (hidden while editing; still sent)" : "Hide while editing", onclick: ev => { ev.stopPropagation(); edit(() => { e.hidden = !e.hidden; }); } }, e.hidden ? "◌" : "👁"),
        el("button", { title: e.locked ? "Unlock" : "Lock (can't be moved on the canvas)", onclick: ev => { ev.stopPropagation(); edit(() => { e.locked = !e.locked; }); } }, e.locked ? "🔒" : "🔓"),
        el("span", { cls: "n" }, describe(e)), errs.length ? el("span", { cls: "warnmark", title: errs.join("\n") }, "⚠") : "");
      row.addEventListener("dragstart", () => { dragRow = e.id; });
      row.addEventListener("dragover", ev => { if (dragRow) ev.preventDefault(); });
      row.addEventListener("drop", ev => {
        ev.preventDefault(); if (!dragRow || dragRow === e.id) return;
        const from = els.findIndex(x => x.id === dragRow), to = els.findIndex(x => x.id === e.id);
        edit(() => { const [m] = els.splice(from, 1); els.splice(to, 0, m); }); dragRow = null;
      });
      return row;
    }) : [el("p", { cls: "muted small" }, "Nothing yet. Add an element above.")]));
  }
  function renderErrors() {
    if (!st) return;
    const items = [];
    if (parsed) for (const er of parsed.errors) { const id = lineOf.get(er.line); items.push(`Line ${er.line}${id ? ` (${describe(elById(id))})` : ""}: ${er.msg}`); }
    if (report && report.unavailable) items.push(`The display couldn't report on its screens (${report.unavailable}). It may need a firmware update with screen support.`);
    else if (report && report.errors) for (const er of report.errors) items.push(`Display, line ${er.line}: ${er.msg}`);
    const v = parsed ? R.visibility(parsed, Object.assign(ctx(), { stale: parsed.stale })) : null;
    $("#scrVis").textContent = !v ? "" : v.missing.length ? `Hidden in the rotation: waiting for ${v.missing.join(", ")}` : v.show ? "✓ Would show in the rotation" : v.lingerCond ? "Shows for the linger time after this state starts" : "Hidden in the rotation (Show when is false)";
    if (report && !report.unavailable && report.missing && report.missing.length) items.push(`On the display it's waiting for: ${report.missing.join(", ")}`);
    $("#scrErrors").replaceChildren(...items.map(t => el("div", { cls: "err small" }, "⚠ " + t)));
    if ($("#scrFile")) $("#scrFile").textContent = compile(doc()).text;
  }

  /* ================================================================ adding / removing */
  function addElement(kind, x, y) {
    const e = newElement(kind === "value" ? "text" : kind);
    if (x !== undefined) { e.x = x; e.y = y; if (e.type === "line") { e.x2 = Math.min(51, x + 20); e.y2 = y; } }
    edit(() => doc().elements.push(e));
    selId = e.id; renderAll(); setTab("el");
    if (kind === "value") pickEntity({ for: "text", onPick: (name) => edit(() => { e.text = `{${name}}`; }) });
    if (kind === "bar") pickEntity({ for: "bar", onPick: name => edit(() => { e.value = name; }) });
    if (kind === "spark") pickEntity({ for: "spark", onPick: name => edit(() => { e.series = name; }) });
    if (kind === "iconmap") pickEntity({ for: "text", onPick: name => edit(() => { e.value = name; }) });
  }
  function removeElement(e) { edit(() => { doc().elements = doc().elements.filter(x => x !== e); }); selId = null; renderAll(); }

  /* ================================================================ inspector */
  const field = (label, input, hint) => el("label", { cls: "fld" }, el("span", {}, label), input, hint ? el("span", { cls: "muted small" }, hint) : "");
  function num(e, k, opts = {}) {
    const i = el("input", { type: "number", value: e[k] === null || e[k] === undefined ? "" : String(e[k]), placeholder: opts.placeholder || "", step: "1" });
    i.addEventListener("change", () => edit(() => { e[k] = i.value === "" && opts.nullable ? null : +i.value; }));
    return i;
  }
  function txt(obj, k, opts = {}) {
    const i = el("input", { type: "text", value: obj[k] === undefined || obj[k] === null ? "" : String(obj[k]), placeholder: opts.placeholder || "", spellcheck: "false" });
    i.addEventListener(opts.live ? "input" : "change", () => edit(() => { obj[k] = i.value; }, { soft: opts.live }));
    if (opts.live) i.addEventListener("change", () => edit(() => {}));
    return i;
  }
  function choice(obj, k, opts, labels) {
    return el("span", { cls: "segs" }, ...opts.map((o, i) => el("button", { cls: obj[k] === o ? "on" : "", title: labels ? labels[i] : o, onclick: () => { edit(() => { obj[k] = o; }); renderInspector(); } }, labels ? labels[i] : o)));
  }
  function check(obj, k, label) {
    const i = el("input", { type: "checkbox" }); i.checked = !!obj[k];
    i.addEventListener("change", () => edit(() => { obj[k] = i.checked; }));
    return el("label", { cls: "small" }, i, " " + label);
  }
  function valueField(obj, k, forKind, compact) {   // a value name with a picker button
    const i = txt(obj, k, { placeholder: compact ? "value" : "value name, e.g. printer.progress" });
    return el("span", { cls: "row" }, i, el("button", { title: "Pick a Home Assistant entity", onclick: () => pickEntity({ for: forKind, onPick: n => { edit(() => { obj[k] = n; }); renderInspector(); if (!$("#scrPaneScreen").classList.contains("hidden")) renderScreenPane(); } }) }, compact ? "⌕" : "⌕ Entity"));
  }
  function colorInput(obj, k, opts = {}) {   // swatch + hex + the editor's recent colours
    const sw = el("button", { cls: "swatch small", title: "Pick a colour" }), hexIn = el("input", { cls: "hexin", value: obj[k] || "", maxlength: "7", spellcheck: "false", placeholder: opts.placeholder || "#rrggbb" });
    const paint = () => { sw.style.background = obj[k] || "repeating-conic-gradient(#3a3a3a 0 25%, #222 0 50%) 0 0 / 8px 8px"; };
    hexIn.addEventListener("change", () => { const v = hexIn.value.trim().toLowerCase(); if (v === "" && opts.optional) { edit(() => { obj[k] = ""; }); paint(); return; } if (!/^#[0-9a-f]{6}$/.test(v)) { hexIn.value = obj[k] || ""; return toast("Colours look like #ff8800", true); } edit(() => { obj[k] = v; }); paint(); });
    sw.addEventListener("click", ev => { ev.stopPropagation(); colorPopover(sw, obj[k] || "#ffffff", v => { edit(() => { obj[k] = v; }, { soft: true }); hexIn.value = v; paint(); }, () => edit(() => {})); });
    paint();
    return el("span", { cls: "row" }, sw, hexIn);
  }
  let popEl = null;
  function colorPopover(anchor, value, onChange, onDone) {
    if (popEl) popEl.remove();
    const host = el("div", { cls: "cpick" }), pal = el("div", { cls: "palette" });
    let recent = []; try { recent = JSON.parse(localStorage.getItem("p2m.recentColors")) || []; } catch (e) { recent = []; }
    const colors = [...recent, "#ffffff", "#9696af", "#ffcd3c", "#3cdc78", "#ffa046", "#00a0ff", "#ff3c3c", "#28dc50", "#1e1e2a", "#000000"].filter((c, i, a) => a.indexOf(c) === i).slice(0, 18);
    for (const c of colors) pal.append(el("button", { style: `background:${c}`, title: c, onclick: () => { onChange(c); picker.set(unhex(c)); } }));
    popEl = el("div", { cls: "cpop" }, host, pal);
    const picker = Editor.makePicker(host, c => onChange(hex(c)));
    picker.set(unhex(value));
    document.body.append(popEl);
    const r = anchor.getBoundingClientRect();
    popEl.style.left = Math.min(window.innerWidth - 230, r.left) + "px"; popEl.style.top = Math.min(window.innerHeight - 330, r.bottom + 6) + "px";
    popEl.addEventListener("click", ev => ev.stopPropagation());
    setTimeout(() => document.addEventListener("click", function off() { document.removeEventListener("click", off); if (popEl) { popEl.remove(); popEl = null; onDone && onDone(); } }), 0);
  }
  function condBuilder(rows, label) {   // value, operator, literal; AND/OR; empty = always
    const wrap = el("div", { cls: "conds" });
    const render = () => {
      wrap.replaceChildren(...rows.map((r, i) => {
        const join = el("select", {}, el("option", { value: "&&" }, "AND"), el("option", { value: "||" }, "OR")); join.value = r.join || "&&";
        join.addEventListener("change", () => edit(() => { r.join = join.value; }));
        const op = el("select", {}, ...OPS.map(o => el("option", { value: o }, o === "has" ? "has a value" : o === "fresh" ? "is fresh" : o))); op.value = r.op || "==";
        op.addEventListener("change", () => { edit(() => { r.op = op.value; }); render(); });
        const lit = txt(r, "lit", { placeholder: r.op === "in" ? "a,b,c" : "value" });
        if (r.op === "has" || r.op === "fresh") lit.classList.add("hidden");
        return el("div", { cls: "condrow" }, i ? join : el("span", { cls: "muted small" }, "if"), valueField(r, "name", "text", true), op, lit,
          el("button", { title: "Remove", onclick: () => { edit(() => rows.splice(i, 1)); render(); } }, "✕"));
      }), el("button", { cls: "small", onclick: () => { edit(() => rows.push({ join: "&&", name: "", op: "==", lit: "" })); render(); } }, rows.length ? "+ AND / OR" : `+ ${label}`));
    };
    render(); return wrap;
  }
  function colorRules(e) {
    const c = e.color || (e.color = { base: "#ffffff", rules: [] });
    const wrap = el("div", { cls: "conds" });
    const render = () => wrap.replaceChildren(
      el("div", { cls: "row" }, colorInput(c, "base"), el("span", { cls: "muted small" }, c.rules.length ? "otherwise" : "")),
      ...c.rules.map((r, i) => {
        const op = el("select", {}, ...OPS.filter(o => o !== "fresh").map(o => el("option", { value: o }, o === "has" ? "has a value" : o))); op.value = r.op || "==";
        op.addEventListener("change", () => edit(() => { r.op = op.value; }));
        return el("div", { cls: "condrow" }, el("span", { cls: "muted small" }, "when"), valueField(r, "name", "num", true), op, txt(r, "lit", { placeholder: "0" }), colorInput(r, "color"),
          el("button", { title: "Remove", onclick: () => { edit(() => c.rules.splice(i, 1)); render(); } }, "✕"));
      }),
      el("button", { cls: "small", title: "The first rule that's true picks the colour; otherwise the colour above", onclick: () => { edit(() => c.rules.push({ name: "", op: ">", lit: "0", color: "#28dc50" })); render(); } }, "+ Add colour rule"));
    render(); return wrap;
  }
  function fontPicker(e) {   // each font drawn in its own pixels
    return el("div", { cls: "fontpick" }, ...["tiny", "small", "big", "huge"].map(f => {
      const sample = "Ag42", w = R.textWidth(f === "tiny" ? "AG42" : sample, f), h = R.FONTS[f].gh, c = el("canvas", { width: w, height: h });
      const fb = R.render({ bg: [0, 0, 0], elements: [{ type: "text", x: 0, y: 0, tpl: [f === "tiny" ? "AG42" : sample], font: f, align: "left", valign: "top", overflow: "clip", spacing: 0 }], stale: 21600 }, { values: {} });
      const img = c.getContext("2d").createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * 52 + x) * 3, d = (y * w + x) * 4; img.data[d] = fb[s]; img.data[d + 1] = fb[s + 1]; img.data[d + 2] = fb[s + 2]; img.data[d + 3] = 255; }
      c.getContext("2d").putImageData(img, 0, 0);
      c.style.height = Math.min(42, h * 2) + "px";
      return el("button", { cls: e.font === f ? "on" : "", title: FONT_LABEL[f], onclick: () => { edit(() => { e.font = f; }); renderInspector(); } }, c, el("span", { cls: "small" }, FONT_LABEL[f]));
    }));
  }
  const CHIPS = [["int", "Integer"], ["dec:1", "Decimals"], ["thousands", "Thousands"], ["pct", "%"], ["dur:min", "Duration"], ["temp", "Temperature"], ["time", "Time"], ["ago", "Ago"], ["upper", "Upper"], ["or:-", "Fallback"]];
  function templateEditor(e) {
    const ta = el("textarea", { rows: "2", spellcheck: "false" }); ta.value = e.text || "";
    const out = el("div", { cls: "tplout" });
    const show = () => { try { out.textContent = "→ " + R.format(R.parseTemplate(ta.value), ctx()); out.classList.remove("err"); } catch (er) { out.textContent = "⚠ " + er.message; out.classList.add("err"); } };
    ta.addEventListener("input", () => { edit(() => { e.text = ta.value; }, { soft: true }); show(); });
    ta.addEventListener("change", () => edit(() => {}));
    const insert = s => { const a = ta.selectionStart, b = ta.selectionEnd; ta.value = ta.value.slice(0, a) + s + ta.value.slice(b); ta.selectionStart = ta.selectionEnd = a + s.length; ta.focus(); edit(() => { e.text = ta.value; }); show(); };
    const addFmt = f => {   // add |fmt to the value the cursor is in (or the last one)
      const pos = ta.selectionStart, s = ta.value;
      let open = s.lastIndexOf("{", pos - 1), close = s.indexOf("}", open);
      if (open < 0 || close < 0 || close < pos - 1) { open = s.lastIndexOf("{"); close = s.indexOf("}", open); }
      if (open < 0 || close < 0) return toast("Insert a value first", true);
      ta.value = s.slice(0, close) + "|" + f + s.slice(close); edit(() => { e.text = ta.value; }); show();
    };
    show();
    return el("div", {}, ta, el("div", { cls: "row wrap" },
      el("button", { onclick: () => pickEntity({ for: "text", onPick: n => insert(`{${n}}`) }) }, "+ Insert value"),
      ...CHIPS.map(([f, label]) => el("button", { cls: "chipbtn", title: `|${f}`, onclick: () => addFmt(f) }, label))), out);
  }
  function renderInspector() {
    const pane = $("#scrPaneEl"), e = sel();
    if (!st) return;
    if (!e) return pane.replaceChildren(el("p", { cls: "muted" }, "Select an element on the canvas, or add one from the left."));
    const kids = [el("h3", {}, { text: "Text", icon: e.byValue ? "Icon by value" : "Icon", bar: "Progress bar", spark: "Sparkline", rect: "Rectangle", line: "Line", pixel: "Pixel" }[e.type])];
    const pos = el("div", { cls: "row wrap" }, field("X", num(e, "x")), field("Y", num(e, "y")));
    if (e.type === "line") pos.append(field("X2", num(e, "x2")), field("Y2", num(e, "y2")));
    if (["bar", "spark", "rect"].includes(e.type)) pos.append(field("W", num(e, "w")), field("H", num(e, "h")));
    if (e.type === "text") pos.append(field("W", num(e, "w", { nullable: true, placeholder: "auto" })), field("H", num(e, "h", { nullable: true, placeholder: "auto" })));
    kids.push(pos);
    if (e.type === "text") {
      kids.push(field("Font", fontPicker(e)),
        field("Text", templateEditor(e)),
        el("div", { cls: "row wrap" }, field("Align", choice(e, "align", ["left", "center", "right"], ["⇤", "↔", "⇥"])), field("Vertical", choice(e, "valign", ["top", "middle", "bottom"], ["⤒", "↕", "⤓"]))),
        el("div", { cls: "row wrap" }, field("Overflow", choice(e, "overflow", ["clip", "scroll", "shrink"], ["Clip", "Scroll", "Shrink to fit"])),
          e.overflow === "scroll" ? field("Speed", num(e, "speed"), "px/s") : "", field("Spacing", num(e, "spacing"))));
      if (e.w === null && (e.align !== "left" || e.overflow !== "clip")) kids.push(el("p", { cls: "hint" }, "Alignment and overflow act within the box: set W (and H) for them to matter."));
    }
    if (e.type === "icon") {
      const names = ["@degree", "@up", "@down", "@moon", "@coin:BTC", ...lib.icons.map(f => stem(f.name))];
      const iconSel = (obj, k) => { const s = el("select", {}, el("option", { value: "" }, "(choose)"), ...names.map(n => el("option", { value: n }, n))); s.value = obj[k] || ""; s.addEventListener("change", () => { edit(() => { obj[k] = s.value; }); loadIcons(); }); return s; };
      if (e.byValue) {
        kids.push(field("Value", valueField(e, "value", "text")), el("div", { cls: "tp-label" }, "Icon for each value (* = anything else)"));
        e.map.forEach((m, i) => kids.push(el("div", { cls: "condrow" }, txt(m, "k", { placeholder: "sunny" }), el("span", {}, "→"), iconSel(m, "icon"), el("button", { onclick: () => { edit(() => e.map.splice(i, 1)); renderInspector(); } }, "✕"))));
        kids.push(el("button", { cls: "small", onclick: () => { edit(() => e.map.splice(e.map.length - 1, 0, { k: "", icon: "" })); renderInspector(); } }, "+ Add"));
      } else {
        kids.push(field("Icon", iconSel(e, "icon"), lib.icons.length ? "" : "Adopt a display to use its icon library; @ icons are drawn built-ins."),
          field("Frame from value", valueField(e, "frame", "bar"), "optional: picks the frame instead of playing it (a progress icon)"),
          e.frame ? field("Range", txt(e, "range", { placeholder: "0,100" })) : "");
      }
    }
    if (e.type === "bar") {
      kids.push(field("Value", valueField(e, "value", "bar")), el("div", { cls: "row wrap" }, field("Min", num(e, "min")), field("Max", num(e, "max"))),
        el("div", { cls: "row wrap" }, field("Fill", colorInput(e, "fill")), field("Fill end (gradient)", colorInput(e, "fill2", { optional: true, placeholder: "none" }))),
        field("Empty part", colorInput(e, "bg", { optional: true, placeholder: "none" })),
        field("Direction", choice(e, "dir", ["right", "left", "up", "down"], ["→", "←", "↑", "↓"])), check(e, "pulse", "Blink the leading edge"));
    }
    if (e.type === "spark") kids.push(field("Series", valueField(e, "series", "spark"), "a list value, e.g. a History binding"), check(e, "area", "Shade under the line"), check(e, "dot", "Blink the newest point"));
    if (e.type === "rect") kids.push(check(e, "fill", "Filled"));
    if (e.type !== "bar") kids.push(el("div", { cls: "tp-label" }, "Colour"), colorRules(e));
    else kids.push(el("div", { cls: "tp-label" }, "Colour (when no fill is set)"), colorRules(e));
    kids.push(el("div", { cls: "tp-label" }, "Show when"), condBuilder(e.show || (e.show = []), "Show only when…"));
    const errs = errorsFor(e);
    if (errs.length) kids.push(el("div", { cls: "scr-errors" }, ...errs.map(t => el("div", { cls: "err small" }, "⚠ " + t))));
    kids.push(el("div", { cls: "row" }, el("button", { onclick: () => { const c = JSON.parse(JSON.stringify(e)); c.id = uid(); c.x += 2; c.y += 2; if (c.type === "line") { c.x2 += 2; c.y2 += 2; } edit(() => doc().elements.push(c)); selId = c.id; renderAll(); } }, "Duplicate"),
      el("button", { cls: "danger", onclick: () => removeElement(e) }, "Delete")));
    pane.replaceChildren(...kids);
  }

  /* ================================================================ screen settings */
  function renderScreenPane() {
    const s = doc().settings, pane = $("#scrPaneScreen");
    const needs = el("input", { type: "text", value: (s.needs || []).join(" "), placeholder: "printer.status printer.progress", spellcheck: "false" });
    needs.addEventListener("change", () => edit(() => { s.needs = needs.value.split(/[\s,]+/).filter(Boolean); }));
    const durSel = (k, def) => { const i = el("input", { type: "text", value: s[k] || "", placeholder: def, spellcheck: "false", size: "6" }); i.addEventListener("change", () => { const v = i.value.trim(); if (v && !/^\d+[smhd]$/.test(v)) { i.value = s[k] || ""; return toast("Durations look like 90s, 30m, 2h or 1d", true); } edit(() => { s[k] = v; }); }); return i; };
    pane.replaceChildren(el("h3", {}, "Screen"),
      field("Name", txt(s, "name", { placeholder: st.name }), "shown in Home Assistant's Screen select and in playlists"),
      field("Needs", needs, "hide the screen until all of these values exist and are fresh"),
      el("div", { cls: "tp-label" }, "Show when"), condBuilder(s.show, "Show only when…"),
      el("div", { cls: "tp-label" }, "Keep showing after"), condBuilder(s.linger, "Keep showing after… (e.g. a print finishes)"),
      s.linger.length ? field("for", durSel("lingerFor", "30m")) : "",
      el("div", { cls: "row wrap" }, field("Stale after", durSel("stale", "6h")), field("Time on screen (s)", num(s, "time", { nullable: true, placeholder: "default" })), field("Order", num(s, "order", { nullable: true, placeholder: "100" }))),
      field("Background", colorInput(s, "bg")));
  }

  /* ================================================================ values panel */
  function suggestName(ent) {   // sensor.p1s_..._print_progress -> printer.progress-ish; always a valid value name
    const slug = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const dev = reg && ent.device && reg.devices.find(d => d.id === ent.device);
    let group = slug(dev ? dev.name : ent.area || ent.id.split(".")[0]).split("_")[0] || "value";
    let rest = ent.name || ent.id;
    if (dev && dev.name && rest.toLowerCase().startsWith(dev.name.toLowerCase())) rest = rest.slice(dev.name.length);
    let key = slug(rest).split("_").filter(Boolean).slice(-2).join("_") || slug(ent.id.split(".")[1]);
    let n = `${group}.${key}`.slice(0, 31).replace(/[._-]+$/, "");
    const taken = new Set(Object.keys(doc().bindings)); let i = 2, base = n;
    while (taken.has(n) && doc().bindings[n].entity !== ent.id) n = `${base.slice(0, 28)}_${i++}`;
    return n;
  }
  function renderValuesPane() {
    const pane = $("#scrPaneValues"), d = doc(), names = usedNames(d), all = [...new Set([...names, ...Object.keys(d.bindings), ...Object.keys(d.samples)])].sort();
    const head = [el("h3", {}, "Values"),
      el("p", { cls: "hint" }, ha.available ? (ha.connected ? `Connected to Home Assistant${ha.version ? " " + ha.version : ""}. Bound values follow their entities once the screen is sent.` : `Home Assistant: not connected${ha.error ? " (" + ha.error + ")" : ""}.`)
        : "No Home Assistant access (add-on: automatic; Docker: set HA_URL and HA_TOKEN_FILE). Values are just names: publish them yourself, e.g. with the automation below."),
      el("div", { cls: "row" }, el("button", { onclick: () => pickEntity({ for: "text", onPick: () => renderValuesPane() }) }, "+ Bind an entity"),
        el("span", { cls: "muted small" }, mode === "live" ? (liveErr ? "Live: " + liveErr : "Preview: live values (unbound names use samples)") : "Preview: sample values"))];
    const rows = all.map(n => {
      const b = d.bindings[n], used = names.includes(n), v = mode === "live" && n in live ? live[n] : sampleValue(d.samples[n]);
      const sample = el("input", { type: "text", value: d.samples[n] === undefined ? "" : String(d.samples[n]), placeholder: "sample", spellcheck: "false", title: "Sample value: 42, 48.2 °F, running, 1,2,3 (a list), or null" });
      sample.addEventListener("change", () => { edit(() => { if (sample.value === "") delete d.samples[n]; else d.samples[n] = sample.value; }); renderValuesPane(); });
      const what = b ? `${b.entity}${b.kind === "attr" ? " · " + b.attr : b.kind === "history" ? ` · history ${b.hours} h / ${b.points} pts` : ""}` : "not bound";
      const shown = v === undefined ? "–" : Array.isArray(v) && v.length === 2 && typeof v[1] === "string" ? `${v[0]} ${v[1]}` : Array.isArray(v) ? `[${v.length} points]` : String(v);
      return el("div", { cls: "valrow" + (used ? "" : " unused") },
        el("div", { cls: "vtop" }, el("button", { cls: "vname", title: "Rename (updates every element that uses it)", onclick: () => renameValue(n) }, n),
          used ? "" : el("span", { cls: "muted small" }, "unused"), el("span", { cls: "vlive", title: "Current preview value" }, shown)),
        el("div", { cls: "muted small vwhat", title: what }, what),
        el("div", { cls: "row" }, sample,
          el("button", { title: b ? "Bind to a different entity" : "Bind to an entity", onclick: () => pickEntity({ for: "text", name: n, onPick: () => renderValuesPane() }) }, b ? "⇄ Rebind" : "⌕ Bind"),
          b ? el("button", { title: "Unbind", onclick: () => { edit(() => { delete d.bindings[n]; }); renderValuesPane(); } }, "✕") : ""));
    });
    const auto = !ha.available && names.length ? el("details", {}, el("summary", {}, "Example automation (publish the values yourself)"),
      el("pre", { cls: "scr-file" }, exampleAutomation(names))) : "";
    pane.replaceChildren(...head, el("div", { cls: "valrows" }, ...(rows.length ? rows : [el("p", { cls: "muted small" }, "No values yet. Insert one in a text, or bind an entity.")])), auto);
  }
  function exampleAutomation(names) {
    const d = display(), topic = d ? d.topic : "pixel2mqtt/display";
    return `automation:\n  - alias: Send screen values to the pixel display\n    triggers:\n${names.map(n => `      - trigger: state\n        entity_id: sensor.REPLACE_ME   # -> ${n}`).join("\n")}\n` +
      `    actions:\n      - action: mqtt.publish\n        data:\n          topic: ${topic}/values/set\n          payload: >-\n            {${names.map(n => `"${n}": {{ states('sensor.REPLACE_ME') | tojson }}`).join(", ")}}\n`;
  }
  async function renameValue(n) {
    const v = await askText("Value name (a-z, 0-9, _ . -; up to 31 characters)", n, { ok: "Rename" }); if (!v) return;
    const m = v.trim().toLowerCase(); if (m === n) return;
    if (!R.NAME_RE.test(m)) return toast("Use a-z, 0-9, _ . - (up to 31 characters)", true);
    const re = new RegExp(`(\\{)${n.replace(/[.]/g, "\\.")}(?=[|}])`, "g");
    edit(() => {
      const d = doc();
      if (d.bindings[n]) { d.bindings[m] = d.bindings[n]; delete d.bindings[n]; }
      if (n in d.samples) { d.samples[m] = d.samples[n]; delete d.samples[n]; }
      const fixRows = rows => (rows || []).forEach(r => { if (r.name === n) r.name = m; if (r.name === n + ".trend") r.name = m + ".trend"; });
      for (const e of d.elements) {
        if (e.text) e.text = e.text.replace(re, "$1" + m);
        ["value", "series", "frame"].forEach(k => { if (e[k] === n) e[k] = m; });
        fixRows(e.show); fixRows(e.color && e.color.rules);
      }
      fixRows(d.settings.show); fixRows(d.settings.linger); d.settings.needs = (d.settings.needs || []).map(x => x === n ? m : x);
    });
    renderAll();
  }

  /* ================================================================ entity picker */
  async function loadRegistry(force) {
    if (!ha.available || !ha.connected) return null;
    if (reg && !force && Date.now() - regAt < 60000) return reg;
    reg = await api("/ha/registry"); regAt = Date.now();
    return reg;
  }
  const kindOf = e => {
    const dom = e.id.split(".")[0], n = e.state !== null && e.state !== "" && !isNaN(+e.state);
    return { num: n || !!e.unit, text: !n, onoff: ["on", "off"].includes(String(e.state)) || ["switch", "binary_sensor", "light", "input_boolean", "fan"].includes(dom), weather: dom === "weather", hist: !!e.sc || (n && !!e.unit) };
  };
  function recentEntities() { try { return JSON.parse(localStorage.getItem("p2m.recentEntities")) || []; } catch (e) { return []; } }
  function rememberEntity(id) { try { localStorage.setItem("p2m.recentEntities", JSON.stringify([id, ...recentEntities().filter(x => x !== id)].slice(0, 12))); } catch (e) { /* private mode */ } }
  // opts: {for: "text"|"bar"|"spark"|"num", name?: fixed value name, onPick(name, spec)}
  async function pickEntity(opts) {
    if (!ha.available) {
      const n = await askText("No Home Assistant access, so values are names you publish yourself. Value name:", opts.name || "my.value", { ok: "Use" });
      if (!n) return;
      const m = n.trim().toLowerCase(); if (!R.NAME_RE.test(m)) return toast("Use a-z, 0-9, _ . - (up to 31 characters)", true);
      opts.onPick(m); renderValuesPane(); return;
    }
    let r;
    try { r = await loadRegistry(); } catch (e) { return toast("Home Assistant: " + e.message, true); }
    if (!r) return toast("Home Assistant isn't connected" + (ha.error ? ": " + ha.error : ""), true);
    const chips = new Set(opts.for === "bar" ? ["num"] : opts.for === "spark" ? ["hist"] : []);
    const dlg = el("dialog", { cls: "picker" }), search = el("input", { type: "search", placeholder: "Search: name, entity id, device, area or integration (words in any order)", spellcheck: "false" });
    const list = el("div", { cls: "pk-list" }), chipRow = el("div", { cls: "row wrap" }), quick = el("div", { cls: "row wrap pk-quick" }), body = el("div", { cls: "pk-body" });
    let tab = "search", byIntegration = false, path = [];
    const devName = id => { const d = r.devices.find(x => x.id === id); return d ? d.name : ""; };
    const areaName = id => { const a = r.areas.find(x => x.id === id); return a ? a.name : ""; };
    const stateLine = e => `${e.state}${e.unit ? " " + e.unit : ""}`;
    const done = (spec, name) => { dlg.close(); rememberEntity(spec.entity); edit(() => { doc().bindings[name] = spec; }); opts.onPick(name, spec); renderValuesPane(); refreshLive(); };
    function choose(e) {   // State / attribute / History
      const name = el("input", { type: "text", value: opts.name || suggestName(e), spellcheck: "false" });
      const hours = el("input", { type: "number", value: "24", min: "1" }), pts = el("input", { type: "number", value: "32", min: "2", max: "64" });
      const k = kindOf(e);
      const nm = () => { const v = name.value.trim().toLowerCase(); if (!R.NAME_RE.test(v)) { toast("Value names use a-z, 0-9, _ . - (up to 31 characters)", true); return null; } return v; };
      body.replaceChildren(el("div", { cls: "pk-choose" },
        el("button", { cls: "link", onclick: () => renderBody() }, "◂ back"),
        el("h3", {}, e.name), el("div", { cls: "muted small" }, `${e.id} · ${[devName(e.device), areaName(e.area), e.integration].filter(Boolean).join(" · ")}`),
        field("Value name", name, "what the screen calls it; rename it any time"),
        el("div", { cls: "row wrap" }, el("button", { cls: "primary", onclick: () => { const n = nm(); if (n) done({ entity: e.id, kind: "state" }, n); } }, `State (${stateLine(e)})`)),
        e.attrs.length ? el("div", { cls: "tp-label" }, "Or an attribute") : "",
        el("div", { cls: "row wrap" }, ...e.attrs.map(a => el("button", { onclick: () => { const n = nm(); if (n) done({ entity: e.id, kind: "attr", attr: a }, n); } }, a))),
        k.num ? el("div", { cls: "tp-label" }, "Or its history (for sparklines)") : "",
        k.num ? el("div", { cls: "row wrap" }, field("last hours", hours), field("points", pts), el("button", { onclick: () => { const n = nm(); if (n) done({ entity: e.id, kind: "history", hours: +hours.value || 24, points: Math.max(2, Math.min(64, +pts.value || 32)) }, n); } }, "Use history")) : ""));
      name.focus(); name.select();
    }
    const entRow = e => el("button", { cls: "pk-ent", onclick: () => choose(e) }, el("span", {}, e.name), el("span", { cls: "muted small" }, e.id), el("span", { cls: "pk-state" }, stateLine(e)));
    function renderSearch() {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      let ents = r.entities.filter(e => [...chips].every(c => kindOf(e)[c]));
      if (words.length) ents = ents.filter(e => { const hay = `${e.name} ${e.id} ${devName(e.device)} ${areaName(e.area)} ${e.integration}`.toLowerCase(); return words.every(w => hay.includes(w)); });
      const groups = new Map();
      for (const e of ents.slice(0, 300)) { const k = devName(e.device) || "(no device)"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
      list.replaceChildren(...(groups.size ? [...groups].map(([g, es]) => el("div", { cls: "pk-group" }, el("div", { cls: "pk-gh" }, g), ...es.map(entRow))) : [el("p", { cls: "muted" }, "No matching entities.")]),
        ents.length > 300 ? el("p", { cls: "muted small" }, `Showing 300 of ${ents.length}: type more to narrow it down.`) : "");
    }
    function renderBrowse() {   // Area -> Device -> Entity -> Attribute (or Integration -> Device -> ...)
      const cols = [];
      const col = (title, items, level) => el("div", { cls: "pk-col" }, el("div", { cls: "pk-gh" }, title), ...items.map(([key, label, extra]) =>
        el("button", { cls: path[level] === key ? "on" : "", onclick: () => { path = path.slice(0, level).concat(key); renderBrowse(); } }, label, extra ? el("span", { cls: "muted small" }, " " + extra) : "")));
      const ents = r.entities;
      const top = byIntegration ? [...new Set(ents.map(e => e.integration))].sort().map(i => [i, i]) : [...r.areas.map(a => [a.id, a.name]), ["__none", "(no area)"]];
      cols.push(col(byIntegration ? "Integration" : "Area", top, 0));
      const inTop = e => byIntegration ? e.integration === path[0] : path[0] === "__none" ? !e.area : e.area === path[0];
      if (path[0] !== undefined) {
        const devIds = [...new Set(ents.filter(inTop).map(e => e.device || "__nodev"))];
        cols.push(col("Device", devIds.map(id => [id, id === "__nodev" ? "(no device)" : devName(id) || id]), 1));
      }
      if (path[1] !== undefined) cols.push(col("Entity", ents.filter(e => inTop(e) && (e.device || "__nodev") === path[1]).map(e => [e.id, e.name, stateLine(e)]), 2));
      if (path[2] !== undefined) { const e = ents.find(x => x.id === path[2]); if (e) cols.push(el("div", { cls: "pk-col" }, el("div", { cls: "pk-gh" }, "Use"), el("button", { cls: "primary", onclick: () => choose(e) }, "Choose…"))); }
      const back = path.length ? el("button", { cls: "pk-back", onclick: () => { path = path.slice(0, -1); renderBrowse(); } }, "◂ Back") : "";
      list.replaceChildren(back, el("div", { cls: "pk-cols", "data-depth": String(cols.length) }, ...cols));
    }
    function renderBody() {
      chipRow.replaceChildren(...KIND_CHIPS.map(([k, label]) => el("button", { cls: "chipbtn" + (chips.has(k) ? " on" : ""), onclick: () => { chips.has(k) ? chips.delete(k) : chips.add(k); renderBody(); } }, label)));
      const recent = recentEntities().map(id => r.entities.find(e => e.id === id)).filter(Boolean);
      const used = Object.values(doc().bindings).map(b => r.entities.find(e => e.id === b.entity)).filter(Boolean);
      quick.replaceChildren(...(recent.length || used.length || usedOnDisplay.length ? [el("span", { cls: "muted small" }, "Recent / used:"),
        ...[...new Set([...used, ...usedOnDisplay.map(id => r.entities.find(e => e.id === id)).filter(Boolean), ...recent])].slice(0, 10).map(e => el("button", { cls: "chipbtn", title: e.id, onclick: () => choose(e) }, e.name))] : []));
      body.replaceChildren(el("div", { cls: "row" }, el("span", { cls: "segs" },
        el("button", { cls: tab === "search" ? "on" : "", onclick: () => { tab = "search"; renderBody(); } }, "Search"),
        el("button", { cls: tab === "browse" ? "on" : "", onclick: () => { tab = "browse"; renderBody(); } }, "Browse")),
        tab === "browse" ? el("label", { cls: "small" }, (() => { const c = el("input", { type: "checkbox" }); c.checked = byIntegration; c.addEventListener("change", () => { byIntegration = c.checked; path = []; renderBrowse(); }); return c; })(), " by integration") : ""),
        tab === "search" ? search : "", tab === "search" ? chipRow : "", quick, list);
      if (tab === "search") { renderSearch(); search.focus(); } else renderBrowse();
    }
    let usedOnDisplay = [];
    if (cur) api(`/displays/${cur}/bindings`).then(b => { usedOnDisplay = [...new Set(Object.values(b.screens || {}).flatMap(s => Object.values(s).map(x => x.entity)))]; if (tab === "search") renderBody(); }).catch(() => {});
    search.addEventListener("input", renderSearch);
    dlg.append(el("div", { cls: "pk-head" }, el("strong", {}, "Pick a Home Assistant entity"), el("span", { cls: "grow" }), el("button", { onclick: () => dlg.close() }, "✕")), body);
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg); dlg.showModal(); renderBody();
  }

  /* ================================================================ Home Assistant / live preview / live on display */
  async function refreshHA() { try { ha = await api("/ha/status"); } catch (e) { ha = { available: false }; } if (st) renderValuesPane(); }
  async function refreshLive() {
    if (!st || mode !== "live") return;
    const b = doc().bindings;
    if (!Object.keys(b).length) { live = {}; liveErr = ""; dirty = true; return; }
    try { live = await postJSON("/ha/values", { bindings: b }); liveErr = ""; } catch (e) { liveErr = e.message; }
    dirty = true; if (!$("#scrPaneValues").classList.contains("hidden")) renderValuesPane();
  }
  setInterval(refreshLive, 2000);
  setInterval(() => { if (st) refreshHA(); }, 30000);
  $("#scrMode").addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    mode = b.dataset.m; $("#scrMode").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    if (mode === "live" && !ha.available) toast("No Home Assistant access: Live shows the sample values", true);
    refreshLive(); renderValuesPane(); dirty = true;
  });
  let liveBusy = false;
  setInterval(async () => {   // Live on display: stream the preview (~10 fps; the panel resumes 3 s after the last frame)
    if (!st || !$("#scrLive").checked || !cur || liveBusy || !st.lastFrame) return;
    liveBusy = true;
    try { await postRaw(`/displays/${cur}/frame`, st.lastFrame); } catch (e) { $("#scrLive").checked = false; toast("Live on display stopped: " + e.message, true); }
    liveBusy = false;
  }, 100);

  /* ================================================================ tabs / render all */
  function setTab(t) {
    $("#scrTabs").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.t === t));
    for (const [k, id] of [["el", "#scrPaneEl"], ["values", "#scrPaneValues"], ["screen", "#scrPaneScreen"], ["file", "#scrPaneFile"]]) $(id).classList.toggle("hidden", k !== t);
    if (t === "values") renderValuesPane(); if (t === "screen") renderScreenPane(); if (t === "el") renderInspector(); if (t === "file") renderErrors();
  }
  $("#scrTabs").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) setTab(b.dataset.t); });
  function renderAll() { renderLayers(); renderInspector(); renderScreenPane(); renderValuesPane(); renderErrors(); }

  /* ================================================================ projects */
  async function create(name, fromText, samples) {
    const d = fromText ? fromScr(fromText, name) : newDoc(name);
    if (samples) for (const [k, v] of Object.entries(samples)) d.samples[k] = typeof v === "string" ? v : JSON.stringify(v);
    d.settings.name = d.settings.name || name;
    open(name, { meta: { type: "screen", rev: 0, sent: null }, screen: d }, { edited: true });
  }
  return { open, close, isOpen, save, create, compile: d => compile(d).text, fromScr, usedNames };
})();
