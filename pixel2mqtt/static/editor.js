"use strict";
// pixel2mqtt scene editor: layers (frames, position, motion, tiling, opacity, blink), frame strip, playback,
// live preview, open/save. Uses scene.js (model/render/bake) and helpers from app.js (api, el, toast, lib, ...).
const Editor = (() => {
  const cv = $("#cv"), g = cv.getContext("2d");
  const PALETTE = ["#000000", "#ffffff", "#7f7f7f", "#ff0000", "#ff8800", "#ffdd00", "#88ff00", "#00c853", "#00e5ff", "#2979ff", "#651fff",
    "#d500f9", "#ff4081", "#8d6e63", "#3e2723", "#1b5e20"];
  const DIRS = [[-1, -1, "↖"], [0, -1, "↑"], [1, -1, "↗"], [-1, 0, "←"], [0, 0, "•"], [1, 0, "→"], [-1, 1, "↙"], [0, 1, "↓"], [1, 1, "↘"]];
  const ERASE = [0, 0, 0, 0];

  const docs = { anim: Scene.newScene(PW, PH, [0, 0, 0]), icon: Scene.newScene(16, 16, null) };
  const hist = { anim: { undo: [], redo: [] }, icon: { undo: [], redo: [] } };
  const sel = { anim: { l: 0, f: 0 }, icon: { l: 0, f: 0 } };
  let mode = "anim", sc = docs.anim, tool = "pencil", color = [255, 136, 0, 255];
  let playing = false, t = 0, t0 = 0, loopLen = 1000, drag = null, hover = null, dirty = true, cell = 20, stripDirty = true;
  const BRUSHES = [1, 2, 3, 4, 6];
  let brush = 1, round = false;   // brush size and shape for pencil, eraser, line and rectangle

  const L = () => sc.layers[sel[mode].l];
  const F = () => { const l = L(); return l.frames[Math.min(sel[mode].f, l.frames.length - 1)]; };
  const touch = () => { dirty = true; liveDirty = true; };

  /* ---------------------------------------------------------------- history */
  function pushUndo() { const h = hist[mode]; h.undo.push({ sc: Scene.clone(sc), s: { ...sel[mode] } }); if (h.undo.length > 40) h.undo.shift(); h.redo = []; }
  function restore(st) { docs[mode] = sc = st.sc; sel[mode] = st.s; fullRefresh(); }
  function undo() { const h = hist[mode]; if (h.undo.length) { h.redo.push({ sc: Scene.clone(sc), s: { ...sel[mode] } }); restore(h.undo.pop()); } }
  function redo() { const h = hist[mode]; if (h.redo.length) { h.undo.push({ sc: Scene.clone(sc), s: { ...sel[mode] } }); restore(h.redo.pop()); } }

  /* ---------------------------------------------------------------- rendering */
  function layout() {
    cell = Math.max(6, Math.min(40, Math.floor(Math.min(1040 / sc.w, 640 / sc.h))));
    cv.width = sc.w * cell; cv.height = sc.h * cell; cv.style.maxWidth = cv.width + "px"; dirty = true;
  }
  // what the canvas shows: playing = the animation; paused = time t, with the selected layer on its selected frame
  function composite() {
    if (playing) return Scene.render(sc, t);
    const l = L(), view = Object.assign({}, sc, { layers: sc.layers.map(x => x === l ? Object.assign({}, x, { frames: [F()] }) : x) });
    return Scene.render(view, t);
  }
  function draw() {
    const W = sc.w, H = sc.h, c = composite();
    g.fillStyle = "#000"; g.fillRect(0, 0, cv.width, cv.height);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (c[i + 3] === 0) { if (!sc.bg) { g.fillStyle = (x + y) % 2 ? "#2a2a2a" : "#1d1d1d"; g.fillRect(x * cell, y * cell, cell, cell); } continue; }
      g.fillStyle = `rgb(${c[i]},${c[i + 1]},${c[i + 2]})`; g.fillRect(x * cell, y * cell, cell, cell);
    }
    const l = L();
    if (!playing && $("#onionChk").checked && l.frames.length > 1 && sel[mode].f > 0) {  // previous frame, faint
      const prev = l.frames[sel[mode].f - 1], [ox, oy] = Scene.layerPos(l, t);
      g.globalAlpha = 0.3;
      forEachLayerPixel(l, prev, ox, oy, (x, y, s) => { if (prev.rgba[s + 3]) { g.fillStyle = `rgb(${prev.rgba[s]},${prev.rgba[s + 1]},${prev.rgba[s + 2]})`; g.fillRect(x * cell, y * cell, cell, cell); } });
      g.globalAlpha = 1;
    }
    if (cell >= 8) {
      g.strokeStyle = "rgba(255,255,255,0.07)"; g.lineWidth = 1; g.beginPath();
      for (let x = 1; x < W; x++) { g.moveTo(x * cell + .5, 0); g.lineTo(x * cell + .5, cv.height); }
      for (let y = 1; y < H; y++) { g.moveTo(0, y * cell + .5); g.lineTo(cv.width, y * cell + .5); }
      g.stroke();
    }
    if (!playing && !l.tile) {  // selected layer bounds
      const [ox, oy] = Scene.layerPos(l, t), f = F();
      g.setLineDash([4, 3]); g.strokeStyle = "#e8a33a"; g.lineWidth = 1.5; g.strokeRect(ox * cell + .5, oy * cell + .5, f.w * cell - 1, f.h * cell - 1); g.setLineDash([]);
    }
    if (drag && (drag.tool === "line" || drag.tool === "rect") && drag.cur) {
      g.fillStyle = hex(color) + "cc";
      (drag.tool === "line" ? line : rect)(drag.x0, drag.y0, drag.cur[0], drag.cur[1], (x, y) => stamp(x, y, (a, b) => g.fillRect(a * cell, b * cell, cell, cell)));
    }
    if (hover && !drag && tool !== "move" && !playing) {
      g.strokeStyle = "rgba(255,255,255,.6)"; g.lineWidth = 1;
      if (usesBrush(tool) && brush > 1) {   // shade exactly the cells the brush will paint
        g.fillStyle = "rgba(255,255,255,.22)";
        stamp(hover[0], hover[1], (a, b) => g.fillRect(a * cell, b * cell, cell, cell));
      } else g.strokeRect(hover[0] * cell + .5, hover[1] * cell + .5, cell - 1, cell - 1);
    }
  }
  function forEachLayerPixel(l, f, ox, oy, fn) {
    for (let y = 0; y < sc.h; y++) {
      let sy = y - oy; if (l.tile) sy = ((sy % f.h) + f.h) % f.h; else if (sy < 0 || sy >= f.h) continue;
      for (let x = 0; x < sc.w; x++) {
        let sx = x - ox; if (l.tile) sx = ((sx % f.w) + f.w) % f.w; else if (sx < 0 || sx >= f.w) continue;
        fn(x, y, (sy * f.w + sx) * 4);
      }
    }
  }
  function frame(now) {
    if (playing) { t = (now - t0) % loopLen; dirty = true; syncTime(); }
    if (dirty || drag) { draw(); dirty = false; }
    if (stripDirty) { renderStrip(); stripDirty = false; }
    requestAnimationFrame(frame);
  }
  function syncTime() { $("#timeSlider").value = Math.round(t); $("#timeLabel").textContent = (t / 1000).toFixed(2) + " s / " + (loopLen / 1000).toFixed(2) + " s"; }
  function replan() { loopLen = Math.max(100, Scene.plan(sc).length); $("#timeSlider").max = Math.round(loopLen); if (t > loopLen) t = 0; syncTime(); }

  /* ---------------------------------------------------------------- drawing */
  // screen cell -> pixel index in the selected layer's current frame (or -1)
  function layerIndex(x, y) {
    const l = L(), f = F(), [ox, oy] = Scene.layerPos(l, t);
    let sx = x - ox, sy = y - oy;
    if (l.tile) { sx = ((sx % f.w) + f.w) % f.w; sy = ((sy % f.h) + f.h) % f.h; }
    if (sx < 0 || sy < 0 || sx >= f.w || sy >= f.h) return -1;
    return (sy * f.w + sx) * 4;
  }
  function setPx(x, y, c) { const i = layerIndex(x, y); if (i >= 0) { F().rgba.set(c, i); touch(); } }
  const usesBrush = tl => tl === "pencil" || tl === "eraser" || tl === "line" || tl === "rect";
  function stamp(x, y, fn) {  // the brush around (x, y); even sizes extend right/down
    const a = Math.floor((brush - 1) / 2), b = brush - 1 - a, c = (b - a) / 2, r2 = (brush * brush - brush) / 4;
    for (let dy = -a; dy <= b; dy++) for (let dx = -a; dx <= b; dx++) {
      if (round && brush > 2 && (dx - c) ** 2 + (dy - c) ** 2 > r2) continue;   // round: skip the corners
      fn(x + dx, y + dy);
    }
  }
  const paint = (x, y, c) => stamp(x, y, (a, b) => setPx(a, b, c));
  function setBrush(n) {
    brush = n; dirty = true;
    document.querySelectorAll("#brushSizes [data-size]").forEach(b => b.classList.toggle("active", +b.dataset.size === n));
  }
  function setShape(r) {
    round = r; dirty = true;
    document.querySelectorAll("#brushShapes [data-shape]").forEach(b => b.classList.toggle("active", (b.dataset.shape === "round") === r));
    document.querySelectorAll("#brushSizes i").forEach(i => { i.style.borderRadius = r ? "50%" : "0"; });
  }
  function getPx(x, y) { const i = layerIndex(x, y); return i < 0 ? null : Array.from(F().rgba.subarray(i, i + 4)).join(); }
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
  function flood(x, y, c) {  // fill within the layer frame (screen-space neighbours)
    const target = getPx(x, y); if (target === null || target === c.join()) return;
    const st = [[x, y]], seen = new Set();
    while (st.length) {
      const [px, py] = st.pop(), k = px + "," + py;
      if (seen.has(k) || px < 0 || py < 0 || px >= sc.w || py >= sc.h || getPx(px, py) !== target) continue;
      seen.add(k); setPx(px, py, c); st.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }
  function cellAt(e) {
    const r = cv.getBoundingClientRect();
    return [Math.floor((e.clientX - r.left) / r.width * sc.w), Math.floor((e.clientY - r.top) / r.height * sc.h)];
  }
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("pointerdown", e => {
    if (playing) setPlaying(false);
    cv.setPointerCapture(e.pointerId);
    const [x, y] = cellAt(e), erase = e.button === 2;
    const tl = erase && (tool === "pencil" || tool === "line" || tool === "rect") ? "eraser" : tool;
    if (tl === "move") { pushUndo(); drag = { tool: tl, x0: x, y0: y, lx: L().x, ly: L().y }; return; }
    if (tl === "pick") {
      const c = composite(), i = (y * sc.w + x) * 4;
      if (c[i + 3]) setColor([c[i], c[i + 1], c[i + 2], 255]);
      setTool("pencil"); return;
    }
    pushUndo();
    if (tl === "fill") { flood(x, y, color); stripDirty = true; return; }
    drag = { tool: tl, x0: x, y0: y, last: [x, y], cur: [x, y], erase };
    if (tl === "pencil" || tl === "eraser") paint(x, y, tl === "eraser" ? ERASE : color);
  });
  cv.addEventListener("pointermove", e => {
    const [x, y] = cellAt(e);
    hover = [x, y]; $("#cursorPos").textContent = `x ${x}, y ${y}`; dirty = true;
    if (!drag) return;
    if (drag.tool === "move") { L().x = drag.lx + x - drag.x0; L().y = drag.ly + y - drag.y0; touch(); return; }
    if (drag.tool === "pencil" || drag.tool === "eraser") {
      line(drag.last[0], drag.last[1], x, y, (a, b) => paint(a, b, drag.tool === "eraser" ? ERASE : color));
      drag.last = [x, y];
    } else drag.cur = [x, y];
  });
  cv.addEventListener("pointerup", () => {
    if (drag && (drag.tool === "line" || drag.tool === "rect")) {
      const c = drag.erase ? ERASE : color;
      (drag.tool === "line" ? line : rect)(drag.x0, drag.y0, drag.cur[0], drag.cur[1], (a, b) => paint(a, b, c));
    }
    if (drag && drag.tool === "move") renderProps();
    drag = null; touch(); stripDirty = true;
  });
  cv.addEventListener("pointerleave", () => { hover = null; dirty = true; $("#cursorPos").textContent = "–"; });

  function setTool(tl) {
    tool = tl;
    document.querySelectorAll("#tools [data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === tl));
    cv.style.cursor = tl === "move" ? "move" : "crosshair";
  }
  function setColor(c) { color = c; $("#color").value = hex(c); $("#colorHex").textContent = hex(c); }

  /* ---------------------------------------------------------------- layers panel */
  function renderLayers() {
    const s = sel[mode];
    $("#layerList").replaceChildren(...sc.layers.map((l, i) => i).reverse().map(i => {
      const l = sc.layers[i], tags = [];
      if (l.frames.length > 1) tags.push(l.frames.length + " fr");
      if (l.speed > 0 && (l.dir[0] || l.dir[1])) tags.push(DIRS.find(d => d[0] === l.dir[0] && d[1] === l.dir[1])[2] + " " + Math.round(l.speed));
      if (l.tile) tags.push("tile"); if (l.blink) tags.push("blink");
      return el("div", { cls: "ly" + (i === s.l ? " sel" : ""), onclick: () => selectLayer(i) },
        el("button", { title: l.visible ? "Hide" : "Show", onclick: e => { e.stopPropagation(); pushUndo(); l.visible = !l.visible; renderLayers(); replan(); touch(); } }, l.visible ? "👁" : "◌"),
        el("span", { cls: "n" }, l.name), el("span", { cls: "tag" }, tags.join(" · ")));
    }));
  }
  function selectLayer(i) { sel[mode].l = i; sel[mode].f = 0; renderLayers(); renderProps(); stripDirty = true; dirty = true; }
  function renderProps() {
    const l = L(), f = l.frames[0];
    $("#pName").value = l.name; $("#pX").value = l.x; $("#pY").value = l.y; $("#pW").value = f.w; $("#pH").value = f.h;
    $("#pTile").checked = l.tile; $("#pSpeed").value = Math.round(l.speed); $("#pSpeedV").textContent = Math.round(l.speed) + " px/s";
    $("#pOpacity").value = l.opacity; $("#pOpacityV").textContent = l.opacity + " %"; $("#pBlink").value = l.blink;
    document.querySelectorAll("#dirPad button").forEach(b => b.classList.toggle("on", +b.dataset.dx === l.dir[0] && +b.dataset.dy === l.dir[1]));
  }
  function addLayer(layer, above = true) {
    pushUndo();
    const at = above ? sel[mode].l + 1 : 0;
    sc.layers.splice(at, 0, layer); selectLayer(at); replan(); touch();
  }
  function framesFromJSON(frames) { return Scene.fromJSON({ w: 1, h: 1, bg: null, layers: [{ frames }] }).layers[0].frames; }
  function resizeFrames(l, w, h) {
    for (const f of l.frames) {
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < Math.min(h, f.h); y++) for (let x = 0; x < Math.min(w, f.w); x++) px.set(f.rgba.subarray((y * f.w + x) * 4, (y * f.w + x) * 4 + 4), (y * w + x) * 4);
      f.w = w; f.h = h; f.rgba = px;
    }
    delete l.span;
  }

  /* ---------------------------------------------------------------- frame strip */
  function renderStrip() {
    const l = L(), s = sel[mode];
    $("#framesOf").textContent = ` of "${l.name}" (${l.frames.length})`;
    $("#frameStrip").replaceChildren(...l.frames.map((f, i) => {
      const c = el("canvas", { width: f.w, height: f.h });
      const img = new ImageData(new Uint8ClampedArray(f.rgba), f.w, f.h);
      c.getContext("2d").putImageData(img, 0, 0);
      const inp = el("input", { type: "number", min: "20", max: "10000", step: "10", value: String(f.delay), title: "Duration (ms)" });
      inp.addEventListener("change", () => { pushUndo(); f.delay = Math.max(20, +inp.value || 100); delete l.span; replan(); touch(); });
      inp.addEventListener("click", e => e.stopPropagation());
      return el("div", { cls: "fr" + (i === s.f ? " sel" : ""), onclick: () => { s.f = i; stripDirty = true; dirty = true; } }, c, inp);
    }));
  }

  /* ---------------------------------------------------------------- playback / live */
  function setPlaying(p) { playing = p; $("#playBtn").textContent = p ? "⏸" : "▶"; if (p) { replan(); t0 = performance.now() - t; } dirty = true; }
  let liveBusy = false, liveLast = 0, liveSent = 0, liveCount = 0, liveDirty = true, liveT = performance.now();
  setInterval(async () => {
    if (!$("#liveChk").checked || !cur || liveBusy) return;
    const now = performance.now();
    if (!(liveDirty || playing || drag || now - liveLast > 1000)) return;
    liveBusy = true; liveDirty = false; liveLast = now;
    try { await postRaw(`/displays/${cur}/frame`, Scene.toPanel(composite(), sc.w, sc.h)); liveCount++; }
    catch (e) { $("#liveChk").checked = false; toast("Live preview stopped: " + e.message, true); }
    liveBusy = false;
  }, 33);
  setInterval(() => {
    const now = performance.now();
    $("#liveInfo").textContent = $("#liveChk").checked ? ` · live ${Math.round((liveCount - liveSent) * 1000 / (now - liveT))} fps` : "";
    liveSent = liveCount; liveT = now;
  }, 1000);

  /* ---------------------------------------------------------------- modes, open, save */
  function fullRefresh() { layout(); renderLayers(); renderProps(); replan(); stripDirty = true; touch(); renderSceneProps(); }
  function renderSceneProps() {
    $("#bgNone").checked = !sc.bg; $("#bgColor").value = sc.bg ? hex(sc.bg) : "#000000"; $("#bgNoneWrap").classList.toggle("hidden", mode !== "icon");
    $("#iconW").value = sc.w; $("#iconH").value = sc.h;
  }
  function setMode(m) {
    mode = m; sc = docs[m];
    document.querySelector(`input[name=emode][value=${m}]`).checked = true;
    $("#iconSize").classList.toggle("hidden", m !== "icon");
    $("#grabBtn").disabled = m !== "anim";
    $("#saveHint").textContent = m === "anim"
      ? "Saves the scene (editable later) and bakes it into an animation on the display, which then appears in Home Assistant's Animation list."
      : "Saves to the display's icon library (several frames = animated icon). Transparent pixels stay transparent.";
    fullRefresh();
  }
  function setScene(s, m) {
    docs[m] = s; hist[m] = { undo: [], redo: [] }; sel[m] = { l: s.layers.length - 1, f: 0 }; t = 0;
    if (mode !== m) setMode(m); else { sc = s; fullRefresh(); }
  }
  async function refreshOpenList() {
    let saved = [];
    try { saved = await api("/scenes"); } catch (e) { /* server too old or offline */ }
    const os = $("#openSel"); const keep = os.value;
    os.replaceChildren(
      el("optgroup", { label: "Saved scenes" }, ...(saved.length ? saved.map(s => el("option", { value: "s:" + s.name }, s.name)) : [el("option", { value: "", disabled: "" }, "(none yet)")])),
      el("optgroup", { label: "Animations on the display" }, ...lib.anims.map(f => el("option", { value: "a:" + stem(f.name) }, stem(f.name)))));
    if (keep) os.value = keep;
  }
  async function openSelected() {
    const v = $("#openSel").value; if (!v) return;
    try {
      if (v.startsWith("s:")) {
        const s = Scene.fromJSON(await api(`/scenes/${enc(v.slice(2))}`));
        setScene(s, s.w === PW && s.h === PH && s.bg ? "anim" : "icon"); $("#saveName").value = v.slice(2).replace(/ \(icon\)$/, "");
      } else await openAnim(v.slice(2));
      toast("Opened " + v.slice(2));
    } catch (e) { toast(e.message, true); }
  }
  async function openAnim(name) {
    if (!cur) return toast("Adopt a display first", true);
    try {
      toast("Opening " + name + "…");
      const s = Scene.fromJSON(await api(`/displays/${cur}/scene?anim=${enc(name)}`));
      setScene(s, "anim"); $("#saveName").value = name;
      toast(`Opened "${name}": ${s.layers.length} layer${s.layers.length > 1 ? "s" : ""}`);
    } catch (e) { toast(e.message, true); }
  }
  async function save() {
    if (!cur) return toast("Adopt a display first", true);
    const name = $("#saveName").value.trim();
    if (!name) { $("#saveName").focus(); return toast("Give it a name first", true); }
    try {
      const { frames } = Scene.bake(sc, 450);
      let r;
      if (mode === "anim") {
        r = await postRaw(`/displays/${cur}/upload?kind=anims&name=${enc(name)}`, Scene.buildPXA(frames, sc.w, sc.h));
        await api(`/scenes/${enc(name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: Scene.toJSON(sc) });
        toast(`Saved "${stem(r.name)}" (${frames.length} frame${frames.length > 1 ? "s" : ""}) to the display and as an editable scene`);
        await loadLibrary(); $("#animSel").value = stem(r.name);
      } else {
        r = await postRaw(`/displays/${cur}/upload?kind=icons&name=${enc(name)}`, Scene.buildPXI(frames.slice(0, 64), sc.w, sc.h));
        await api(`/scenes/${enc(name + " (icon)")}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: Scene.toJSON(sc) });
        toast(`Saved icon "${stem(r.name)}"` + (frames.length > 1 ? ` (${Math.min(64, frames.length)} frames)` : ""));
        iconCache.clear(); await loadLibrary();
      }
      refreshStorage(); refreshOpenList();
    } catch (e) { toast(e.message, true); }
  }
  async function addIconLayer(name) {
    if (!name) return;
    if (mode !== "anim") setMode("anim");
    try {
      const ic = await getIcon(name);
      const l = Scene.newLayer(ic.w, ic.h, name);
      l.frames = ic.frames.map(f => ({ w: ic.w, h: ic.h, delay: f.delay, rgba: new Uint8ClampedArray(f.rgba) }));
      l.x = Math.floor((sc.w - ic.w) / 2); l.y = Math.floor((sc.h - ic.h) / 2);
      addLayer(l); setTool("move");
    } catch (e) { toast(e.message, true); }
  }
  async function editIcon(name) {
    try {
      const ic = await getIcon(name), s = Scene.newScene(ic.w, ic.h, null);
      s.layers[0].name = name;
      s.layers[0].frames = ic.frames.map(f => ({ w: ic.w, h: ic.h, delay: f.delay, rgba: new Uint8ClampedArray(f.rgba) }));
      setScene(s, "icon"); $("#saveName").value = name; showTab("editor");
    } catch (e) { toast(e.message, true); }
  }
  async function imageLayer(file) {
    try {
      const body = (file.type === "image/gif" || /\.gif$/i.test(file.name)) ? file : await imageToPNG(file);
      const { frames } = await api(`/layer-frames?max=256`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
      const fr = framesFromJSON(frames), l = Scene.newLayer(fr[0].w, fr[0].h, stem(file.name));
      l.frames = fr; l.x = Math.floor((sc.w - fr[0].w) / 2); l.y = Math.floor((sc.h - fr[0].h) / 2);
      addLayer(l);
      toast(`Added "${l.name}" (${fr[0].w}×${fr[0].h}${fr.length > 1 ? ", " + fr.length + " frames" : ""})`);
    } catch (e) { toast(e.message, true); }
  }

  /* ---------------------------------------------------------------- wiring */
  $("#dirPad").replaceChildren(...DIRS.map(([dx, dy, s]) => el("button", { "data-dx": String(dx), "data-dy": String(dy), title: dx || dy ? "Move " + s : "No motion", onclick: () => {
    pushUndo(); const l = L(); l.dir = [dx, dy]; delete l.span; if ((dx || dy) && !l.speed) l.speed = 20; renderProps(); renderLayers(); replan(); touch();
  } }, s)));
  const bindNum = (id, fn) => $(id).addEventListener("change", e => { pushUndo(); fn(L(), e.target); renderLayers(); renderProps(); replan(); touch(); });
  $("#pName").addEventListener("change", e => { pushUndo(); L().name = e.target.value || "Layer"; renderLayers(); stripDirty = true; });
  bindNum("#pX", (l, i) => { l.x = Math.round(+i.value || 0); });
  bindNum("#pY", (l, i) => { l.y = Math.round(+i.value || 0); });
  bindNum("#pTile", (l, i) => { l.tile = i.checked; });
  bindNum("#pBlink", (l, i) => { l.blink = Math.max(0, Math.round(+i.value || 0)); });
  $("#pSpeed").addEventListener("input", e => { L().speed = +e.target.value; delete L().span; $("#pSpeedV").textContent = e.target.value + " px/s"; replan(); touch(); });
  $("#pSpeed").addEventListener("change", () => renderLayers());
  $("#pSpeed").addEventListener("pointerdown", pushUndo);
  $("#pOpacity").addEventListener("input", e => { L().opacity = +e.target.value; $("#pOpacityV").textContent = e.target.value + " %"; touch(); });
  $("#pOpacity").addEventListener("pointerdown", pushUndo);
  $("#pResize").addEventListener("click", () => { pushUndo(); resizeFrames(L(), Math.max(1, Math.min(256, +$("#pW").value | 0)), Math.max(1, Math.min(256, +$("#pH").value | 0))); renderProps(); stripDirty = true; replan(); touch(); });
  $("#lyNew").addEventListener("click", () => addLayer(Scene.newLayer(sc.w, sc.h, "Layer " + (sc.layers.length + 1))));
  $("#lyImg").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) imageLayer(f); });
  $("#lyDup").addEventListener("click", () => { const c = Scene.clone({ w: 1, h: 1, bg: null, layers: [L()] }).layers[0]; c.name += " copy"; addLayer(c); });
  $("#lyDel").addEventListener("click", () => {
    if (sc.layers.length < 2) return toast("A scene needs at least one layer", true);
    pushUndo(); sc.layers.splice(sel[mode].l, 1); selectLayer(Math.max(0, sel[mode].l - 1)); replan(); touch();
  });
  const moveLayer = d => { const i = sel[mode].l, j = i + d; if (j < 0 || j >= sc.layers.length) return; pushUndo(); [sc.layers[i], sc.layers[j]] = [sc.layers[j], sc.layers[i]]; selectLayer(j); touch(); };
  $("#lyUp").addEventListener("click", () => moveLayer(1));
  $("#lyDown").addEventListener("click", () => moveLayer(-1));
  $("#addIcon").addEventListener("click", () => addIconLayer($("#iconSel").value));
  const frOp = fn => { pushUndo(); fn(L(), sel[mode]); delete L().span; stripDirty = true; replan(); touch(); renderLayers(); };
  $("#frAdd").addEventListener("click", () => frOp((l, s) => { const f = F(); l.frames.splice(s.f + 1, 0, { w: f.w, h: f.h, delay: f.delay, rgba: new Uint8ClampedArray(f.w * f.h * 4) }); s.f++; }));
  $("#frDup").addEventListener("click", () => frOp((l, s) => { const f = F(); l.frames.splice(s.f + 1, 0, { w: f.w, h: f.h, delay: f.delay, rgba: f.rgba.slice() }); s.f++; }));
  $("#frDel").addEventListener("click", () => { if (L().frames.length < 2) return toast("A layer needs at least one frame", true); frOp((l, s) => { l.frames.splice(s.f, 1); s.f = Math.max(0, s.f - 1); }); });
  $("#frLeft").addEventListener("click", () => { if (sel[mode].f > 0) frOp((l, s) => { [l.frames[s.f - 1], l.frames[s.f]] = [l.frames[s.f], l.frames[s.f - 1]]; s.f--; }); });
  $("#frRight").addEventListener("click", () => { if (sel[mode].f < L().frames.length - 1) frOp((l, s) => { [l.frames[s.f + 1], l.frames[s.f]] = [l.frames[s.f], l.frames[s.f + 1]]; s.f++; }); });
  $("#playBtn").addEventListener("click", () => setPlaying(!playing));
  $("#timeSlider").addEventListener("input", e => { if (playing) setPlaying(false); t = +e.target.value; syncTime(); touch(); });
  $("#onionChk").addEventListener("change", () => { dirty = true; });
  $("#bgColor").addEventListener("input", e => { if (!sc.bg && mode === "icon") return; sc.bg = unhex(e.target.value); touch(); });
  $("#bgNone").addEventListener("change", e => { pushUndo(); sc.bg = e.target.checked ? null : unhex($("#bgColor").value); touch(); });
  $("#iconResize").addEventListener("click", () => {
    const w = Math.max(1, Math.min(PW, +$("#iconW").value | 0)), h = Math.max(1, Math.min(PH, +$("#iconH").value | 0));
    pushUndo(); sc.w = w; sc.h = h; fullRefresh();
  });
  $("#openBtn").addEventListener("click", openSelected);
  $("#newBtn").addEventListener("click", () => {
    if (!confirm("Start a new, empty " + (mode === "anim" ? "animation" : "icon") + "? Unsaved changes are lost (Undo still works).")) return;
    pushUndo(); const s = mode === "anim" ? Scene.newScene(PW, PH, [0, 0, 0]) : Scene.newScene(sc.w, sc.h, null);
    docs[mode] = sc = s; sel[mode] = { l: 0, f: 0 }; t = 0; $("#saveName").value = ""; fullRefresh();
  });
  $("#delSceneBtn").addEventListener("click", async () => {
    const name = $("#saveName").value.trim() + (mode === "icon" ? " (icon)" : ""); if (!name.trim()) return;
    if (!confirm(`Delete the saved scene "${name}"? The animation on the display stays.`)) return;
    try { await api(`/scenes/${enc(name)}`, { method: "DELETE" }); toast("Deleted scene " + name); refreshOpenList(); } catch (e) { toast(e.message, true); }
  });
  $("#saveBtn").addEventListener("click", save);
  $("#grabBtn").addEventListener("click", async () => {
    if (!cur) return;
    try {
      const rgb = new Uint8Array(await api(`/displays/${cur}/frame`)), l = Scene.newLayer(PW, PH, "From display"), px = l.frames[0].rgba;
      for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) px.set([rgb[i], rgb[i + 1], rgb[i + 2], rgb[i] | rgb[i + 1] | rgb[i + 2] ? 255 : 0], j);
      addLayer(l);
    } catch (e) { toast(e.message, true); }
  });
  $("#pngBtn").addEventListener("click", () => {
    const c = el("canvas", { width: sc.w, height: sc.h }); c.getContext("2d").putImageData(new ImageData(composite(), sc.w, sc.h), 0, 0);
    c.toBlob(b => el("a", { href: URL.createObjectURL(b), download: ($("#saveName").value || "pixel") + ".png" }).click());
  });
  document.querySelectorAll("#tools [data-tool]").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
  document.querySelectorAll("input[name=emode]").forEach(r => r.addEventListener("change", () => setMode(r.value)));
  document.querySelectorAll("#brushSizes [data-size]").forEach(b => b.addEventListener("click", () => setBrush(+b.dataset.size)));
  document.querySelectorAll("#brushShapes [data-shape]").forEach(b => b.addEventListener("click", () => setShape(b.dataset.shape === "round")));
  $("#undoBtn").addEventListener("click", undo);
  $("#redoBtn").addEventListener("click", redo);
  $("#color").addEventListener("input", e => setColor([...unhex(e.target.value), 255]));
  $("#palette").replaceChildren(...PALETTE.map(h => el("button", { style: `background:${h}`, title: h, onclick: () => setColor([...unhex(h), 255]) })));
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, select, textarea") || !$("#tab-editor").classList.contains("active")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
    if (k === " ") { e.preventDefault(); setPlaying(!playing); return; }
    if (k === "[" || k === "]") {  // brush size down/up
      const i = BRUSHES.indexOf(brush) + (k === "]" ? 1 : -1);
      return setBrush(BRUSHES[Math.max(0, Math.min(BRUSHES.length - 1, i))]);
    }
    const tools = { p: "pencil", e: "eraser", f: "fill", l: "line", r: "rect", i: "pick", m: "move" };
    if (tools[k] && !e.ctrlKey && !e.metaKey) return setTool(tools[k]);
    if (k.startsWith("arrow") && tool === "move") {
      e.preventDefault(); pushUndo(); const l = L();
      l.x += k === "arrowleft" ? -1 : k === "arrowright" ? 1 : 0; l.y += k === "arrowup" ? -1 : k === "arrowdown" ? 1 : 0;
      renderProps(); touch();
    }
  });

  setColor(color); setMode("anim"); requestAnimationFrame(frame); refreshOpenList();
  return { addIconLayer, editIcon, openAnim, refreshOpenList };
})();
