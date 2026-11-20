"use strict";
// pixel2mqtt scene editor: layers (frames, position, motion, tiling, opacity, blink), frame strip, playback,
// live preview, open/save. Uses scene.js (model/render/bake) and helpers from app.js (api, el, toast, lib, ...).
const Editor = (() => {
  const cv = $("#cv"), g = cv.getContext("2d");
  // palette: the last 18 colours used (newest first), topped up with these defaults until there are 18
  const DEFAULT_COLORS = ["#000000", "#ffffff", "#7f7f7f", "#ff0000", "#ff8800", "#ffdd00", "#88ff00", "#00c853", "#00e5ff", "#2979ff", "#651fff",
    "#d500f9", "#ff4081", "#8d6e63", "#3e2723", "#1b5e20", "#b0bec5", "#0d47a1"];
  const NPAL = 18;
  let recent = [];
  try { recent = (JSON.parse(localStorage.getItem("p2m.recentColors")) || []).filter(h => /^#[0-9a-f]{6}$/.test(h)).slice(0, NPAL); } catch (e) { recent = []; }
  const paletteColors = () => [...recent, ...DEFAULT_COLORS.filter(h => !recent.includes(h))].slice(0, NPAL);
  function useColor(c) {   // a colour was actually painted with: move it to the front of the palette
    const h = hex(c); if (recent[0] === h) return;
    recent = [h, ...recent.filter(x => x !== h)].slice(0, NPAL);
    try { localStorage.setItem("p2m.recentColors", JSON.stringify(recent)); } catch (e) { /* private mode */ }
    renderPalette();
  }
  const DIRS = [[-1, -1, "↖"], [0, -1, "↑"], [1, -1, "↗"], [-1, 0, "←"], [0, 0, "•"], [1, 0, "→"], [-1, 1, "↙"], [0, 1, "↓"], [1, 1, "↘"]];
  const ERASE = [0, 0, 0, 0];

  const docs = { anim: Scene.newScene(PW, PH, [0, 0, 0]), icon: Scene.newScene(16, 16, null) };
  const hist = { anim: { undo: [], redo: [] }, icon: { undo: [], redo: [] } };
  const sel = { anim: { l: 0, f: 0 }, icon: { l: 0, f: 0 } };
  let mode = "anim", sc = docs.anim, tool = "pencil";
  let playing = false, t = 0, t0 = 0, loopLen = 1000, drag = null, hover = null, dirty = true, cell = 20, stripDirty = true;
  // camera over the workspace: centre (panel cells) and cell size (canvas px). The panel ("viewport") is at 0,0.
  const CW = 1040, CH = 640, ZOOMS = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48];
  let cam = { x: 26, y: 16 }, camKey = "", panMode = false, wheelAcc = 0, vis = { x: 0, y: 0, w: 52, h: 32 };
  const BRUSHES = [1, 2, 3, 4, 6];
  // separate brushes: pencil (also line and rectangle) and eraser, so switching keeps each one's settings
  // every tool keeps its own settings: pencil, line and rectangle (size, shape, colour), eraser (size, shape),
  // fill (colour). The eyedropper sets the colour of the tool used before it.
  const ORANGE = [255, 136, 0, 255];
  const settings = {
    pencil: { size: 1, round: false, color: ORANGE }, line: { size: 1, round: false, color: ORANGE },
    shape: { size: 1, round: false, color: ORANGE, kind: "rect", fill: false }, eraser: { size: 3, round: false }, fill: { color: ORANGE },
  };
  let colorTool = "pencil";   // the last tool with a colour (what the eyedropper sets)
  const brushOf = (tl, erase) => settings[erase || tl === "eraser" ? "eraser" : settings[tl] && settings[tl].size !== undefined ? tl : "pencil"];
  const colorOf = tl => (settings[tl] && settings[tl].color) || settings[colorTool].color;

  const L = () => sc.layers[sel[mode].l];
  const F = () => { const l = L(); return l.frames[Math.min(sel[mode].f, l.frames.length - 1)]; };
  const touch = () => { dirty = true; liveDirty = true; };

  /* ---------------------------------------------------------------- project state */
  // A project = one editable scene stored by pixel2mqtt ("Save", also automatic), separate from what's on the
  // display ("Send to display"). Its meta is kept in the scene file: { type: "anim"|"icon", rev, sent: {as, rev} }.
  const proj = { open: false, name: "", type: "anim", edited: false, rev: 0, sent: null };
  function statusOf(name, meta, edited) {
    const sent = meta.sent;
    if (!sent || sent.as !== name) return ["Draft", "draft", "Not on the display yet"];
    if (sent.rev === meta.rev && !edited) return ["On display", "ok", "The display has this version"];
    return ["Changed since sent", "warn", "The display has an older version: Send to update it"];
  }
  function syncDoc() {
    $("#docName").textContent = proj.name || "Untitled";
    $("#docDirty").classList.toggle("hidden", !proj.edited);
    $("#docType").textContent = proj.type === "icon" ? `Icon ${sc.w}×${sc.h}` : "Animation";
    const [s, c, tip] = statusOf(proj.name, proj, proj.edited);
    $("#docStatus").textContent = s; $("#docStatus").className = "chip " + c; $("#docStatus").title = tip;
  }
  function markEdited(on = true) { if (proj.edited !== on) { proj.edited = on; syncDoc(); } }
  function pushUndo() { markEdited(); const h = hist[mode]; h.undo.push({ sc: Scene.clone(sc), s: { ...sel[mode] } }); if (h.undo.length > 40) h.undo.shift(); h.redo = []; }
  function restore(st) { docs[mode] = sc = st.sc; sel[mode] = st.s; fullRefresh(); }
  function undo() { const h = hist[mode]; if (h.undo.length) { h.redo.push({ sc: Scene.clone(sc), s: { ...sel[mode] } }); restore(h.undo.pop()); } }
  function redo() { const h = hist[mode]; if (h.redo.length) { h.undo.push({ sc: Scene.clone(sc), s: { ...sel[mode] } }); restore(h.redo.pop()); } }

  /* ---------------------------------------------------------------- rendering */
  // The canvas is a fixed workspace around the panel (the "viewport"): zoom and pan freely. Outside the panel it shows
  // the other layers dimmed and the selected layer at full brightness, so layers bigger than the panel (long scrolling
  // backgrounds) can be drawn in full. A tiled layer shows one whole tile outside the panel (from the panel's
  // top-left), not endless repeats. "Hide outside viewport" shows the panel only.
  const hideOut = () => $("#vpOnly").checked;
  const inPanel = (x, y) => x >= 0 && y >= 0 && x < sc.w && y < sc.h;
  // pixel index in frame f of layer l (at offset ox, oy) shown at panel cell px, py, or -1
  function sampleIdx(l, f, ox, oy, px, py) {
    const inP = inPanel(px, py);
    if (!inP && hideOut()) return -1;
    let sx = px - ox, sy = py - oy;
    if (l.tile) {
      if (!inP && !(px >= 0 && py >= 0 && px < Math.max(sc.w, f.w) && py < Math.max(sc.h, f.h))) return -1;
      sx = ((sx % f.w) + f.w) % f.w; sy = ((sy % f.h) + f.h) % f.h;
    } else if (sx < 0 || sy < 0 || sx >= f.w || sy >= f.h) return -1;
    return (sy * f.w + sx) * 4;
  }
  const fitCell = () => Math.max(2, Math.min(40, Math.floor(Math.min(CW / (sc.w + 12), CH / (sc.h + 8)))));
  function recenter() { cell = fitCell(); cam = { x: sc.w / 2, y: sc.h / 2 }; syncZoom(); dirty = true; }
  function syncZoom() { $("#zoomLbl").textContent = Math.round(cell / fitCell() * 100) + "%"; }
  function zoomStep(dir, ax = CW / 2, ay = CH / 2) {   // keep the point under (ax, ay) canvas px in place
    const i = ZOOMS.findIndex(z => z >= cell), j = dir > 0 ? (ZOOMS[i] > cell ? i : i + 1) : (i <= 0 ? 0 : i - 1);
    const nc = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, j === -1 ? ZOOMS.length - 1 : j))];
    if (nc === cell) return;
    const wx = cam.x + (ax - CW / 2) / cell, wy = cam.y + (ay - CH / 2) / cell;
    cell = nc; cam = { x: wx - (ax - CW / 2) / cell, y: wy - (ay - CH / 2) / cell }; syncZoom(); dirty = true;
  }
  const origin = () => [Math.round(CW / 2 - cam.x * cell), Math.round(CH / 2 - cam.y * cell)];
  function layout() {   // the canvas keeps its size; a new project (or a new icon size) recentres on the panel
    if (cv.width !== CW) { cv.width = CW; cv.height = CH; }
    const key = proj.name + "|" + mode + "|" + sc.w + "x" + sc.h;
    if (key !== camKey) { camKey = key; recenter(); }
    dirty = true;
  }
  // what the canvas shows: playing = the animation; paused = time t, with the selected layer on its selected frame
  // Moving layers use the speeds plan() tunes for a seamless loop (exactly what's sent), not the raw ones, so the
  // preview and Live on display loop as cleanly as the display does.
  const rates = () => Scene.plan(sc).rates;
  const posOf = (l, R) => Scene.layerPos(l, t, (R || rates()).get(l));
  function composite() {
    const R = rates();
    if (playing) return Scene.render(sc, t, R);
    const l = L(), layers = sc.layers.map(x => x === l ? Object.assign({}, x, { frames: [F()] }) : x);
    return Scene.render(Object.assign({}, sc, { layers }), t, new Map(layers.map((x, i) => [x, R.get(sc.layers[i])])));
  }
  // the scene over a block of cells V (panel coordinates), same blending as Scene.render; background inside the panel
  function compose(V) {
    const out = new Uint8ClampedArray(V.w * V.h * 4), sl = L(), R = rates();
    if (sc.bg) for (let y = 0; y < V.h; y++) for (let x = 0; x < V.w; x++) if (inPanel(V.x + x, V.y + y)) {
      const d = (y * V.w + x) * 4; out[d] = sc.bg[0]; out[d + 1] = sc.bg[1]; out[d + 2] = sc.bg[2]; out[d + 3] = 255;
    }
    for (const l of sc.layers) {
      if (l.visible === false) continue;
      if (l.blink > 0 && Math.floor(t / Math.max(20, l.blink)) % 2) continue;
      const f = !playing && l === sl ? F() : Scene.frameAt(l, t), [ox, oy] = posOf(l, R);
      const op = Math.min(100, l.opacity === undefined ? 100 : l.opacity);
      for (let y = 0; y < V.h; y++) for (let x = 0; x < V.w; x++) {
        const s = sampleIdx(l, f, ox, oy, V.x + x, V.y + y); if (s < 0) continue;
        const a = Math.floor(f.rgba[s + 3] * op / 100); if (!a) continue;
        const d = (y * V.w + x) * 4;
        if (a === 255 || !out[d + 3]) { out[d] = f.rgba[s]; out[d + 1] = f.rgba[s + 1]; out[d + 2] = f.rgba[s + 2]; out[d + 3] = Math.max(out[d + 3], a); }
        else for (let c = 0; c < 3; c++) out[d + c] = Math.floor((f.rgba[s + c] * a + out[d + c] * (255 - a)) / 255);
      }
    }
    return out;
  }
  const off = document.createElement("canvas"), og = off.getContext("2d");
  function draw() {
    const [X0, Y0] = origin();
    vis = { x: Math.floor(-X0 / cell), y: Math.floor(-Y0 / cell) };
    vis.w = Math.ceil((CW - X0) / cell) - vis.x; vis.h = Math.ceil((CH - Y0) / cell) - vis.y;
    const V = vis, c = compose(V), l = L(), f = F(), [lx, ly] = posOf(l);
    const img = new ImageData(V.w, V.h), px = img.data;
    for (let y = 0; y < V.h; y++) for (let x = 0; x < V.w; x++) {
      const i = (y * V.w + x) * 4, wx = V.x + x, wy = V.y + y, inP = inPanel(wx, wy), chk = (wx + wy) & 1;
      if (inP) {
        if (c[i + 3]) { px[i] = c[i]; px[i + 1] = c[i + 1]; px[i + 2] = c[i + 2]; }
        else { const v = chk ? 42 : 29; px[i] = px[i + 1] = px[i + 2] = v; }
      } else {
        let r, gg, b;
        if (c[i + 3]) { r = c[i] * .4; gg = c[i + 1] * .4; b = c[i + 2] * .4; } else { r = gg = b = chk ? 20 : 14; }   // dimmed ...
        const s = sampleIdx(l, f, lx, ly, wx, wy);                                                                       // ... except the selected layer
        if (s >= 0 && f.rgba[s + 3]) { r = f.rgba[s]; gg = f.rgba[s + 1]; b = f.rgba[s + 2]; }
        if (hideOut()) r = gg = b = 8;
        px[i] = r; px[i + 1] = gg; px[i + 2] = b;
      }
      px[i + 3] = 255;
    }
    if (off.width !== V.w || off.height !== V.h) { off.width = V.w; off.height = V.h; }
    og.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#080808"; g.fillRect(0, 0, CW, CH);
    g.drawImage(off, X0 + V.x * cell, Y0 + V.y * cell, V.w * cell, V.h * cell);
    g.save(); g.translate(X0, Y0);   // everything below is drawn in panel coordinates
    if (!playing && $("#onionChk").checked && l.frames.length > 1 && sel[mode].f > 0) {  // previous frame, faint
      const prev = l.frames[sel[mode].f - 1];
      g.globalAlpha = 0.3;
      forEachLayerPixel(l, prev, lx, ly, (x, y, s) => { if (prev.rgba[s + 3]) { g.fillStyle = `rgb(${prev.rgba[s]},${prev.rgba[s + 1]},${prev.rgba[s + 2]})`; g.fillRect(x * cell, y * cell, cell, cell); } });
      g.globalAlpha = 1;
    }
    if (cell >= 8) {
      g.strokeStyle = "rgba(255,255,255,0.07)"; g.lineWidth = 1; g.beginPath();
      for (let x = V.x + 1; x < V.x + V.w; x++) { g.moveTo(x * cell + .5, V.y * cell); g.lineTo(x * cell + .5, (V.y + V.h) * cell); }
      for (let y = V.y + 1; y < V.y + V.h; y++) { g.moveTo(V.x * cell, y * cell + .5); g.lineTo((V.x + V.w) * cell, y * cell + .5); }
      g.stroke();
    }
    g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 2; g.strokeRect(-1, -1, sc.w * cell + 2, sc.h * cell + 2);   // the panel
    if (!playing && !l.tile) {  // selected layer bounds
      g.setLineDash([4, 3]); g.strokeStyle = "#e8a33a"; g.lineWidth = 1.5; g.strokeRect(lx * cell + .5, ly * cell + .5, f.w * cell - 1, f.h * cell - 1); g.setLineDash([]);
    }
    if (drag && (drag.tool === "line" || drag.tool === "shape") && drag.cur) {
      g.fillStyle = drag.erase ? "rgba(255,255,255,.35)" : hex(colorOf(drag.tool)) + "cc";
      if (drag.tool === "shape") shapeCells(drag, (a, b) => g.fillRect(a * cell, b * cell, cell, cell));
      else { const br = brushOf("line", drag.erase); line(drag.x0, drag.y0, drag.cur[0], drag.cur[1], (x, y) => stamp(x, y, br, (a, b) => g.fillRect(a * cell, b * cell, cell, cell))); }
    }
    if (hover && !drag && tool !== "move" && !panMode && !playing) {
      g.strokeStyle = "rgba(255,255,255,.6)"; g.lineWidth = 1;
      const br = brushOf(tool);
      if (usesBrush(tool) && br.size > 1) {   // shade exactly the cells the brush will paint
        g.fillStyle = tool === "eraser" ? "rgba(255,255,255,.22)" : hex(colorOf(tool)) + "66";
        stamp(hover[0], hover[1], br, (a, b) => g.fillRect(a * cell, b * cell, cell, cell));
      } else g.strokeRect(hover[0] * cell + .5, hover[1] * cell + .5, cell - 1, cell - 1);
    }
    g.restore();
  }
  function forEachLayerPixel(l, f, ox, oy, fn) {   // fn(x, y, index) for visible cells (panel coordinates) showing the layer
    for (let y = vis.y; y < vis.y + vis.h; y++) for (let x = vis.x; x < vis.x + vis.w; x++) {
      const s = sampleIdx(l, f, ox, oy, x, y); if (s >= 0) fn(x, y, s);
    }
  }
  function frame(now) {
    if (playing) { t = (now - t0) % loopLen; dirty = true; syncTime(); }
    if (dirty || drag) { draw(); dirty = false; }
    if (stripDirty) { renderStrip(); stripDirty = false; }
    requestAnimationFrame(frame);
  }
  function syncTime() { $("#timeSlider").value = Math.round(t); $("#timeLabel").textContent = (t / 1000).toFixed(2) + " s / " + (loopLen / 1000).toFixed(2) + " s"; }
  function replan() { loopLen = Math.max(100, Scene.plan(sc).length); $("#timeSlider").max = Math.round(loopLen); if (t > loopLen) t = 0; syncTime(); loopHint(); }
  // Does everything fit the loop a whole number of times? Frame sequences and blink cycles that don't would jump
  // at the loop point (moving layers are always adjusted to wrap evenly).
  function loopHint() {
    const len = loopLen, lines = [], bad = [], R = rates();
    let longest = 0, any = false;
    const fit = (name, what, u) => {
      any = true; longest = Math.max(longest, u);
      const n = len / u, whole = Math.abs(n - Math.round(n)) < 1e-6;
      lines.push(`${whole ? "✓" : "✗"} ${name}: ${what} ${(u / 1000).toFixed(2)} s × ${whole ? Math.round(n) : n.toFixed(2)}`);
      if (!whole) bad.push(name);
    };
    for (const l of sc.layers) {
      if (l.visible === false) continue;
      if (l.frames.length > 1 || l.timed) fit(l.name, `${l.frames.length} frames`, Scene.seqTotal(l));
      if (l.blink > 0) fit(l.name, "blink cycle", 2 * Math.max(20, l.blink));
      if (l.speed > 0 && (l.dir[0] || l.dir[1])) {
        any = true;
        const r = R.get(l), f = l.frames[0], d = r ? r * len : 0, whole = (n, w) => !n || Math.abs(d / w - Math.round(d / w)) < 1e-6;
        if (whole(l.dir[0], f.w) && whole(l.dir[1], f.h)) lines.push(`✓ ${l.name}: moves ${(r * 1000).toFixed(1)} px/s, wraps evenly`);
        else { lines.push(`✗ ${l.name}: moving diagonally, a ${f.w}×${f.h} tile doesn't come back round evenly`); bad.push(l.name); }
      }
    }
    const h = $("#loopHint");
    if (!any) { h.textContent = ""; h.title = ""; h.className = "loophint small"; return; }
    if (bad.length) { h.textContent = `⚠ ${bad.join(", ")} won't loop evenly`; h.className = "loophint small warn"; }
    else if (longest && len > longest + 1) { h.textContent = `ⓘ loop stretched to ${(len / 1000).toFixed(2)} s to fit every layer`; h.className = "loophint small info"; }
    else { h.textContent = "✓ loops seamlessly"; h.className = "loophint small ok"; }
    h.title = `Loop ${(len / 1000).toFixed(2)} s\n` + lines.join("\n") + (bad.length ? "\n\nTip: make frame totals and blink cycles (2 × blink) divide evenly into each other. A layer moving diagonally loops best as a square tile (W = H)." : "");
  }

  /* ---------------------------------------------------------------- drawing */
  // screen cell -> pixel index in the selected layer's current frame (or -1)
  function layerIndex(x, y) {
    const l = L(), f = F(), [ox, oy] = posOf(l);
    return sampleIdx(l, f, ox, oy, x, y);
  }
  function setPx(x, y, c) { const i = layerIndex(x, y); if (i >= 0) { F().rgba.set(c, i); touch(); } }
  const usesBrush = tl => tl === "pencil" || tl === "eraser" || tl === "line";
  function stamp(x, y, br, fn) {  // the brush around (x, y); even sizes extend right/down
    const n = br.size, a = Math.floor((n - 1) / 2), b = n - 1 - a, c = (b - a) / 2, r2 = (n * n - n) / 4;
    for (let dy = -a; dy <= b; dy++) for (let dx = -a; dx <= b; dx++) {
      if (br.round && n > 2 && (dx - c) ** 2 + (dy - c) ** 2 > r2) continue;   // round: skip the corners
      fn(x + dx, y + dy);
    }
  }
  const paint = (x, y, c, br) => stamp(x, y, br, (a, b) => setPx(a, b, c));

  /* ---------------------------------------------------------------- tool settings flyout */
  // hover a tool (or click the active one) -> settings to the right of the tool column, over the canvas edge
  // [title, brush size, brush tip, colour, shape options]
  const POP = { pencil: ["Pencil", 1, 1, 1, 0], line: ["Line", 1, 1, 1, 0], shape: ["Shape", 1, 0, 1, 1],
                eraser: ["Eraser", 1, 1, 0, 0], fill: ["Fill", 0, 0, 1, 0] };
  let popTool = null, popTimer = null, pickDragging = false;
  function showPop(tl, btn) {
    const cfg = POP[tl]; if (!cfg) return hidePop(true);
    clearTimeout(popTimer); popTool = tl;
    $("#tpHead").textContent = cfg[0];
    $("#tpBrush").classList.toggle("hidden", !cfg[1] || (tl === "shape" && settings.shape.fill));
    document.querySelectorAll("#toolPop .tptip").forEach(e => e.classList.toggle("hidden", !cfg[2]));
    $("#tpColor").classList.toggle("hidden", !cfg[3]); $("#tpShape").classList.toggle("hidden", !cfg[4]);
    $("#tpSizeLabel").firstChild.textContent = tl === "shape" ? "Outline width " : "Size ";
    syncPop();
    const p = $("#toolPop"), r = btn.getBoundingClientRect();
    p.classList.remove("hidden");
    p.style.left = (r.right + 8) + "px";
    p.style.top = Math.max(8, Math.min(r.top, innerHeight - p.offsetHeight - 8)) + "px";
  }
  function hidePop(now) {
    clearTimeout(popTimer);
    const go = () => {
      if (pickDragging) { popTimer = setTimeout(go, 250); return; }   // still dragging in the colour picker
      $("#toolPop").classList.add("hidden"); $("#colorPick").classList.add("hidden"); popTool = null;
    };
    if (now) go(); else popTimer = setTimeout(go, 250);
  }
  function syncPop() {
    const tl = popTool || tool, col = settings[tl] && settings[tl].color;
    if (col) showColor(col);
    const br = brushOf(tl);
    document.querySelectorAll("#brushSizes [data-size]").forEach(b => b.classList.toggle("active", +b.dataset.size === br.size));
    document.querySelectorAll("#brushShapes [data-shape]").forEach(b => b.classList.toggle("active", (b.dataset.shape === "round") === br.round));
    document.querySelectorAll("#brushSizes i").forEach(i => { i.style.borderRadius = br.round ? "50%" : "0"; });
  }
  function setBrush(n, tl) { tl = tl || popTool || tool; if (!usesBrush(tl) && tl !== "shape") return; settings[tl === "eraser" ? "eraser" : tl].size = n; syncPop(); dirty = true; }
  function syncShape() {
    const s = settings.shape;
    document.querySelectorAll("#shapeKinds [data-kind]").forEach(b => b.classList.toggle("active", b.dataset.kind === s.kind));
    document.querySelectorAll("#shapeStyles [data-fill]").forEach(b => b.classList.toggle("active", (b.dataset.fill === "1") === s.fill));
    $("#shapeGlyph").textContent = { rect: s.fill ? "■" : "▭", oval: s.fill ? "●" : "◯", triangle: s.fill ? "▲" : "△",
                                     diamond: s.fill ? "◆" : "◇", trapezoid: "⏢" }[s.kind];
    if (popTool === "shape") $("#tpBrush").classList.toggle("hidden", s.fill);
  }
  function setShape(r) { brushOf(popTool || tool).round = r; syncPop(); dirty = true; }
  // canvas cursor = the tool itself (pencil, eraser, bucket, dropper) with its tip on the hot spot; line and
  // rectangle keep a "+" for precise placement. "C" in a path is replaced by the current colour.
  const CURSORS = {
    pencil: { hot: [3, 21], paths: ["M3 21l1.2-4.2L14.6 6.4a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L7.2 19.8z|C", "M3 21l1.2-4.2 3 3z|#fff"] },
    eraser: { hot: [6, 18], paths: ["M7.5 19.5L3 15a1.5 1.5 0 0 1 0-2.1l8.9-8.9a1.5 1.5 0 0 1 2.1 0l5 5a1.5 1.5 0 0 1 0 2.1l-8.4 8.4z|#f4f4f4", "M3 15a1.5 1.5 0 0 1 0-2.1l4-4 7 7-4.5 4.5H7.5z|#ff7a9c"] },
    fill:   { hot: [20, 21], paths: ["M2.6 10.2L10 2.8l7.2 7.2-6.6 6.6a1.4 1.4 0 0 1-2 0L2.6 12.2a1.4 1.4 0 0 1 0-2z|#e8e8e8", "M2.6 10.2h14.6L10.6 16.6a1.4 1.4 0 0 1-2 0L2.6 12.2a1.4 1.4 0 0 1 0-2z|C", "M20 14.5c.9 1.6 1.6 2.6 1.6 3.6a1.6 1.6 0 0 1-3.2 0c0-1 .7-2 1.6-3.6z|C"] },
    pick:   { hot: [3, 21], paths: ["M20.4 3.6a2.4 2.4 0 0 0-3.4 0l-2.6 2.6-1.2-1.2-1.6 1.6 6 6 1.6-1.6-1.2-1.2 2.6-2.6a2.4 2.4 0 0 0 0-3.4z|#e8e8e8", "M13 8l-7.6 7.6L3 21l5.4-2.4L16 11z|#ffffff"] },
  };
  function cursorFor(tl) {
    if (tl === "move") return "move";
    const col = hex(colorOf(tl)), cur = CURSORS[tl];
    let svg;
    if (cur) {
      const body = cur.paths.map(p => { const [d, f] = p.split("|"); return `<path d='${d}' fill='${f === "C" ? col : f}'/>`; }).join("");
      // dark outline first, then the coloured shapes on top
      svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><g stroke='#000' stroke-width='3' stroke-linejoin='round'>${body}</g><g stroke='#000' stroke-width='0.9' stroke-linejoin='round'>${body}</g></svg>`;
      return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${cur.hot[0]} ${cur.hot[1]}, crosshair`;
    }
    svg = `<svg xmlns='http://www.w3.org/2000/svg' width='19' height='19'><path d='M9.5 1v17M1 9.5h17' stroke='#000' stroke-width='4.5'/><path d='M9.5 2v15M2 9.5h15' stroke='${col}' stroke-width='2'/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 9 9, crosshair`;
  }
  function getPx(x, y) { const i = layerIndex(x, y); return i < 0 ? null : Array.from(F().rgba.subarray(i, i + 4)).join(); }
  function line(x0, y0, x1, y1, fn) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) { fn(x0, y0); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
  }
  // Shape tool: rectangle, oval, triangle, diamond or trapezoid in the dragged box; outline (thickness = size) or
  // filled. Shift keeps the box square. Cells are tested at their centres.
  const POLYS = { triangle: [[.5, 0], [1, 1], [0, 1]], diamond: [[.5, 0], [1, .5], [.5, 1], [0, .5]],
                  trapezoid: [[.25, 0], [.75, 0], [1, 1], [0, 1]] };
  function inPoly(P, u, v) {
    let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, yi] = P[i], [xj, yj] = P[j];
      if ((yi > v) !== (yj > v) && u < (xj - xi) * (v - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function shapeCells(d, fn) {
    const s = settings.shape;
    let [x1, y1] = d.cur;
    if (d.square) {
      const n = Math.max(Math.abs(x1 - d.x0), Math.abs(y1 - d.y0));
      x1 = d.x0 + (x1 < d.x0 ? -n : n); y1 = d.y0 + (y1 < d.y0 ? -n : n);
    }
    const X = Math.min(d.x0, x1), Y = Math.min(d.y0, y1), W = Math.abs(x1 - d.x0) + 1, H = Math.abs(y1 - d.y0) + 1;
    const inside = (i, j) => {
      if (i < 0 || j < 0 || i >= W || j >= H) return false;
      const u = (i + .5) / W, v = (j + .5) / H;
      if (s.kind === "rect") return true;
      if (s.kind === "oval") return (2 * u - 1) ** 2 + (2 * v - 1) ** 2 <= 1 + 0.6 / Math.max(W, H);
      return inPoly(POLYS[s.kind], u, v);
    };
    const t = Math.max(1, s.size);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (!inside(i, j)) continue;
      let edge = s.fill;
      if (!edge) {   // outline: an outside cell within (Manhattan) distance t
        for (let dj = -t; dj <= t && !edge; dj++) for (let di = -t; di <= t; di++)
          if (Math.abs(di) + Math.abs(dj) <= t && !inside(i + di, j + dj)) { edge = true; break; }
      }
      if (edge) fn(X + i, Y + j);
    }
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
      if (seen.has(k) || seen.size > 70000 || getPx(px, py) !== target) continue;
      seen.add(k); setPx(px, py, c); st.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }
  const canvasPt = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * CW / r.width, (e.clientY - r.top) * CH / r.height]; };
  function cellAt(e) {
    const [X0, Y0] = origin(), [cx, cy] = canvasPt(e);
    return [Math.floor((cx - X0) / cell), Math.floor((cy - Y0) / cell)];
  }
  // pan: middle button, Alt + drag, or the pan button; zoom: mouse wheel (around the cursor)
  cv.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });
  cv.addEventListener("wheel", e => {
    e.preventDefault(); wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 40) return;
    const [ax, ay] = canvasPt(e); zoomStep(wheelAcc < 0 ? 1 : -1, ax, ay); wheelAcc = 0;
  }, { passive: false });
  function setPan(on) { panMode = on; $("#panBtn").classList.toggle("on", on); cv.style.cursor = on ? "grab" : ""; dirty = true; }
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("pointerdown", e => {
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
    if (e.button === 1 || e.altKey || (panMode && e.button === 0)) {
      const [px, py] = canvasPt(e); drag = { tool: "pan", px, py, cx: cam.x, cy: cam.y }; cv.style.cursor = "grabbing"; return;
    }
    if (playing) setPlaying(false);
    const [x, y] = cellAt(e), erase = e.button === 2;
    const tl = erase && (tool === "pencil" || tool === "line") ? "eraser" : tool;
    if (tl === "move") { pushUndo(); drag = { tool: tl, x0: x, y0: y, lx: L().x, ly: L().y }; return; }
    if (tl === "pick") {
      const c = compose({ x, y, w: 1, h: 1 }), i = 0;
      if (c[i + 3]) setColor([c[i], c[i + 1], c[i + 2], 255], colorTool);
      setTool(colorTool); return;
    }
    pushUndo();
    if (tl === "fill") { flood(x, y, colorOf("fill")); useColor(colorOf("fill")); stripDirty = true; return; }
    if (tl === "pencil") useColor(colorOf("pencil"));
    drag = { tool: tl, x0: x, y0: y, last: [x, y], cur: [x, y], erase, square: e.shiftKey };
    if (tl === "pencil" || tl === "eraser") paint(x, y, tl === "eraser" ? ERASE : colorOf("pencil"), brushOf(tl));
  });
  cv.addEventListener("pointermove", e => {
    const [x, y] = cellAt(e);
    hover = [x, y]; $("#cursorPos").textContent = `x ${x}, y ${y}`; dirty = true;
    if (!drag) return;
    if (drag.tool === "pan") { const [px, py] = canvasPt(e); cam = { x: drag.cx - (px - drag.px) / cell, y: drag.cy - (py - drag.py) / cell }; return; }
    if (drag.tool === "move") { L().x = drag.lx + x - drag.x0; L().y = drag.ly + y - drag.y0; touch(); return; }
    if (drag.tool === "pencil" || drag.tool === "eraser") {
      line(drag.last[0], drag.last[1], x, y, (a, b) => paint(a, b, drag.tool === "eraser" ? ERASE : colorOf("pencil"), brushOf(drag.tool)));
      drag.last = [x, y];
    } else { drag.cur = [x, y]; drag.square = e.shiftKey; }
  });
  cv.addEventListener("pointerup", () => {
    if (drag && drag.tool === "pan") { drag = null; cv.style.cursor = panMode ? "grab" : ""; dirty = true; return; }
    if (drag && drag.tool === "line") {
      const c = drag.erase ? ERASE : colorOf("line"), br = brushOf("line", drag.erase);
      line(drag.x0, drag.y0, drag.cur[0], drag.cur[1], (a, b) => paint(a, b, c, br));
      if (!drag.erase) useColor(c);
    }
    if (drag && drag.tool === "shape") {
      const c = drag.erase ? ERASE : colorOf("shape");
      shapeCells(drag, (a, b) => setPx(a, b, c));
      if (!drag.erase) useColor(c);
    }
    if (drag && drag.tool === "move") renderProps();
    drag = null; touch(); stripDirty = true;
  });
  cv.addEventListener("pointerleave", () => { hover = null; dirty = true; $("#cursorPos").textContent = "–"; });

  function setTool(tl) {
    if (panMode) setPan(false);
    tool = tl;
    if (settings[tl] && settings[tl].color) colorTool = tl;
    document.querySelectorAll("#tools [data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === tl));
    cv.style.cursor = cursorFor(tl);
  }
  function setColor(c, tl) {
    tl = tl || popTool || (settings[tool] && settings[tool].color ? tool : colorTool);
    if (!settings[tl] || !settings[tl].color) return;
    settings[tl].color = c;
    if ((popTool || tool) === tl) showColor(c);
    syncTints(); cv.style.cursor = cursorFor(tool); dirty = true;
  }
  // the flyout's colour row: swatch, hex field, inline picker and palette all show the colour being edited
  function showColor(c) {
    const h = hex(c);
    $("#colorSwatch").style.background = h;
    if (document.activeElement !== $("#colorHex")) $("#colorHex").value = h;
    if (!$("#colorPick").classList.contains("hidden")) flyPicker.set(c);
    document.querySelectorAll("#palette button").forEach(b => b.classList.toggle("on", b.dataset.hex === h));
  }
  function renderPalette() {
    const tl = popTool || tool, cur = settings[tl] && settings[tl].color ? hex(settings[tl].color) : "";
    $("#palette").replaceChildren(...paletteColors().map(h => el("button", { style: `background:${h}`, title: h, "data-hex": h, cls: h === cur ? "on" : "",
      onclick: () => setColor([...unhex(h), 255]) })));
  }

  // Colour picker (no native dialog): saturation/brightness square + hue bar. onChange(rgb, done) fires while
  // dragging (done = false) and once on release (done = true).
  function rgb2hsv([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
  }
  function hsv2rgb(h, s, v) {
    const f = n => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
    return [f(5), f(3), f(1)];
  }
  function makePicker(host, onChange) {
    const sv = el("div", { cls: "cp-sv" }), svKnob = el("i", { cls: "cp-knob" }), hue = el("div", { cls: "cp-hue" }), hueKnob = el("i", { cls: "cp-knob" });
    sv.append(svKnob); hue.append(hueKnob); host.replaceChildren(sv, hue);
    let hsv = [0, 1, 1];
    const paint = () => {
      sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv[0]}, 100%, 50%))`;
      svKnob.style.left = hsv[1] * 100 + "%"; svKnob.style.top = (1 - hsv[2]) * 100 + "%";
      hueKnob.style.left = hsv[0] / 360 * 100 + "%";
    };
    const emit = done => onChange([...hsv2rgb(...hsv), 255], done);
    const drag = (area, fn) => {
      const at = e => { const r = area.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))); paint(); };
      let down = false;
      area.addEventListener("pointerdown", e => { pickDragging = down = true; try { area.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ } at(e); emit(false); });
      area.addEventListener("pointermove", e => { if (down) { at(e); emit(false); } });
      area.addEventListener("pointerup", e => { if (!down) return; pickDragging = down = false; at(e); emit(true); });
      area.addEventListener("lostpointercapture", () => { if (down) { pickDragging = down = false; emit(true); } });
    };
    drag(sv, (x, y) => { hsv[1] = x; hsv[2] = 1 - y; });
    drag(hue, x => { hsv[0] = Math.min(359.9, x * 360); });
    return { set(c) { const n = rgb2hsv(c); if (n[1] === 0 || n[2] === 0) n[0] = hsv[0]; hsv = n; paint(); } };
  }
  const flyPicker = makePicker($("#colorPick"), c => setColor(c));
  // background colour: same picker in a small popover next to the swatch
  const bgPop = el("div", { cls: "cpop hidden" }), bgHost = el("div", { cls: "cpick" }), bgHex = el("input", { cls: "hexin", maxlength: "7", spellcheck: "false" });
  bgPop.append(bgHost, el("div", { cls: "row" }, bgHex, el("button", { onclick: () => bgPop.classList.add("hidden") }, "Done")));
  document.body.append(bgPop);
  let bgUndo = false;
  const setBg = (c, done) => {
    if (!bgUndo) { pushUndo(); bgUndo = true; }
    sc.bg = c.slice(0, 3); $("#bgColor").style.background = hex(c); bgHex.value = hex(c); touch();
    if (done) bgUndo = false;
  };
  const bgPicker = makePicker(bgHost, (c, done) => { if (!sc.bg && mode === "icon") { $("#bgNone").checked = false; } setBg(c, done); });
  bgHex.addEventListener("change", () => { const c = parseHex(bgHex.value); if (c) { setBg([...c, 255], true); bgPicker.set(c); } });
  function parseHex(v) {
    let m = String(v).trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(m)) m = m.split("").map(ch => ch + ch).join("");
    return /^[0-9a-f]{6}$/i.test(m) ? unhex("#" + m) : null;
  }
  function syncTints() {   // each tool icon shows its own colour
    document.querySelectorAll("#tools [data-tool]").forEach(b => {
      const s = settings[b.dataset.tool];
      if (s && s.color) b.style.setProperty("--cur", hex(s.color));
    });
  }

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
    if (document.activeElement !== $("#frAllMs")) $("#frAllMs").value = F().delay;
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

  /* ---------------------------------------------------------------- modes */
  function fullRefresh() { layout(); renderLayers(); renderProps(); replan(); stripDirty = true; touch(); renderSceneProps(); }
  function renderSceneProps() {
    $("#bgNone").checked = !sc.bg; $("#bgColor").style.background = sc.bg ? hex(sc.bg) : "repeating-conic-gradient(#3a3a3a 0 25%, #222 0 50%) 0 0 / 8px 8px";
    $("#bgNoneWrap").classList.toggle("hidden", mode !== "icon");
  }
  function setMode(m) {   // m = project type: "anim" (52x32, motion, live preview) or "icon" (any size, frames only)
    mode = m; sc = docs[m];
    const icon = m === "icon";
    $("#iconSizeBtn").classList.toggle("hidden", !icon);
    $("#grabBtn").disabled = icon;
    for (const e of [$("#pTile").closest("label"), $("#dirPad"), $("#pSpeed").closest("label"), $("#pBlink").closest("label"), $("#liveChk").closest("label")])
      e.classList.toggle("hidden", icon);
    if (icon) $("#liveChk").checked = false;
    fullRefresh();
  }
  function setScene(s, m) {
    docs[m] = s; hist[m] = { undo: [], redo: [] }; sel[m] = { l: s.layers.length - 1, f: 0 }; t = 0;
    if (mode !== m) setMode(m); else { sc = s; fullRefresh(); }
  }

  /* ---------------------------------------------------------------- projects: start screen, open, save, send */
  let projects = [];   // [{name, mtime, meta}]
  const lower = a => new Set(a.map(s => s.toLowerCase()));
  function uniqueName(base, taken) { let n = base, i = 2; while (taken.has(n.toLowerCase())) n = `${base} ${i++}`; return n; }
  const takenEverywhere = () => lower([...projects.map(p => p.name), ...lib.anims.map(f => stem(f.name)), ...lib.icons.map(f => stem(f.name))]);
  function remember(name) { try { localStorage.setItem("p2m.lastProject", name); } catch (e) { /* private mode */ } }
  function lastProject() { try { return localStorage.getItem("p2m.lastProject"); } catch (e) { return null; } }

  async function refreshOpenList() {
    try { projects = await api("/scenes"); } catch (e) { projects = []; }
    renderHome();
  }
  function ago(sec) {
    const d = Date.now() / 1000 - sec;
    return d < 90 ? "just now" : d < 3600 ? Math.round(d / 60) + " min ago" : d < 86400 ? Math.round(d / 3600) + " h ago" : Math.round(d / 86400) + " days ago";
  }
  function projectMeta(p) {   // older saved scenes (before projects) were always sent to the display too
    if (p.meta && p.meta.type) return p.meta;
    const onDisplay = lib.anims.some(f => stem(f.name) === p.name);
    return { type: p.w === PW && p.h === PH && p.bg ? "anim" : "icon", rev: 0, sent: onDisplay ? { as: p.name, rev: 0 } : null };
  }
  function renderHome() {
    const sel = $("#fromDisplaySel");
    sel.replaceChildren(...(lib.anims.length ? lib.anims.map(f => el("option", { value: stem(f.name) }, stem(f.name)))
      : [el("option", { value: "" }, cur ? "(no animations on the display)" : "(adopt a display first)")]));
    const list = [...projects].sort((a, b) => b.mtime - a.mtime);
    $("#projList").replaceChildren(...(list.length ? list.map(p => {
      const m = projectMeta(p), [st, cls] = statusOf(p.name, m, false);
      return el("div", { cls: "projrow" },
        el("span", { cls: "badge" }, m.type === "icon" ? `Icon ${p.w}×${p.h}` : "Animation"),
        el("button", { cls: "projname", title: "Open", onclick: () => openProject(p.name) }, p.name),
        el("span", { cls: "chip " + cls }, st), el("span", { cls: "muted small" }, ago(p.mtime)),
        el("button", { title: "Open", onclick: () => openProject(p.name) }, "Open"),
        el("button", { title: "Delete this project (what's on the display stays)", onclick: () => deleteProject(p.name) }, "🗑"));
    }) : [el("p", { cls: "muted" }, "No projects yet. Start a new one above.")]));
    const last = lastProject();
    $("#continueRow").replaceChildren(...(last && projects.some(p => p.name === last) && !proj.open
      ? [el("button", { cls: "primary", onclick: () => openProject(last) }, `Continue “${last}”`)] : []));
  }
  function showHome(on) {
    $("#projHome").classList.toggle("hidden", !on); $("#editorMain").classList.toggle("hidden", on);
    if (on) { setPlaying(false); $("#liveChk").checked = false; renderHome(); } else layout();
  }
  async function leaveProject() {   // everything is saved, so leaving never loses work
    if (proj.open && proj.edited) { try { await saveProject(true); } catch (e) { return ask(`Couldn't save "${proj.name}" (${e.message}). Leave anyway?`, { ok: "Leave", danger: true }); } }
    return true;
  }
  function load(s, type, name, rev, sent) {
    setPlaying(false);
    Object.assign(proj, { open: true, name, type, rev, sent, edited: false });
    setScene(s, type); syncDoc(); remember(name); showHome(false);
  }
  async function openProject(name) {
    if (!await leaveProject()) return;
    try {
      const s = Scene.fromJSON(await api(`/scenes/${enc(name)}`)), m = projectMeta({ ...s, name, meta: s.meta });
      load(s, m.type, name, m.rev || 0, m.sent || null);
    } catch (e) { toast(e.message, true); }
  }
  async function newProject(type) {
    if (!await leaveProject()) return;
    let w = PW, h = PH;
    if (type === "icon") {
      let v = $("#newIconSize").value;
      if (v === "custom") { v = await askText("Icon size, width × height (up to 52×32)", "16x16", { ok: "Create" }); if (!v) return; }
      const m = v.match(/(\d+)\s*[x×*]\s*(\d+)/i); if (!m) return toast("Size like 16x16", true);
      w = Math.max(1, Math.min(PW, +m[1])); h = Math.max(1, Math.min(PH, +m[2]));
    }
    await refreshOpenList();
    const s = type === "icon" ? Scene.newScene(w, h, null) : Scene.newScene(PW, PH, [0, 0, 0]);
    load(s, type, uniqueName(type === "icon" ? "Untitled icon" : "Untitled animation", lower(projects.map(p => p.name))), 0, null);
    markEdited(); await saveProject(true);
  }
  async function openAnim(name) {   // an animation on the display -> a new project "<name> (copy)"
    if (!cur) return toast("Adopt a display first", true);
    if (!name || !await leaveProject()) return;
    try {
      toast("Opening " + name + "…");
      await refreshOpenList();
      const s = Scene.fromJSON(await api(`/displays/${cur}/scene?anim=${enc(name)}`)), copy = uniqueName(`${name} (copy)`, takenEverywhere());
      load(s, "anim", copy, 0, null); markEdited(); await saveProject(true);
      toast(`Opened a copy of "${name}" as "${copy}". The original on the display isn't touched.`);
    } catch (e) { toast(e.message, true); }
  }
  async function saveProject(quiet) {
    if (!proj.open) return;
    if (proj.edited) proj.rev++;
    sc.meta = { type: proj.type, rev: proj.rev, sent: proj.sent };
    const was = proj.edited; proj.edited = false; syncDoc();
    try {
      await api(`/scenes/${enc(proj.name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: Scene.toJSON(sc) });
    } catch (e) { if (was) markEdited(); throw e; }
    remember(proj.name);
    if (!quiet) toast(`Saved project "${proj.name}"`);
    refreshOpenList();
  }
  async function sendToDisplay() {
    if (!cur) return toast("Adopt a display first", true);
    const kind = proj.type === "icon" ? "icons" : "anims", ext = kind === "icons" ? ".pxi" : ".anim";
    const ours = proj.sent && proj.sent.as === proj.name;
    if (lib[kind].some(f => f.name === proj.name + ext) && !ours &&
        !await ask(`"${proj.name}" is already on the display, and it wasn't made from this project.\n\nReplace it with this project?`, { ok: "Replace", danger: true })) return;
    try {
      await saveProject(true);
      const { frames } = Scene.bake(sc, 450);
      const body = proj.type === "icon" ? Scene.buildPXI(frames.slice(0, 64), sc.w, sc.h) : Scene.buildPXA(frames, sc.w, sc.h);
      const r = await postRaw(`/displays/${cur}/upload?kind=${kind}&name=${enc(proj.name)}`, body);
      proj.sent = { as: stem(r.name), rev: proj.rev };
      await saveProject(true);
      toast(`"${stem(r.name)}" is on the display` + (proj.type === "icon" ? " (icon library)" : ` (${frames.length} frame${frames.length > 1 ? "s" : ""})`));
      if (proj.type === "icon") iconCache.clear();
      await loadLibrary(); refreshStorage();
    } catch (e) { toast(e.message, true); }
  }
  async function renameProject() {
    const n = await askText("Project name", proj.name, { ok: "Rename" }); if (n === null) return;
    const name = n.trim().replace(/[\\/"\x00-\x1f]+/g, " ").trim(); if (!name || name === proj.name) return;
    await refreshOpenList();
    if (projects.some(p => p.name.toLowerCase() === name.toLowerCase()) && !await ask(`A project called "${name}" already exists. Replace it?`, { ok: "Replace", danger: true })) return;
    const old = proj.name; proj.name = name; markEdited();
    try { await saveProject(true); await api(`/scenes/${enc(old)}`, { method: "DELETE" }); toast(`Renamed to "${name}"`); refreshOpenList(); }
    catch (e) { proj.name = old; syncDoc(); toast(e.message, true); }
  }
  async function deleteProject(name) {
    if (!await ask(`Delete the project "${name}"? This can't be undone. Anything already sent to the display stays there.`, { ok: "Delete", danger: true })) return;
    try {
      await api(`/scenes/${enc(name)}`, { method: "DELETE" });
      if (proj.open && proj.name === name) { proj.open = false; proj.edited = false; showHome(true); }
      toast(`Deleted project "${name}"`); refreshOpenList();
    } catch (e) { toast(e.message, true); }
  }
  async function duplicateProject() {
    await saveProject(true);
    const name = uniqueName(`${proj.name} (copy)`, takenEverywhere());
    Object.assign(proj, { name, sent: null, rev: 0 }); markEdited(); await saveProject(true); remember(name);
    toast(`Now editing the copy "${name}"`);
  }
  function exportProject() {
    sc.meta = { type: proj.type, rev: proj.rev, sent: null };
    const b = new Blob([Scene.toJSON(sc)], { type: "application/json" });
    el("a", { href: URL.createObjectURL(b), download: proj.name + ".pixel2mqtt.json" }).click();
  }
  async function importProject(file) {
    if (!await leaveProject()) return;
    try {
      const s = Scene.fromJSON(await file.text()), m = projectMeta({ ...s, name: "", meta: s.meta });
      await refreshOpenList();
      const name = uniqueName(file.name.replace(/(\.pixel2mqtt)?\.json$/i, "") || "Imported", lower(projects.map(p => p.name)));
      load(s, m.type, name, 0, null); markEdited(); await saveProject(true);
      toast(`Imported "${name}"`);
    } catch (e) { toast("Not a pixel2mqtt project file: " + e.message, true); }
  }
  setInterval(() => { if (proj.open && proj.edited && !drag) saveProject(true).catch(() => {}); }, 5000);   // autosave
  document.addEventListener("visibilitychange", () => { if (document.hidden && proj.open && proj.edited) saveProject(true).catch(() => {}); });

  async function addIconLayer(name) {
    if (!name) return;
    if (!proj.open || proj.type !== "anim") await newProject("anim");
    if (!proj.open) return;
    try {
      const ic = await getIcon(name);
      const l = Scene.newLayer(ic.w, ic.h, name);
      l.frames = ic.frames.map(f => ({ w: ic.w, h: ic.h, delay: f.delay, rgba: new Uint8ClampedArray(f.rgba) }));
      l.x = Math.floor((sc.w - ic.w) / 2); l.y = Math.floor((sc.h - ic.h) / 2);
      addLayer(l); setTool("move");
    } catch (e) { toast(e.message, true); }
  }
  async function editIcon(name) {   // an icon from the library -> a new icon project "<name> (copy)"
    if (!await leaveProject()) return;
    try {
      const ic = await getIcon(name), s = Scene.newScene(ic.w, ic.h, null);
      s.layers[0].name = name;
      s.layers[0].frames = ic.frames.map(f => ({ w: ic.w, h: ic.h, delay: f.delay, rgba: new Uint8ClampedArray(f.rgba) }));
      await refreshOpenList();
      const copy = uniqueName(`${name} (copy)`, takenEverywhere());
      load(s, "icon", copy, 0, null); markEdited(); await saveProject(true); showTab("editor");
      toast(`Editing a copy of the icon "${name}" as "${copy}"`);
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
  $("#lyClear").addEventListener("click", e => {
    pushUndo();
    for (const f of e.shiftKey ? L().frames : [F()]) f.rgba.fill(0);
    stripDirty = true; touch(); toast(e.shiftKey ? "Cleared all frames of " + L().name : "Cleared this frame");
  });
  $("#pScale").addEventListener("click", () => {
    const w = Math.max(1, Math.min(256, +$("#pW").value | 0)), h = Math.max(1, Math.min(256, +$("#pH").value | 0));
    pushUndo();
    for (const f of L().frames) {   // nearest-neighbour, so pixel art stays crisp
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = (Math.floor(y * f.h / h) * f.w + Math.floor(x * f.w / w)) * 4;
        px.set(f.rgba.subarray(s, s + 4), (y * w + x) * 4);
      }
      f.w = w; f.h = h; f.rgba = px;
    }
    delete L().span; renderProps(); stripDirty = true; replan(); touch();
  });
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
  $("#frAllBtn").addEventListener("click", () => {   // one duration for every frame of the selected layer
    const ms = Math.max(20, Math.min(10000, Math.round(+$("#frAllMs").value || 100)));
    frOp(l => { for (const f of l.frames) f.delay = ms; });
    toast(`All ${L().frames.length} frames of "${L().name}" now last ${ms} ms`);
  });
  $("#frAllMs").addEventListener("keydown", e => { if (e.key === "Enter") $("#frAllBtn").click(); });
  $("#frAdd").addEventListener("click", () => frOp((l, s) => { const f = F(); l.frames.splice(s.f + 1, 0, { w: f.w, h: f.h, delay: f.delay, rgba: new Uint8ClampedArray(f.w * f.h * 4) }); s.f++; }));
  $("#frDup").addEventListener("click", () => frOp((l, s) => { const f = F(); l.frames.splice(s.f + 1, 0, { w: f.w, h: f.h, delay: f.delay, rgba: f.rgba.slice() }); s.f++; }));
  $("#frDel").addEventListener("click", () => { if (L().frames.length < 2) return toast("A layer needs at least one frame", true); frOp((l, s) => { l.frames.splice(s.f, 1); s.f = Math.max(0, s.f - 1); }); });
  $("#frLeft").addEventListener("click", () => { if (sel[mode].f > 0) frOp((l, s) => { [l.frames[s.f - 1], l.frames[s.f]] = [l.frames[s.f], l.frames[s.f - 1]]; s.f--; }); });
  $("#frRight").addEventListener("click", () => { if (sel[mode].f < L().frames.length - 1) frOp((l, s) => { [l.frames[s.f + 1], l.frames[s.f]] = [l.frames[s.f], l.frames[s.f + 1]]; s.f++; }); });
  // Shift: move a frame's pixels (wrapping round, or falling off the edge), or add a run of frames that each move a
  // step further: scrolling textures, rivers, clouds, conveyor belts. With wrap on, the run loops seamlessly once
  // it has gone all the way round (fit loop).
  function shifted(f, dx, dy, wrap) {
    const out = new Uint8ClampedArray(f.rgba.length);
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      let sx = x - dx, sy = y - dy;
      if (wrap) { sx = ((sx % f.w) + f.w) % f.w; sy = ((sy % f.h) + f.h) % f.h; }
      else if (sx < 0 || sy < 0 || sx >= f.w || sy >= f.h) continue;
      const s = (sy * f.w + sx) * 4; out.set(f.rgba.subarray(s, s + 4), (y * f.w + x) * 4);
    }
    return out;
  }
  function shiftPixels(dx, dy) {
    const all = $("#shiftScope").value === "all", wrap = $("#shiftWrap").checked;
    frOp(l => { for (const f of all ? l.frames : [F()]) f.rgba = shifted(f, dx, dy, wrap); });
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
  function loopCount() {   // frames until the shifted copies come back round to the start
    const f = F(), dx = Math.round(+$("#genDx").value || 0), dy = Math.round(+$("#genDy").value || 0);
    const nx = dx ? f.w / gcd(f.w, Math.abs(dx)) : 1, ny = dy ? f.h / gcd(f.h, Math.abs(dy)) : 1;
    return nx / gcd(nx, ny) * ny;
  }
  document.querySelectorAll("#shiftBar [data-sx]").forEach(b => b.addEventListener("click", () => shiftPixels(+b.dataset.sx, +b.dataset.sy)));
  $("#frShiftBtn").addEventListener("click", () => { $("#shiftBar").classList.toggle("hidden"); $("#frShiftBtn").classList.toggle("on"); });
  $("#genFit").addEventListener("click", () => {
    const n = loopCount() - 1;
    if (n < 1) return toast("Set a step (x or y) first", true);
    $("#genN").value = n; $("#shiftWrap").checked = true;
    toast(`${n + 1} frames in total: the last one flows back into this one`);
  });
  $("#genBtn").addEventListener("click", () => {
    const n = Math.max(1, Math.min(256, Math.round(+$("#genN").value || 1)));
    const dx = Math.round(+$("#genDx").value || 0), dy = Math.round(+$("#genDy").value || 0), wrap = $("#shiftWrap").checked;
    if (!dx && !dy) return toast("Set a step (x or y) for each frame", true);
    const src = F();
    frOp((l, s) => {
      const fr = [];
      for (let k = 1; k <= n; k++) fr.push({ w: src.w, h: src.h, delay: src.delay, rgba: shifted(src, k * dx, k * dy, wrap) });
      l.frames.splice(s.f + 1, 0, ...fr);
    });
    toast(`Added ${n} frames to "${L().name}", each moved ${dx}, ${dy}`);
  });

  $("#playBtn").addEventListener("click", () => setPlaying(!playing));
  $("#timeSlider").addEventListener("input", e => { if (playing) setPlaying(false); t = +e.target.value; syncTime(); touch(); });
  $("#onionChk").addEventListener("change", () => { dirty = true; });
  $("#vpOnly").addEventListener("change", () => { dirty = true; });
  $("#zoomIn").addEventListener("click", () => zoomStep(1));
  $("#zoomOut").addEventListener("click", () => zoomStep(-1));
  $("#recenterBtn").addEventListener("click", recenter);
  $("#panBtn").addEventListener("click", () => setPan(!panMode));
  let lastBg = [0, 0, 0];
  $("#bgNone").addEventListener("change", e => { pushUndo(); if (sc.bg) lastBg = sc.bg; sc.bg = e.target.checked ? null : lastBg; renderSceneProps(); touch(); });
  $("#iconSizeBtn").addEventListener("click", async () => {
    closeMenus();
    const v = await askText("Icon size, width × height (up to 52×32). Layers keep their pixels.", `${sc.w}x${sc.h}`, { ok: "Resize" }); if (!v) return;
    const m = v.match(/(\d+)\s*[x×*]\s*(\d+)/i); if (!m) return toast("Size like 16x16", true);
    pushUndo(); sc.w = Math.max(1, Math.min(PW, +m[1])); sc.h = Math.max(1, Math.min(PH, +m[2])); fullRefresh(); syncDoc();
  });
  function closeMenus() { $("#docMore").classList.add("hidden"); }
  $("#docMoreBtn").addEventListener("click", e => { e.stopPropagation(); const open = $("#docMore").classList.contains("hidden"); closeMenus(); if (open) $("#docMore").classList.remove("hidden"); });
  document.addEventListener("click", closeMenus);
  $("#homeBtn").addEventListener("click", async () => { if (await leaveProject()) { proj.open = false; showHome(true); refreshOpenList(); } });
  $("#docBtn").addEventListener("click", renameProject);
  $("#saveBtn").addEventListener("click", () => saveProject(false).catch(e => toast(e.message, true)));
  $("#sendBtn").addEventListener("click", sendToDisplay);
  $("#dupBtn").addEventListener("click", () => { closeMenus(); duplicateProject().catch(e => toast(e.message, true)); });
  $("#exportBtn").addEventListener("click", () => { closeMenus(); exportProject(); });
  $("#delProjBtn").addEventListener("click", () => { closeMenus(); deleteProject(proj.name); });
  $("#newAnimBtn").addEventListener("click", () => newProject("anim"));
  $("#newIconBtn").addEventListener("click", () => newProject("icon"));
  $("#fromDisplayBtn").addEventListener("click", () => openAnim($("#fromDisplaySel").value));
  $("#importProj").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) importProject(f); });
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
    c.toBlob(b => el("a", { href: URL.createObjectURL(b), download: (proj.name || "pixel") + ".png" }).click());
  });
  document.querySelectorAll("#tools [data-tool]").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
  document.querySelectorAll("#brushSizes [data-size]").forEach(b => b.addEventListener("click", () => setBrush(+b.dataset.size)));
  document.querySelectorAll("#brushShapes [data-shape]").forEach(b => b.addEventListener("click", () => setShape(b.dataset.shape === "round")));
  document.querySelectorAll("#shapeKinds [data-kind]").forEach(b => b.addEventListener("click", () => { settings.shape.kind = b.dataset.kind; syncShape(); }));
  document.querySelectorAll("#shapeStyles [data-fill]").forEach(b => b.addEventListener("click", () => { settings.shape.fill = b.dataset.fill === "1"; syncShape(); }));
  // The flyout opens after a short hover (so passing over a button on the way to the canvas doesn't open it), or
  // at once when moving between buttons while it's already open. Clicking a tool only selects it; on touch
  // screens, tapping the tool that's already selected toggles the flyout.
  let hoverTimer = null;
  const popOpen = () => !$("#toolPop").classList.contains("hidden");
  document.querySelectorAll("#tools [data-tool]").forEach(b => {
    const t = b.dataset.tool;
    b.addEventListener("mouseenter", () => {
      clearTimeout(hoverTimer);
      if (popOpen()) showPop(t, b); else hoverTimer = setTimeout(() => showPop(t, b), 350);
    });
    b.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); hidePop(); });
    b.addEventListener("pointerdown", e => { b.tapToggle = e.pointerType !== "mouse" && tool === t; });   // touch only
    b.addEventListener("click", () => {
      clearTimeout(hoverTimer);
      if (b.tapToggle && POP[t] && !popOpen()) showPop(t, b); else hidePop(true);
    });
  });
  $("#toolPop").addEventListener("mouseenter", () => clearTimeout(popTimer));
  $("#toolPop").addEventListener("mouseleave", () => hidePop());
  cv.addEventListener("pointerdown", () => hidePop(true));
  $("#undoBtn").addEventListener("click", undo);
  $("#redoBtn").addEventListener("click", redo);
  $("#colorSwatch").addEventListener("click", () => {
    const p = $("#colorPick"), open = p.classList.toggle("hidden") === false;
    if (open) { const tl = popTool || tool; flyPicker.set(colorOf(tl)); }
  });
  $("#colorHex").addEventListener("change", e => { const c = parseHex(e.target.value); if (c) setColor([...c, 255]); else showColor(colorOf(popTool || tool)); });
  $("#colorHex").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
  renderPalette();
  $("#bgColor").addEventListener("click", e => {
    e.stopPropagation();
    if (!bgPop.classList.contains("hidden")) return bgPop.classList.add("hidden");
    const c = sc.bg || [0, 0, 0]; bgPicker.set(c); bgHex.value = hex(c);
    const r = e.currentTarget.getBoundingClientRect();
    bgPop.classList.remove("hidden");
    bgPop.style.left = Math.max(8, Math.min(r.left - 40, innerWidth - bgPop.offsetWidth - 8)) + "px";
    bgPop.style.top = Math.min(r.bottom + 6, innerHeight - bgPop.offsetHeight - 8) + "px";
  });
  bgPop.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", () => { if (!bgPop.classList.contains("hidden")) { bgPop.classList.add("hidden"); if (sc.bg) useColor(sc.bg); } });
  document.addEventListener("keydown", e => {
    if ((e.target.matches && e.target.matches("input, select, textarea")) || !$("#tab-editor").classList.contains("active")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
    if (k === " ") { e.preventDefault(); setPlaying(!playing); return; }
    if (k === "[" || k === "]") {  // brush size down/up
      const br = brushOf(tool), i = BRUSHES.indexOf(br.size) + (k === "]" ? 1 : -1);
      return setBrush(BRUSHES[Math.max(0, Math.min(BRUSHES.length - 1, i))], tool);
    }
    const tools = { p: "pencil", e: "eraser", f: "fill", l: "line", s: "shape", r: "shape", i: "pick", m: "move" };
    if (tools[k] && !e.ctrlKey && !e.metaKey) return setTool(tools[k]);
    if (k === "h" && !e.ctrlKey && !e.metaKey) return setPan(!panMode);
    if ((k === "+" || k === "=") && !e.ctrlKey && !e.metaKey) return zoomStep(1);
    if (k === "-" && !e.ctrlKey && !e.metaKey) return zoomStep(-1);
    if (k === "0" && !e.ctrlKey && !e.metaKey) return recenter();
    if (k.startsWith("arrow") && e.shiftKey) {   // Shift + arrows: nudge the pixels of the frame (see the shift bar)
      e.preventDefault();
      return shiftPixels(k === "arrowleft" ? -1 : k === "arrowright" ? 1 : 0, k === "arrowup" ? -1 : k === "arrowdown" ? 1 : 0);
    }
    if (k.startsWith("arrow") && tool === "move") {
      e.preventDefault(); pushUndo(); const l = L();
      l.x += k === "arrowleft" ? -1 : k === "arrowright" ? 1 : 0; l.y += k === "arrowup" ? -1 : k === "arrowdown" ? 1 : 0;
      renderProps(); touch();
    }
  });

  syncTints(); syncShape(); setTool("pencil"); setMode("anim"); showHome(true); requestAnimationFrame(frame); refreshOpenList();
  return { addIconLayer, editIcon, openAnim, refreshOpenList };
})();
