"use strict";
// pixel2mqtt web editor. No build step, no external libraries.
const $ = s => document.querySelector(s);
const PW = 52, PH = 32, FRAME = PW * PH * 3;

/* ------------------------------------------------------------------ helpers */
async function api(path, opts = {}) {
  const r = await fetch("/api" + path, opts);
  if (!r.ok) {
    let m = r.status + " " + r.statusText;
    try { m = (await r.json()).error || m; } catch (e) { /* not json */ }
    throw new Error(m);
  }
  const ct = r.headers.get("content-type") || "";
  if (r.status === 204) return null;
  return ct.includes("json") ? r.json() : r.arrayBuffer();
}
const postJSON = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const postRaw = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
const enc = encodeURIComponent;
let toastTimer;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg; t.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ""), err ? 6000 : 2500);
}
const fmtBytes = n => n >= 1 << 20 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B";
const hex = c => "#" + c.slice(0, 3).map(v => v.toString(16).padStart(2, "0")).join("");
const unhex = h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));
const stem = n => n.replace(/\.[^.]+$/, "");
const soundLabel = n => { let s = stem(n); const m = s.match(/^\d+-(.+)$/); if (m) s = m[1]; return s.replace(/_/g, " "); };
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (k === "cls") e.className = v; else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

/* ------------------------------------------------------------------ formats */
function parsePXA(buf) {
  const d = new DataView(buf), u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.slice(0, 4)) !== "PXA1") throw new Error("not PXA1");
  const n = d.getUint16(4, true), frames = []; let o = 6;
  for (let i = 0; i < n; i++) { frames.push({ delay: Math.max(20, d.getUint16(o, true)), rgb: u8.subarray(o + 2, o + 2 + FRAME) }); o += 2 + FRAME; }
  return { frames, total: frames.reduce((a, f) => a + f.delay, 0) };
}
function parsePXI(buf) {
  const d = new DataView(buf), u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.slice(0, 4)) !== "PXI1") throw new Error("not PXI1");
  const w = u8[4], h = u8[5], n = d.getUint16(6, true), frames = []; let o = 8;
  for (let i = 0; i < n; i++) { frames.push({ delay: Math.max(20, d.getUint16(o, true)), rgba: u8.subarray(o + 2, o + 2 + w * h * 4) }); o += 2 + w * h * 4; }
  return { w, h, frames, total: frames.reduce((a, f) => a + f.delay, 0) };
}
function frameAt(a, ms) {
  if (a.frames.length === 1 || !a.total) return a.frames[0];
  let t = ((ms % a.total) + a.total) % a.total;
  for (const f of a.frames) { if (t < f.delay) return f; t -= f.delay; }
  return a.frames[0];
}
function buildPXA(frames) {  // frames: [{delay, rgb Uint8Array(4992)}]
  const out = new Uint8Array(6 + frames.length * (2 + FRAME)), d = new DataView(out.buffer);
  out.set([80, 88, 65, 49]); d.setUint16(4, frames.length, true);
  let o = 6;
  for (const f of frames) { d.setUint16(o, Math.min(10000, Math.max(20, Math.round(f.delay))), true); out.set(f.rgb, o + 2); o += 2 + FRAME; }
  return out;
}
function buildPXI(w, h, rgba) {
  const out = new Uint8Array(8 + 2 + w * h * 4), d = new DataView(out.buffer);
  out.set([80, 88, 73, 49]); out[4] = w; out[5] = h; d.setUint16(6, 1, true); d.setUint16(8, 1000, true); out.set(rgba, 10);
  return out;
}

/* ------------------------------------------------------------------ app state */
let status = null, cur = null;
const lib = { anims: [], icons: [], sounds: [] };
const iconCache = new Map();  // "name" -> parsed PXI (current display)

function display() { return status && status.displays.find(d => d.id === cur); }
async function getIcon(name) {
  const f = lib.icons.find(i => stem(i.name) === name);
  const key = cur + "/" + name + "/" + (f ? f.size : "");
  if (iconCache.has(key)) return iconCache.get(key);
  const p = api(`/displays/${cur}/files/icons/${enc(name + ".pxi")}?size=${f ? f.size : 0}`).then(parsePXI);
  iconCache.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ status / header */
async function refreshStatus() {
  try { status = await api("/status"); } catch (e) { $("#chipMqtt").textContent = "server offline"; $("#chipMqtt").className = "chip bad"; return; }
  const sel = $("#displaySel"), prev = cur;
  if (!status.displays.find(d => d.id === cur)) cur = status.displays.length ? status.displays[0].id : null;
  sel.replaceChildren(...(status.displays.length ? status.displays.map(d => el("option", { value: d.id }, d.name)) : [el("option", { value: "" }, "no display adopted")]));
  sel.value = cur || "";
  const d = display();
  const cd = $("#chipDisplay");
  cd.textContent = d ? (d.online ? "online" : "offline") + " · " + d.host : "no display";
  cd.className = "chip " + (d ? (d.online ? "ok" : "bad") : "");
  cd.title = d && d.error ? d.error : "";
  const cm = $("#chipMqtt");
  cm.textContent = status.mqtt.connected ? "MQTT connected" : "MQTT: " + (status.mqtt.error || "connecting");
  cm.className = "chip " + (status.mqtt.connected ? "ok" : "bad");
  renderStorage(d && d.storage);
  renderDisplays();
  if (cur !== prev) loadLibrary();
}
function renderStorage(s) {
  const box = $("#storage"); box.replaceChildren();
  if (!s) return;
  for (const [k, label] of [["udisk", "media"], ["data", "system"]]) {
    const v = s[k]; if (!v || !v.total) continue;
    const used = 1 - v.free / v.total;
    box.append(el("span", { title: `${v.path}: ${fmtBytes(v.free)} free of ${fmtBytes(v.total)}` }, `${label} ${fmtBytes(v.free)} free`,
      el("span", { cls: "meter" }, Object.assign(el("i"), { style: `width:${Math.round(used * 100)}%` }))));
  }
}
async function refreshStorage() {
  if (!cur) return;
  try { const s = await api(`/displays/${cur}/storage`); const d = display(); if (d) d.storage = s; renderStorage(s); } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ library */
async function loadLibrary() {
  if (!cur) { lib.anims = lib.icons = lib.sounds = []; renderLibrary(); return; }
  try {
    const [a, i, s] = await Promise.all(["anims", "icons", "sounds"].map(k => api(`/displays/${cur}/files/${k}`)));
    const by = (x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" });
    lib.anims = a.filter(f => f.name.endsWith(".anim")).sort(by);
    lib.icons = i.sort(by);
    const seen = new Set();
    lib.sounds = s.filter(f => { const l = soundLabel(f.name).toLowerCase(); if (seen.has(l)) return false; seen.add(l); return true; })
      .sort((x, y) => soundLabel(x.name).localeCompare(soundLabel(y.name)));
  } catch (e) { toast("Library: " + e.message, true); }
  renderLibrary();
}
function renderLibrary() {
  const opts = (list, fn) => list.length ? list.map(fn) : [el("option", { value: "" }, "(none)")];
  $("#animSel").replaceChildren(...opts(lib.anims, f => el("option", { value: stem(f.name) }, stem(f.name))));
  $("#iconSel").replaceChildren(...opts(lib.icons, f => el("option", { value: stem(f.name) }, stem(f.name))));
  $("#soundSel").replaceChildren(...opts(lib.sounds, f => el("option", { value: stem(f.name) }, soundLabel(f.name))));
  const st = display() && display().state;
  if (st && st.animation) $("#animSel").value = st.animation;
  $("#animCount").textContent = lib.anims.length; $("#iconCount").textContent = lib.icons.length; $("#soundCount").textContent = lib.sounds.length;

  $("#animList").replaceChildren(...lib.anims.map(f => el("div", { cls: "item" },
    el("span", { cls: "n", title: "Preview", onclick: () => previewAnim(f) }, stem(f.name)),
    el("span", { cls: "s" }, fmtBytes(f.size)),
    el("button", { title: "Play on the display", onclick: () => cmd("animation", stem(f.name)) }, "▶"),
    el("button", { title: "Delete from the display", onclick: () => delFile("anims", f.name) }, "✕"))));
  const grid = $("#iconGrid"); grid.replaceChildren();
  for (const f of lib.icons) {
    const c = el("canvas", { width: 1, height: 1 });
    const name = stem(f.name);
    grid.append(el("div", { cls: "ic", title: `${name} - click to place on the canvas`, onclick: () => { addObject(name); showTab("editor"); } }, c,
      el("span", {}, name),
      el("button", { cls: "x", title: "Edit in the icon editor", onclick: e => { e.stopPropagation(); editIcon(name); } }, "✎")));
    getIcon(name).then(ic => { c.width = ic.w; c.height = ic.h; c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(ic.frames[0].rgba), ic.w, ic.h), 0, 0); }).catch(() => {});
  }
  $("#soundList").replaceChildren(...lib.sounds.map(f => el("div", { cls: "item" },
    el("span", { cls: "n", title: f.dir + "/" + f.name }, soundLabel(f.name)),
    el("span", { cls: "s" }, f.ro ? "built-in" : fmtBytes(f.size)),
    el("button", { title: "Play on the display", onclick: () => cmd("chime", stem(f.name)) }, "♪"),
    f.ro ? "" : el("button", { title: "Delete from the display", onclick: () => delFile("sounds", f.name) }, "✕"))));
}
let prevTimer;
async function previewAnim(f) {
  clearInterval(prevTimer);
  const c = $("#animPrev").getContext("2d");
  try {
    const a = parsePXA(await api(`/displays/${cur}/files/anims/${enc(f.name)}?size=${f.size}`));
    const img = new ImageData(PW, PH), t0 = performance.now();
    prevTimer = setInterval(() => {
      const fr = frameAt(a, performance.now() - t0).rgb;
      for (let i = 0, j = 0; i < FRAME; i += 3, j += 4) { img.data[j] = fr[i]; img.data[j + 1] = fr[i + 1]; img.data[j + 2] = fr[i + 2]; img.data[j + 3] = 255; }
      c.putImageData(img, 0, 0);
    }, 33);
  } catch (e) { toast(e.message, true); }
}
async function cmd(name, payload) {
  if (!cur) return toast("Adopt a display first", true);
  try { await api(`/displays/${cur}/cmd/${name}`, { method: "POST", body: payload }); toast(`${name}: ${payload}`); } catch (e) { toast(e.message, true); }
}
async function delFile(kind, name) {
  if (!confirm(`Delete ${name} from the display? This can't be undone.`)) return;
  try { await api(`/displays/${cur}/files/${kind}/${enc(name)}`, { method: "DELETE" }); toast("Deleted " + name); await loadLibrary(); refreshStorage(); }
  catch (e) { toast(e.message, true); }
}

/* uploads */
async function imageToPNG(file) {  // any browser-decodable still image -> 8-bit RGBA PNG (what the server's decoder reads)
  const bmp = await createImageBitmap(file);
  let w = bmp.width, h = bmp.height;
  if (w > 416 || h > 256) {  // pre-shrink very large images to 8x the panel; the server does the final fit
    const s = Math.min(416 / w, 256 / h); w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
  }
  const c = el("canvas", { width: w, height: h }), g = c.getContext("2d");
  g.drawImage(bmp, 0, 0, w, h);
  return new Promise(res => c.toBlob(res, "image/png"));
}
async function uploadFiles(files) {
  if (!cur) return toast("Adopt a display first", true);
  const log = $("#upLog");
  for (const f of files) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    let kind = ["mp3", "wav", "ogg"].includes(ext) ? "sounds" : $("#upKind").value, body = f;
    try {
      if (kind !== "sounds") {
        if (ext === "anim") kind = "anims"; else if (ext === "pxi") kind = "icons";
        else if (ext !== "gif") body = await imageToPNG(f);
      }
      log.textContent = `uploading ${f.name}…\n` + log.textContent;
      const r = await api(`/displays/${cur}/upload?kind=${kind}&name=${enc(f.name)}&fit=${$("#upFit").value}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
      log.textContent = `✓ ${f.name} → ${kind}/${r.name} (${r.frames ? r.frames + " frames, " : ""}${fmtBytes(r.bytes)})\n` + log.textContent.replace(/^uploading .*\n/, "");
    } catch (e) { log.textContent = `✗ ${f.name}: ${e.message}\n` + log.textContent.replace(/^uploading .*\n/, ""); }
  }
  await loadLibrary(); refreshStorage();
}

/* stock import */
async function importStock() {
  if (!cur) return toast("Adopt a display first", true);
  const out = $("#importProg"), btn = $("#importBtn");
  btn.disabled = true;
  try {
    let job = await postJSON(`/displays/${cur}/import-stock`, { overwrite: $("#importOver").checked });
    while (!job.finished) {
      out.textContent = `${job.done}/${job.total || "?"} ${job.message}`;
      await new Promise(r => setTimeout(r, 700));
      job = await api(`/jobs/${job.id}`);
    }
    if (job.error) throw new Error(job.error);
    const r = job.result;
    out.textContent = `Done: ${r.imported} imported, ${r.skipped} already there` + (r.failed.length ? `, ${r.failed.length} failed:\n` + r.failed.join("\n") : ".");
    await loadLibrary(); refreshStorage();
  } catch (e) { out.textContent = "Failed: " + e.message; }
  btn.disabled = false;
}

/* ------------------------------------------------------------------ displays tab */
function renderDisplays() {
  if (!status) return;
  $("#adopted").replaceChildren(...(status.displays.length ? status.displays.map(d => el("div", { cls: "item" },
    el("span", { cls: "chip " + (d.online ? "ok" : "bad") }, d.online ? "online" : "offline"),
    el("span", { cls: "n", title: d.error || "" }, `${d.name} · ${d.host} · topic ${d.topic}/`),
    el("button", { onclick: () => removeDisplay(d) }, "Remove"))) : [el("div", { cls: "muted" }, "None yet: scan, then adopt a display.")]));
  const ids = new Set(status.displays.map(d => d.id));
  const found = Object.entries(status.found || {}).filter(([, i]) => !ids.has(i.id));
  $("#found").replaceChildren(...(found.length ? found.map(([ip, i]) => el("div", { cls: "item" },
    el("span", { cls: "n" }, `${i.name} · ${ip} · ${i.model} ${i.w}×${i.h}${i.mqtt_direct ? " · using MQTT directly" : ""}`),
    el("button", { cls: "primary", onclick: () => adopt(ip, i) }, "Adopt"))) : [el("div", { cls: "muted" }, "No unadopted displays found.")]));
  $("#bridgeInfo").textContent = JSON.stringify({ ...status.config, mqtt_connected: status.mqtt.connected }, null, 2);
}
async function adopt(host, info = {}) {
  try { await postJSON("/adopt", { host }); } catch (e) { return toast(e.message, true); }
  $("#adoptHost").textContent = host; $("#adoptErr").textContent = ""; $("#adoptCode").value = "";
  $("#adoptName").value = info.name && info.name !== "govee-pixel" ? info.name : "";
  const legacyFree = !status.displays.some(d => d.topic === "govee-pixel");
  $("#adoptLegacy").checked = legacyFree && !!info.mqtt_direct; $("#adoptLegacy").disabled = !legacyFree;
  $("#adoptTopic").value = "";
  const dlg = $("#adoptDlg"); dlg.dataset.host = host; dlg.showModal(); $("#adoptCode").focus();
}
$("#adoptForm").addEventListener("submit", async e => {
  if (e.submitter && e.submitter.value === "cancel") return;
  e.preventDefault();
  const dlg = $("#adoptDlg");
  try {
    const d = await postJSON("/adopt/confirm", { host: dlg.dataset.host, code: $("#adoptCode").value, name: $("#adoptName").value,
      topic: $("#adoptTopic").value || null, keep_legacy: $("#adoptLegacy").checked });
    dlg.close(); toast(`Adopted ${d.name}`); cur = d.id; await refreshStatus(); loadLibrary();
  } catch (err) { $("#adoptErr").textContent = err.message; }
});
async function removeDisplay(d) {
  if (!confirm(`Remove ${d.name}? pixel2mqtt forgets its token; the display goes back to its own MQTT after 5 minutes (if configured).`)) return;
  try { await api(`/displays/${d.id}`, { method: "DELETE" }); toast("Removed " + d.name); refreshStatus(); } catch (e) { toast(e.message, true); }
}

/* ------------------------------------------------------------------ editor */
const cv = $("#cv"), g = cv.getContext("2d");
function newDoc(w, h, transparent) { return { w, h, transparent, px: new Uint8ClampedArray(w * h * 4), objs: [], undo: [], redo: [] }; }
const docs = { panel: newDoc(PW, PH, false), icon: newDoc(16, 16, true) };
let mode = "panel", doc = docs.panel, tool = "pencil", color = [255, 136, 0, 255], sel = -1;
let drag = null, hover = null, dirty = true, cell = 20;
const PALETTE = ["#000000", "#ffffff", "#7f7f7f", "#ff0000", "#ff8800", "#ffdd00", "#88ff00", "#00c853", "#00e5ff", "#2979ff", "#651fff",
  "#d500f9", "#ff4081", "#8d6e63", "#3e2723", "#1b5e20"];

function layout() {
  cell = Math.max(6, Math.min(40, Math.floor(Math.min(1040 / doc.w, 640 / doc.h))));
  cv.width = doc.w * cell; cv.height = doc.h * cell; cv.style.maxWidth = cv.width + "px"; dirty = true;
  $("#iconW").value = docs.icon.w; $("#iconH").value = docs.icon.h;
}
function snapshot() { return { px: doc.px.slice(), objs: JSON.parse(JSON.stringify(doc.objs)), w: doc.w, h: doc.h }; }
function pushUndo() { doc.undo.push(snapshot()); if (doc.undo.length > 60) doc.undo.shift(); doc.redo = []; }
function restore(s) { doc.px = s.px; doc.objs = s.objs; doc.w = s.w; doc.h = s.h; sel = -1; layout(); renderObjList(); }
function undo() { if (doc.undo.length) { doc.redo.push(snapshot()); restore(doc.undo.pop()); } }
function redo() { if (doc.redo.length) { doc.undo.push(snapshot()); restore(doc.redo.pop()); } }

function setPx(x, y, c) {
  if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
  doc.px.set(c, (y * doc.w + x) * 4); dirty = true; liveDirty = true;
}
function getPx(x, y) { const i = (y * doc.w + x) * 4; return Array.from(doc.px.subarray(i, i + 4)); }
function line(x0, y0, x1, y1, fn) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) { fn(x0, y0); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
}
function rect(x0, y0, x1, y1, fn) {
  const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)], [c, d] = [Math.min(y0, y1), Math.max(y0, y1)];
  for (let x = a; x <= b; x++) { fn(x, c); fn(x, d); }
  for (let y = c; y <= d; y++) { fn(a, y); fn(b, y); }
}
function flood(x, y, c) {
  const target = getPx(x, y).join(); if (target === c.join()) return;
  const st = [[x, y]];
  while (st.length) {
    const [px, py] = st.pop();
    if (px < 0 || py < 0 || px >= doc.w || py >= doc.h || getPx(px, py).join() !== target) continue;
    setPx(px, py, c); st.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
}
const ERASE = [0, 0, 0, 0];

// composite RGBA of the whole document at time t (ms). Icons use pixeld's rule: alpha < 128 is transparent.
const icons = new Map();  // name -> parsed PXI (resolved), for synchronous drawing
function composite(t) {
  const out = doc.px.slice();
  for (const o of doc.objs) {
    const ic = icons.get(o.name); if (!ic) continue;
    const f = frameAt(ic, t - (o.t0 || 0)).rgba;
    for (let j = 0; j < ic.h; j++) for (let i = 0; i < ic.w; i++) {
      const x = o.x + i, y = o.y + j; if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) continue;
      const s = (j * ic.w + i) * 4; if (f[s + 3] < 128) continue;
      out.set([f[s], f[s + 1], f[s + 2], 255], (y * doc.w + x) * 4);
    }
  }
  return out;
}
function panelRGB(t) {  // what the display shows: RGB 52x32 (an icon being edited is centred)
  const c = composite(t), rgb = new Uint8Array(FRAME);
  const ox = Math.floor((PW - doc.w) / 2), oy = Math.floor((PH - doc.h) / 2);
  for (let y = 0; y < doc.h; y++) for (let x = 0; x < doc.w; x++) {
    const X = x + ox, Y = y + oy; if (X < 0 || Y < 0 || X >= PW || Y >= PH) continue;
    const s = (y * doc.w + x) * 4, a = doc.transparent ? (c[s + 3] >= 128 ? 255 : 0) : c[s + 3];
    const d = (Y * PW + X) * 3;
    rgb[d] = c[s] * a / 255; rgb[d + 1] = c[s + 1] * a / 255; rgb[d + 2] = c[s + 2] * a / 255;
  }
  return rgb;
}
const animated = () => doc.objs.some(o => { const ic = icons.get(o.name); return ic && ic.frames.length > 1; });

function draw(t) {
  const c = composite(t), w = doc.w, h = doc.h;
  g.fillStyle = "#000"; g.fillRect(0, 0, cv.width, cv.height);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (c[i + 3] === 0) {
      if (doc.transparent) { g.fillStyle = (x + y) % 2 ? "#2a2a2a" : "#1d1d1d"; g.fillRect(x * cell, y * cell, cell, cell); }
      continue;
    }
    g.fillStyle = `rgb(${c[i]},${c[i + 1]},${c[i + 2]})`; g.fillRect(x * cell, y * cell, cell, cell);
  }
  if (cell >= 8) {  // grid
    g.strokeStyle = "rgba(255,255,255,0.07)"; g.lineWidth = 1; g.beginPath();
    for (let x = 1; x < w; x++) { g.moveTo(x * cell + .5, 0); g.lineTo(x * cell + .5, cv.height); }
    for (let y = 1; y < h; y++) { g.moveTo(0, y * cell + .5); g.lineTo(cv.width, y * cell + .5); }
    g.stroke();
  }
  if (drag && (drag.tool === "line" || drag.tool === "rect") && drag.cur) {  // shape preview
    g.fillStyle = hex(color) + "cc";
    const f = (x, y) => g.fillRect(x * cell, y * cell, cell, cell);
    (drag.tool === "line" ? line : rect)(drag.x0, drag.y0, drag.cur[0], drag.cur[1], f);
  }
  const o = doc.objs[sel], ic = o && icons.get(o.name);
  if (ic) { g.strokeStyle = "#e8a33a"; g.lineWidth = 2; g.strokeRect(o.x * cell + 1, o.y * cell + 1, ic.w * cell - 2, ic.h * cell - 2); }
  if (hover && !drag && tool !== "move") { g.strokeStyle = "rgba(255,255,255,.6)"; g.lineWidth = 1; g.strokeRect(hover[0] * cell + .5, hover[1] * cell + .5, cell - 1, cell - 1); }
}
function loop(t) {
  if (dirty || animated() || drag) { draw(t); dirty = false; }
  requestAnimationFrame(loop);
}

function cellAt(e) {
  const r = cv.getBoundingClientRect();
  return [Math.floor((e.clientX - r.left) / r.width * doc.w), Math.floor((e.clientY - r.top) / r.height * doc.h)];
}
function hitObject(x, y) {
  for (let k = doc.objs.length - 1; k >= 0; k--) {
    const o = doc.objs[k], ic = icons.get(o.name);
    if (ic && x >= o.x && y >= o.y && x < o.x + ic.w && y < o.y + ic.h) return k;
  }
  return -1;
}
cv.addEventListener("contextmenu", e => e.preventDefault());
cv.addEventListener("pointerdown", e => {
  cv.setPointerCapture(e.pointerId);
  const [x, y] = cellAt(e), erase = e.button === 2;
  const t = erase && (tool === "pencil" || tool === "line" || tool === "rect") ? "eraser" : tool;
  if (t === "move") {
    sel = hitObject(x, y); renderObjList(); dirty = true;
    if (sel >= 0) { pushUndo(); drag = { tool: t, dx: x - doc.objs[sel].x, dy: y - doc.objs[sel].y }; }
    return;
  }
  if (t === "pick") {
    const c = composite(performance.now()), i = (y * doc.w + x) * 4;
    if (c[i + 3]) setColor([c[i], c[i + 1], c[i + 2], 255]);
    setTool("pencil"); return;
  }
  pushUndo();
  if (t === "fill") { flood(x, y, color); return; }
  drag = { tool: t, x0: x, y0: y, last: [x, y], cur: [x, y], erase };
  if (t === "pencil" || t === "eraser") setPx(x, y, t === "eraser" ? ERASE : color);
});
cv.addEventListener("pointermove", e => {
  const [x, y] = cellAt(e);
  hover = [x, y]; $("#cursorPos").textContent = `x ${x}, y ${y}`; dirty = true;
  if (!drag) return;
  if (drag.tool === "move") { const o = doc.objs[sel]; if (o) { o.x = x - drag.dx; o.y = y - drag.dy; } return; }
  if (drag.tool === "pencil" || drag.tool === "eraser") {
    line(drag.last[0], drag.last[1], x, y, (a, b) => setPx(a, b, drag.tool === "eraser" ? ERASE : color));
    drag.last = [x, y];
  } else drag.cur = [x, y];
});
cv.addEventListener("pointerup", () => {
  if (drag && (drag.tool === "line" || drag.tool === "rect")) {
    const c = drag.erase ? ERASE : color;
    (drag.tool === "line" ? line : rect)(drag.x0, drag.y0, drag.cur[0], drag.cur[1], (a, b) => setPx(a, b, c));
  }
  drag = null; dirty = true;
});
cv.addEventListener("pointerleave", () => { hover = null; dirty = true; $("#cursorPos").textContent = "–"; });

function setTool(t) {
  tool = t;
  document.querySelectorAll("#tools [data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
  cv.style.cursor = t === "move" ? "move" : "crosshair";
}
function setColor(c) { color = c; $("#color").value = hex(c); $("#colorHex").textContent = hex(c); }

async function addObject(name, x, y) {
  if (!name) return;
  if (mode !== "panel") setMode("panel");
  try {
    const ic = await getIcon(name); icons.set(name, ic);
    pushUndo();
    doc.objs.push({ name, x: x ?? Math.floor((doc.w - ic.w) / 2), y: y ?? Math.floor((doc.h - ic.h) / 2), t0: 0 });
    sel = doc.objs.length - 1; setTool("move"); renderObjList(); dirty = true;
  } catch (e) { toast(e.message, true); }
}
function renderObjList() {
  $("#objList").replaceChildren(...doc.objs.map((o, k) => el("div", { cls: k === sel ? "sel" : "", onclick: () => { sel = k; renderObjList(); dirty = true; } },
    `${o.name} @ ${o.x},${o.y}`,
    el("span", {}, el("button", { title: "Bake into the pixels", onclick: ev => { ev.stopPropagation(); bake(k); } }, "⤓"),
      el("button", { title: "Remove", onclick: ev => { ev.stopPropagation(); pushUndo(); doc.objs.splice(k, 1); sel = -1; renderObjList(); dirty = true; } }, "✕")))));
}
function bake(k) {  // draw an icon's current frame into the pixel layer
  pushUndo();
  const keep = doc.objs; doc.objs = [keep[k]];
  const c = composite(performance.now()); doc.objs = keep.filter((_, i) => i !== k);
  doc.px = c; sel = -1; renderObjList(); dirty = true;
}

function setMode(m) {
  mode = m; doc = docs[m]; sel = -1;
  document.querySelector(`input[name=emode][value=${m}]`).checked = true;
  $("#iconSize").classList.toggle("hidden", m !== "icon");
  $("#iconCard").classList.toggle("hidden", m !== "panel");
  $("#saveHint").textContent = m === "panel"
    ? "Saved as an animation on the display (it then appears in Home Assistant's Animation list). Animated icons are kept animated."
    : "Saved to the display's icon library (transparent pixels stay transparent).";
  $("#grabBtn").disabled = m !== "panel";
  $("#iconW").value = docs.icon.w; $("#iconH").value = docs.icon.h;
  layout(); renderObjList();
}
function resizeIcon(w, h) {
  w = Math.max(1, Math.min(PW, w | 0)); h = Math.max(1, Math.min(PH, h | 0));
  pushUndo();
  const old = doc, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < Math.min(h, old.h); y++) for (let x = 0; x < Math.min(w, old.w); x++) px.set(old.px.subarray((y * old.w + x) * 4, (y * old.w + x) * 4 + 4), (y * w + x) * 4);
  doc.w = w; doc.h = h; doc.px = px; layout();
}
async function editIcon(name) {
  try {
    const ic = await getIcon(name);
    setMode("icon"); pushUndo();
    doc.w = ic.w; doc.h = ic.h; doc.px = new Uint8ClampedArray(ic.frames[0].rgba);
    for (let i = 3; i < doc.px.length; i += 4) doc.px[i] = doc.px[i] >= 128 ? 255 : 0;
    $("#iconW").value = ic.w; $("#iconH").value = ic.h; $("#saveName").value = name;
    layout(); showTab("editor");
    if (ic.frames.length > 1) toast("Animated icon: only its first frame is edited");
  } catch (e) { toast(e.message, true); }
}

// all frames needed to save the panel (animated icons -> sampled over a common loop, identical frames merged)
function panelFrames() {
  const loops = doc.objs.map(o => icons.get(o.name)).filter(ic => ic && ic.frames.length > 1).map(ic => ic.total);
  if (!loops.length) return [{ delay: 1000, rgb: panelRGB(0) }];
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  let L = loops.reduce((a, b) => a / gcd(a, b) * b);
  if (L > 10000) L = Math.max(...loops);
  const frames = [];
  for (let t = 0; t < L && frames.length < 600; t += 20) {
    const rgb = panelRGB(t), last = frames[frames.length - 1];
    if (last && last.rgb.every((v, i) => v === rgb[i])) last.delay += 20; else frames.push({ delay: 20, rgb });
  }
  return frames;
}
async function save() {
  if (!cur) return toast("Adopt a display first", true);
  const name = $("#saveName").value.trim();
  if (!name) { $("#saveName").focus(); return toast("Give it a name first", true); }
  try {
    let r;
    if (mode === "panel") {
      const frames = panelFrames();
      r = await postRaw(`/displays/${cur}/upload?kind=anims&name=${enc(name)}`, buildPXA(frames));
      toast(`Saved animation "${stem(r.name)}" (${frames.length} frame${frames.length > 1 ? "s" : ""})`);
    } else {
      const rgba = doc.px.slice();
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = rgba[i] >= 128 ? 255 : 0;
      r = await postRaw(`/displays/${cur}/upload?kind=icons&name=${enc(name)}`, buildPXI(doc.w, doc.h, rgba));
      toast(`Saved icon "${stem(r.name)}" to the library`);
    }
    await loadLibrary(); refreshStorage();
    if (mode === "panel") $("#animSel").value = stem(r.name);  // ready to play with ▶
  } catch (e) { toast(e.message, true); }
}

/* live preview -> POST frame -> UDP 7777 (the display falls back to its mode 3 s after the last frame) */
let liveBusy = false, liveLast = 0, liveSent = 0, liveCount = 0, liveDirty = true, liveT = performance.now();
const markLive = () => { liveDirty = true; };
setInterval(async () => {
  if (!$("#liveChk").checked || !cur || liveBusy) return;
  const now = performance.now();
  if (!(liveDirty || animated() || drag || now - liveLast > 1000)) return;
  liveBusy = true; liveDirty = false; liveLast = now;
  try { await postRaw(`/displays/${cur}/frame`, panelRGB(now)); liveCount++; }
  catch (e) { $("#liveChk").checked = false; toast("Live preview stopped: " + e.message, true); }
  liveBusy = false;
}, 33);
setInterval(() => {
  const now = performance.now();
  $("#liveInfo").textContent = $("#liveChk").checked ? `live · ${Math.round((liveCount - liveSent) * 1000 / (now - liveT))} fps` : "";
  liveSent = liveCount; liveT = now;
}, 1000);

/* ------------------------------------------------------------------ wiring */
function showTab(t) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
  document.querySelectorAll(".tabpane").forEach(p => p.classList.toggle("active", p.id === "tab-" + t));
}
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
document.querySelectorAll("#tools [data-tool]").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
document.querySelectorAll("input[name=emode]").forEach(r => r.addEventListener("change", () => setMode(r.value)));
$("#iconResize").addEventListener("click", () => resizeIcon(+$("#iconW").value, +$("#iconH").value));
$("#undoBtn").addEventListener("click", () => { undo(); markLive(); });
$("#redoBtn").addEventListener("click", () => { redo(); markLive(); });
$("#color").addEventListener("input", e => setColor([...unhex(e.target.value), 255]));
$("#palette").replaceChildren(...PALETTE.map(h => el("button", { style: `background:${h}`, title: h, onclick: () => setColor([...unhex(h), 255]) })));
$("#addIcon").addEventListener("click", () => addObject($("#iconSel").value));
$("#playAnim").addEventListener("click", () => $("#animSel").value && cmd("animation", $("#animSel").value));
$("#playSound").addEventListener("click", () => $("#soundSel").value && cmd("chime", $("#soundSel").value));
$("#clearBtn").addEventListener("click", () => { pushUndo(); doc.px = new Uint8ClampedArray(doc.w * doc.h * 4); doc.objs = []; sel = -1; renderObjList(); dirty = true; markLive(); });
$("#grabBtn").addEventListener("click", async () => {
  if (!cur) return;
  try {
    const rgb = new Uint8Array(await api(`/displays/${cur}/frame`));
    pushUndo(); setMode("panel");
    for (let i = 0, j = 0; i < FRAME; i += 3, j += 4) doc.px.set([rgb[i], rgb[i + 1], rgb[i + 2], rgb[i] | rgb[i + 1] | rgb[i + 2] ? 255 : 0], j);
    dirty = true; markLive();
  } catch (e) { toast(e.message, true); }
});
$("#pngBtn").addEventListener("click", () => {
  const c = el("canvas", { width: doc.w, height: doc.h }), px = composite(performance.now());
  if (!doc.transparent) for (let i = 3; i < px.length; i += 4) px[i] = 255;
  c.getContext("2d").putImageData(new ImageData(px, doc.w, doc.h), 0, 0);
  c.toBlob(b => { const a = el("a", { href: URL.createObjectURL(b), download: ($("#saveName").value || "pixel") + ".png" }); a.click(); });
});
$("#saveBtn").addEventListener("click", save);
$("#displaySel").addEventListener("change", e => { cur = e.target.value || null; iconCache.clear(); refreshStatus(); loadLibrary(); });
$("#scanBtn").addEventListener("click", async () => { try { await api("/scan", { method: "POST" }); await refreshStatus(); toast("Scan complete"); } catch (e) { toast(e.message, true); } });
$("#manualAdd").addEventListener("click", () => { const h = $("#manualHost").value.trim(); if (h) adopt(h); });
$("#importBtn").addEventListener("click", importStock);
$("#fileIn").addEventListener("change", e => { uploadFiles([...e.target.files]); e.target.value = ""; });
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => uploadFiles([...e.dataTransfer.files]));
document.addEventListener("keydown", e => {
  if (e.target.matches("input, select, textarea") || !$("#tab-editor").classList.contains("active")) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); markLive(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); markLive(); return; }
  const tools = { p: "pencil", e: "eraser", f: "fill", l: "line", r: "rect", i: "pick", m: "move" };
  if (tools[k] && !e.ctrlKey && !e.metaKey) return setTool(tools[k]);
  const o = doc.objs[sel]; if (!o) return;
  if (k === "delete" || k === "backspace") { pushUndo(); doc.objs.splice(sel, 1); sel = -1; }
  else if (k.startsWith("arrow")) { e.preventDefault(); o.x += k === "arrowleft" ? -1 : k === "arrowright" ? 1 : 0; o.y += k === "arrowup" ? -1 : k === "arrowdown" ? 1 : 0; }
  else return;
  renderObjList(); dirty = true; markLive();
});
cv.addEventListener("pointerup", () => { markLive(); if (tool === "move") renderObjList(); });

setColor(color); setMode("panel"); requestAnimationFrame(loop);
refreshStatus(); setInterval(refreshStatus, 4000);
