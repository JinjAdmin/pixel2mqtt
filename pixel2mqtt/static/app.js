"use strict";
// pixel2mqtt web editor. No build step, no external libraries.
const $ = s => document.querySelector(s);
const PW = 52, PH = 32, FRAME = PW * PH * 3;

/* ------------------------------------------------------------------ helpers */
async function api(path, opts = {}) {
  const r = await fetch("api" + path, opts);   // relative: also works under Home Assistant Ingress
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
// Styled replacements for confirm() / prompt(): ask(message, {ok, danger}) -> Promise<boolean>,
// askText(message, value, {ok, placeholder}) -> Promise<string|null>. Enter = OK, Esc = Cancel.
function dialogBox(message, { ok = "OK", cancel = "Cancel", danger = false, input = null, title = "" } = {}) {
  return new Promise(resolve => {
    const field = input === null ? null : el("input", { type: "text", value: input.value || "", placeholder: input.placeholder || "", spellcheck: "false" });
    const okBtn = el("button", { cls: danger ? "primary dangerbtn" : "primary", value: "ok" }, ok);
    const form = el("form", { method: "dialog", cls: "askform" },
      title ? el("h3", {}, title) : "",
      el("p", { cls: "askmsg" }, message),
      field || "",
      el("div", { cls: "btns askbtns" }, el("button", { value: "cancel", type: "button", onclick: () => d.close("cancel") }, cancel), okBtn));
    const d = el("dialog", { cls: "ask" }, form);
    form.addEventListener("submit", e => { e.preventDefault(); d.close("ok"); });
    d.addEventListener("close", () => {
      const yes = d.returnValue === "ok";
      d.remove();
      resolve(field ? (yes ? field.value : null) : yes);
    });
    document.body.append(d); d.showModal();
    if (field) { field.focus(); field.select(); } else okBtn.focus();
  });
}
const ask = (message, opts) => dialogBox(message, opts);
const askText = (message, value, opts = {}) => dialogBox(message, { ...opts, input: { value, placeholder: opts.placeholder } });
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
const lib = { anims: [], icons: [], sounds: [], screens: [] };
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
// Everything on the display: animations, screens, icons and sounds, each with a preview, open in the editor,
// rename and delete; plus the projects that aren't on it, with Send.
const total = list => list.reduce((a, f) => a + (f.ro ? 0 : f.size || 0), 0);
let scrReport = [];
async function loadLibrary() {
  if (!cur) { lib.anims = lib.icons = lib.sounds = lib.screens = []; scrReport = []; renderLibrary(); return; }
  try {
    const [a, i, s, sc] = await Promise.all(["anims", "icons", "sounds", "screens"].map(k => api(`/displays/${cur}/files/${k}`).catch(() => [])));
    const by = (x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" });
    lib.anims = a.filter(f => f.name.endsWith(".anim")).sort(by);
    lib.icons = i.sort(by);
    lib.screens = sc.filter(f => f.name.endsWith(".scr")).sort(by);
    const seen = new Set();
    lib.sounds = s.filter(f => { const l = soundLabel(f.name).toLowerCase(); if (seen.has(l)) return false; seen.add(l); return true; })
      .sort((x, y) => soundLabel(x.name).localeCompare(soundLabel(y.name)));
  } catch (e) { toast("Library: " + e.message, true); }
  try { const r = await api(`/displays/${cur}/screens`); scrReport = Array.isArray(r) ? r : (r.screens || []); } catch (e) { scrReport = []; }
  renderLibrary();
}
const projectFor = (name, kind) => (typeof Editor !== "undefined" ? Editor.projectList() : []).find(p => p.meta.sent && p.meta.sent.as === name && (p.meta.type === kind || (kind === "anim" && !p.meta.type)));
const heading = (id, list) => { $(id).textContent = `${list.length}${total(list) ? " · " + fmtBytes(total(list)) : ""}`; };
function renderLibrary() {
  const opts = (list, fn) => list.length ? list.map(fn) : [el("option", { value: "" }, "(none)")];
  $("#animSel").replaceChildren(...opts(lib.anims, f => el("option", { value: stem(f.name) }, stem(f.name))));
  $("#iconSel").replaceChildren(...opts(lib.icons, f => el("option", { value: stem(f.name) }, stem(f.name))));
  $("#soundSel").replaceChildren(...opts(lib.sounds, f => el("option", { value: stem(f.name) }, soundLabel(f.name))));
  const st = display() && display().state;
  if (st && st.animation) $("#animSel").value = st.animation;
  if (typeof Editor !== "undefined") Editor.refreshOpenList();
  heading("#animCount", lib.anims); heading("#iconCount", lib.icons); heading("#soundCount", lib.sounds); heading("#screenCount", lib.screens || []);

  $("#animList").replaceChildren(...lib.anims.map(f => el("div", { cls: "item" },
    el("span", { cls: "n", title: "Preview", onclick: () => previewAnim(f) }, stem(f.name)),
    el("span", { cls: "s" }, fmtBytes(f.size)),
    el("button", { title: "Play on the display", onclick: () => cmd("animation", stem(f.name)) }, "▶"),
    el("button", { title: "Open in the editor (as layers when possible)", onclick: () => { Editor.openAnim(stem(f.name)); showTab("editor"); } }, "✎"),
    el("button", { title: "Rename (a re-import keeps the new name)", onclick: () => renameFile("anims", f.name) }, "Aa"),
    el("button", { title: "Delete from the display", onclick: () => delFile("anims", f.name) }, "✕"))));

  $("#screenList").replaceChildren(...((lib.screens || []).length ? lib.screens.map(f => {
    const name = stem(f.name), r = scrReport.find(x => x.file === f.name || x.name === name) || {};
    const miss = Array.isArray(r.missing) ? r.missing : String(r.missing || "").split(/\s+/).filter(Boolean);
    const state = r.errors && r.errors.length ? ["chip warn", `${r.errors.length} problem${r.errors.length > 1 ? "s" : ""}`, r.errors.map(e => `line ${e.line}: ${e.msg}`).join("\n")]
      : r.visible ? ["chip ok", "showing", "In the Info rotation"] : miss.length ? ["chip draft", "waiting", "Waiting for " + miss.join(", ")] : r.name ? ["chip draft", "hidden", "Its Show when rule is false right now"] : null;
    const p = projectFor(name, "screen");
    return el("div", { cls: "item" },
      el("span", { cls: "n", title: "Preview with its current values", onclick: () => previewScreen(f) }, (r.name && r.name !== name ? `${r.name} (${name})` : name)),
      state ? el("span", { cls: state[0], title: state[2] }, state[1]) : "",
      el("span", { cls: "s" }, fmtBytes(f.size)),
      el("button", { title: "Show it now (pins it in Info mode; Auto in HA's Screen select resumes the rotation)", onclick: () => cmd("screen", r.name || name) }, "▶"),
      el("button", { title: p ? `Open the project "${p.name}"` : "Open a copy in the screen editor", onclick: () => openScreen(f, p) }, "✎"),
      el("button", { title: "Rename (its value bindings follow)", onclick: () => renameFile("screens", f.name) }, "Aa"),
      el("button", { title: "Remove from the display (its value bindings stop)", onclick: () => removeScreen(name) }, "✕"));
  }) : [el("p", { cls: "muted small" }, cur ? "No screens on this display. Make one in the Editor: + New screen." : "Adopt a display first.")]));

  $("#iconList").replaceChildren(...lib.icons.map(f => {
    const name = stem(f.name), c = el("canvas", { width: 1, height: 1, cls: "thumb" });
    getIcon(name).then(ic => { c.width = ic.w; c.height = ic.h; c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(ic.frames[0].rgba), ic.w, ic.h), 0, 0); c.title = `${ic.w}×${ic.h}, ${ic.frames.length} frame${ic.frames.length > 1 ? "s" : ""}`; }).catch(() => {});
    return el("div", { cls: "item" }, c,
      el("span", { cls: "n", title: "Add it as a layer in the editor", onclick: () => { Editor.addIconLayer(name); showTab("editor"); } }, name),
      el("span", { cls: "s" }, fmtBytes(f.size)),
      el("button", { title: "Edit a copy in the icon editor", onclick: () => { Editor.editIcon(name); showTab("editor"); } }, "✎"),
      el("button", { title: "Rename (screens that use it by name need updating)", onclick: () => renameFile("icons", f.name) }, "Aa"),
      el("button", { title: "Delete from the display", onclick: () => delFile("icons", f.name) }, "✕"));
  }));

  $("#soundList").replaceChildren(...lib.sounds.map(f => el("div", { cls: "item" },
    el("span", { cls: "n", title: f.dir + "/" + f.name }, soundLabel(f.name)),
    el("span", { cls: "s" }, f.ro ? "built-in" : fmtBytes(f.size)),
    el("button", { title: "Play on the display", onclick: () => cmd("chime", stem(f.name)) }, "♪"),
    f.ro ? "" : el("button", { title: "Rename", onclick: () => renameFile("sounds", f.name) }, "Aa"),
    f.ro ? "" : el("button", { title: "Delete from the display", onclick: () => delFile("sounds", f.name) }, "✕"))));

  // projects that aren't on the display (never sent, removed, or renamed there)
  const on = { anim: new Set(lib.anims.map(f => stem(f.name))), icon: new Set(lib.icons.map(f => stem(f.name))), screen: new Set((lib.screens || []).map(f => stem(f.name))) };
  const off = (typeof Editor !== "undefined" ? Editor.projectList() : []).filter(p => !(p.meta.sent && (on[p.meta.type || "anim"] || new Set()).has(p.meta.sent.as)));
  $("#offCount").textContent = off.length;
  $("#offList").replaceChildren(...(off.length ? off.map(p => el("div", { cls: "item" },
    el("span", { cls: "badge" }, p.meta.type === "icon" ? "Icon" : p.meta.type === "screen" ? "Screen" : "Animation"),
    el("span", { cls: "n", title: "Open in the editor", onclick: () => Editor.openProject(p.name) }, p.name),
    el("button", { title: "Open in the editor", onclick: () => Editor.openProject(p.name) }, "✎"),
    el("button", Object.assign({ cls: "primary", title: cur ? "Send to the display" : "Adopt a display first", onclick: () => Editor.openAndSend(p.name) }, cur ? {} : { disabled: "" }), "Send"))) : [el("p", { cls: "muted small" }, "Every project is on the display.")]));
}
let prevTimer, scrTimer;
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
// a screen on the display, rendered as pixeld would: its bound values live from HA (the group's shown member),
// otherwise its project's samples
async function previewScreen(f) {
  clearInterval(scrTimer);
  const name = stem(f.name), c = $("#scrPrev").getContext("2d");
  try {
    const text = new TextDecoder().decode(await api(`/displays/${cur}/files/screens/${enc(f.name)}`));
    const values = {}, now = () => Date.now() / 1000;
    const p = projectFor(name, "screen");
    if (p) { try { const raw = await api(`/scenes/${enc(p.name)}`); for (const [k, v] of Object.entries((raw.screen && raw.screen.samples) || {})) { let x = v; try { x = JSON.parse(v); } catch (e) { /* text */ } ScreenRender.setValue(values, k, x, now()); } } catch (e) { /* no samples */ } }
    let bindings = {}, member = null;
    try {
      const b = await api(`/displays/${cur}/bindings`);
      bindings = (b.screens || {})[name] || {};
      const g = (b.groups || {})[name];
      if (g) {
        member = g.selected !== "rotate" ? g.selected : null;
        if (!member) { const ms = await api(`/ha/members?by=${enc(g.by)}&match=${enc(g.match)}`); member = ms.length ? ms[0].id : null; }
      }
      if (Object.keys(bindings).length) ScreenRender.applyMessage(values, Object.fromEntries(Object.entries(await postJSON("/ha/values", { bindings, member })).filter(([, v]) => v !== null)), now());
    } catch (e) { /* no HA: samples only */ }
    let source = Object.keys(bindings).length ? "live values from Home Assistant" : p ? "the project's sample values" : "";
    if (!Object.keys(values).length) {   // nothing yet: an example with this name lends its samples
      try {
        const ex = (await (await fetch("examples/screens/index.json")).json()).find(x => x.name.toLowerCase() === name.toLowerCase() || x.file === f.name);
        if (ex) { ScreenRender.applyMessage(values, await (await fetch(`examples/screens/${enc(ex.values)}`)).json(), now()); source = "the example's sample values"; }
      } catch (e) { /* none */ }
    }
    $("#scrPrevNote").textContent = `${name}: ${source ? "with " + source : "no values yet (bind them in the screen editor)"}`;
    const icons = {};
    for (const ic of lib.icons) if (text.includes(stem(ic.name))) { try { const x = await getIcon(stem(ic.name)); icons[stem(ic.name)] = { w: x.w, h: x.h, frames: x.frames.map(fr => ({ delay: fr.delay, rgba: fr.rgba })) }; } catch (e) { /* skip */ } }
    const st = display() && display().state || {};
    const flag = re => { const kv = Object.entries(st).find(([k]) => re.test(k)); return kv ? /^(on|true|1)$/i.test(kv[1]) : false; };
    const scr = ScreenRender.parse(text, name, { values, icons });
    const img = new ImageData(PW, PH);
    scrTimer = setInterval(() => {
      const fb = ScreenRender.render(scr, { values, icons, now: now(), fahrenheit: flag(/fahrenheit/i), h12: flag(/12.?h/i) });
      for (let i = 0, j = 0; i < FRAME; i += 3, j += 4) { img.data[j] = fb[i]; img.data[j + 1] = fb[i + 1]; img.data[j + 2] = fb[i + 2]; img.data[j + 3] = 255; }
      c.putImageData(img, 0, 0);
    }, 100);
  } catch (e) { toast(e.message, true); }
}
async function openScreen(f, p) {
  if (p) return Editor.openProject(p.name);
  try {   // no project for it (made elsewhere): open a copy as a new screen project
    const text = new TextDecoder().decode(await api(`/displays/${cur}/files/screens/${enc(f.name)}`));
    showTab("editor"); await Editor.refreshOpenList();
    const taken = new Set(Editor.projectList().map(x => x.name.toLowerCase()));
    let n = `${stem(f.name)} (copy)`, i = 2; while (taken.has(n.toLowerCase())) n = `${stem(f.name)} (copy ${i++})`;
    Screens.create(n, text);
    toast(`Opened a copy of "${stem(f.name)}" as "${n}". The screen on the display isn't touched.`);
  } catch (e) { toast(e.message, true); }
}
async function removeScreen(name) {
  if (!await ask(`Remove the screen "${name}" from the display? Its value bindings stop. Its project (if any) stays in pixel2mqtt.`, { ok: "Remove", danger: true })) return;
  try { await api(`/displays/${cur}/screens/${enc(name)}`, { method: "DELETE" }); toast("Removed " + name); await loadLibrary(); refreshStorage(); }
  catch (e) { toast(e.message, true); }
}
async function cmd(name, payload) {
  if (!cur) return toast("Adopt a display first", true);
  try { await api(`/displays/${cur}/cmd/${name}`, { method: "POST", body: payload }); toast(`${name}: ${payload}`); } catch (e) { toast(e.message, true); }
}
async function renameFile(kind, name) {
  const n = await askText(`New name for "${kind === "sounds" ? soundLabel(name) : stem(name)}"`, stem(name), { ok: "Rename" });
  if (n === null || !n.trim() || n.trim() === stem(name)) return;
  try { const r = await postJSON(`/displays/${cur}/rename`, { kind, name, new: n.trim() }); toast("Renamed to " + stem(r.name)); if (kind === "icons") iconCache.clear(); await loadLibrary(); }
  catch (e) { toast(e.message, true); }
}
const renameAnim = name => renameFile("anims", name);
async function delFile(kind, name) {
  if (!await ask(`Delete ${name} from the display? This can't be undone.`, { ok: "Delete", danger: true })) return;
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
  if (!await ask("Delete animations that are identical to another one? In each group the one with a real name is kept (over 'App ...' copies).", { ok: "Delete duplicates", danger: true })) return;
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
  if (!await ask(`Remove ${d.name}? pixel2mqtt forgets its token; the display goes back to its own MQTT after 5 minutes (if configured).`, { ok: "Remove", danger: true })) return;
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
