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
  if (typeof Editor !== "undefined") Editor.refreshOpenList();
  $("#animCount").textContent = lib.anims.length; $("#iconCount").textContent = lib.icons.length; $("#soundCount").textContent = lib.sounds.length;

  $("#animList").replaceChildren(...lib.anims.map(f => el("div", { cls: "item" },
    el("span", { cls: "n", title: "Preview", onclick: () => previewAnim(f) }, stem(f.name)),
    el("span", { cls: "s" }, fmtBytes(f.size)),
    el("button", { title: "Play on the display", onclick: () => cmd("animation", stem(f.name)) }, "▶"),
    el("button", { title: "Open in the editor (as layers when possible)", onclick: () => { Editor.openAnim(stem(f.name)); showTab("editor"); } }, "✎"),
    el("button", { title: "Rename (a re-import keeps the new name)", onclick: () => renameAnim(f.name) }, "Aa"),
    el("button", { title: "Delete from the display", onclick: () => delFile("anims", f.name) }, "✕"))));
  const grid = $("#iconGrid"); grid.replaceChildren();
  for (const f of lib.icons) {
    const c = el("canvas", { width: 1, height: 1 });
    const name = stem(f.name);
    grid.append(el("div", { cls: "ic", title: `${name} - click to add it as a layer in the editor`, onclick: () => { Editor.addIconLayer(name); showTab("editor"); } }, c,
      el("span", {}, name),
      el("button", { cls: "x", title: "Edit in the icon editor", onclick: e => { e.stopPropagation(); Editor.editIcon(name); } }, "✎")));
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
async function renameAnim(name) {
  const n = prompt("New name for " + stem(name), stem(name));
  if (n === null || !n.trim() || n.trim() === stem(name)) return;
  try { const r = await postJSON(`/displays/${cur}/rename`, { name, new: n.trim() }); toast("Renamed to " + stem(r.name)); await loadLibrary(); }
  catch (e) { toast(e.message, true); }
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
    out.textContent = `Done: ${r.imported} imported, ${r.skipped} already there` + (r.removed && r.removed.length ? `, ${r.removed.length} duplicate(s) removed` : "") + (r.failed.length ? `, ${r.failed.length} failed:\n` + r.failed.join("\n") : ".");
    await loadLibrary(); refreshStorage();
  } catch (e) { out.textContent = "Failed: " + e.message; }
  btn.disabled = false;
}

async function dedupeAnims() {
  if (!cur) return toast("Adopt a display first", true);
  if (!confirm("Delete animations that are identical to another one? In each group the one with a real name is kept (over 'App ...' copies).")) return;
  const out = $("#importProg"), btn = $("#dedupeBtn");
  btn.disabled = true;
  try {
    let job = await postJSON(`/displays/${cur}/dedupe`, {});
    while (!job.finished) {
      out.textContent = `Comparing ${job.done}/${job.total || "?"} ${job.message}`;
      await new Promise(r => setTimeout(r, 700));
      job = await api(`/jobs/${job.id}`);
    }
    if (job.error) throw new Error(job.error);
    const k = job.result.kept;
    out.textContent = job.result.removed.length ? "Removed " + job.result.removed.length + ":\n" + job.result.removed.map(n => `${stem(n)} (same as ${stem(k[n])})`).join("\n") : "No duplicates.";
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

/* ------------------------------------------------------------------ wiring */
function showTab(t) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
  document.querySelectorAll(".tabpane").forEach(p => p.classList.toggle("active", p.id === "tab-" + t));
}
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("#playAnim").addEventListener("click", () => $("#animSel").value && cmd("animation", $("#animSel").value));
$("#playSound").addEventListener("click", () => $("#soundSel").value && cmd("chime", $("#soundSel").value));
$("#displaySel").addEventListener("change", e => { cur = e.target.value || null; iconCache.clear(); refreshStatus(); loadLibrary(); });
$("#scanBtn").addEventListener("click", async () => { try { await api("/scan", { method: "POST" }); await refreshStatus(); toast("Scan complete"); } catch (e) { toast(e.message, true); } });
$("#manualAdd").addEventListener("click", () => { const h = $("#manualHost").value.trim(); if (h) adopt(h); });
$("#importBtn").addEventListener("click", importStock);
$("#dedupeBtn").addEventListener("click", dedupeAnims);
$("#fileIn").addEventListener("change", e => { uploadFiles([...e.target.files]); e.target.value = ""; });
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => uploadFiles([...e.dataTransfer.files]));

refreshStatus(); setInterval(refreshStatus, 4000);
