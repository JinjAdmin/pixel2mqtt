// scene.js - layered animation model, renderer and baker (browser + Node). No dependencies.
//
// A scene is a background colour plus a stack of layers (index 0 = bottom). Every layer has one or more frames
// (each with its own size and duration), a position, optional motion (direction + speed, whole-pixel steps),
// tiling (wrap around, like Govee's scrolling backgrounds), opacity and blink. The semantics mirror
// pixeld-h6631/tools/graffiti.py exactly, so Govee scenes imported as layers bake to the same frames.
//
// scene = { w, h, bg: [r,g,b] | null (transparent, icons), layers: [layer] }
// layer = { name, visible, x, y, tile, dir: [dx,dy] (-1/0/1), speed (px/s), span?, timed? (imported Govee scenes),
//           opacity (0-100), blink (ms, 0 = off), frames: [{ w, h, delay (ms), rgba: Uint8ClampedArray }] }
(function (root) {
  "use strict";
  const MAX_FRAMES = 600, MIN_DELAY = 20;

  // Python's round(): half to even (graffiti.py uses it for loop fitting and delays)
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  const mod = (a, n) => ((a % n) + n) % n;

  function newLayer(w, h, name) {
    return { name: name || "Layer", visible: true, x: 0, y: 0, tile: false, dir: [0, 0], speed: 0, opacity: 100, blink: 0,
      frames: [{ w, h, delay: 100, rgba: new Uint8ClampedArray(w * h * 4) }] };
  }
  function newScene(w, h, bg) { return { w, h, bg: bg === undefined ? [0, 0, 0] : bg, layers: [newLayer(w, h, "Layer 1")] }; }

  const seqTotal = l => l.frames.reduce((a, f) => a + Math.max(MIN_DELAY, f.delay), 0);
  const moving = l => l.speed > 0 && (l.dir[0] || l.dir[1]);
  function span(l) {
    if (l.span) return l.span;
    const f = l.frames[0];
    return Math.max(l.dir[0] ? f.w : 0, l.dir[1] ? f.h : 0);
  }

  // loop length (ms) and per-layer rates (px/ms) tuned so every mover wraps a whole number of times per loop
  function plan(scene) {
    const layers = scene.layers.filter(l => l.visible !== false);
    const rates = new Map(), seqs = [], blinks = [];
    let length = 0;
    for (const l of layers) {
      if (l.frames.length > 1 || l.timed) seqs.push(seqTotal(l));  // timed: imported Govee frame group (even of 1)
      if (l.blink > 0) blinks.push(2 * Math.max(MIN_DELAY, l.blink));
      if (moving(l)) { const r = l.speed / 1000; rates.set(l, r); length = Math.max(length, span(l) / r); }
    }
    for (const s of seqs) length = Math.max(length, s);
    for (const b of blinks) length = Math.max(length, b);
    if (length <= 0) length = 1000;
    // loop unit: every frame sequence and blink cycle must repeat a whole number of times. graffiti.py used the
    // largest one (its scenes never mix them); the least common multiple is the same then and also covers mixes.
    const units = seqs.concat(blinks).map(u => Math.round(u));
    const gcd = (x, y) => (y ? gcd(y, x % y) : x);
    let unit = units.length ? units.reduce((x, y) => x / gcd(x, y) * y) : 0;
    if (unit > 20000) unit = Math.max(...units);  // keep loops short; a rare long mix may then not loop perfectly
    if (unit) length = Math.ceil(Math.trunc(length) / unit) * unit;
    for (const [l, r] of rates) {
      const s = span(l), wraps = Math.max(1, pyRound(length * r / s));
      rates.set(l, wraps * s / length);
    }
    let tick = 33;
    const multi = layers.filter(l => l.frames.length > 1 || l.timed);
    if (multi.length) tick = Math.max(MIN_DELAY, Math.min(tick, ...multi.map(l => Math.min(...l.frames.map(f => Math.max(MIN_DELAY, f.delay))))));
    return { length, rates, tick };
  }

  function frameAt(l, t) {
    if (l.frames.length === 1) return l.frames[0];
    let tt = t % seqTotal(l);
    for (const f of l.frames) { const d = Math.max(MIN_DELAY, f.delay); if (tt < d) return f; tt -= d; }
    return l.frames[l.frames.length - 1];
  }

  function layerPos(l, t, rate) {
    const r = rate === undefined ? l.speed / 1000 : rate;
    if (!moving(l) || !r) return [l.x, l.y];
    const k = Math.floor(t * r);
    return [l.x + l.dir[0] * k, l.y + l.dir[1] * k];
  }

  // composite RGBA (scene.w x scene.h) at time t (ms). rates: from plan() for baking; omitted = raw speeds.
  function render(scene, t, rates, out) {
    const W = scene.w, H = scene.h, px = out || new Uint8ClampedArray(W * H * 4);
    if (scene.bg) for (let i = 0; i < W * H; i++) { px[i * 4] = scene.bg[0]; px[i * 4 + 1] = scene.bg[1]; px[i * 4 + 2] = scene.bg[2]; px[i * 4 + 3] = 255; }
    else px.fill(0);
    for (const l of scene.layers) {
      if (l.visible === false) continue;
      if (l.blink > 0 && Math.floor(t / Math.max(MIN_DELAY, l.blink)) % 2) continue;
      const f = frameAt(l, t), [ox, oy] = layerPos(l, t, rates ? rates.get(l) : undefined);
      const op = Math.min(100, l.opacity === undefined ? 100 : l.opacity);
      for (let y = 0; y < H; y++) {
        let sy = y - oy;
        if (l.tile) sy = mod(sy, f.h); else if (sy < 0 || sy >= f.h) continue;
        for (let x = 0; x < W; x++) {
          let sx = x - ox;
          if (l.tile) sx = mod(sx, f.w); else if (sx < 0 || sx >= f.w) continue;
          const s = (sy * f.w + sx) * 4, a = Math.floor(f.rgba[s + 3] * op / 100);
          if (!a) continue;
          const d = (y * W + x) * 4;
          if (a === 255 || !px[d + 3]) { px[d] = f.rgba[s]; px[d + 1] = f.rgba[s + 1]; px[d + 2] = f.rgba[s + 2]; px[d + 3] = Math.max(px[d + 3], a); }
          else for (let c = 0; c < 3; c++) px[d + c] = Math.floor((f.rgba[s + c] * a + px[d + c] * (255 - a)) / 255);
        }
      }
    }
    return px;
  }

  // bake to frames [{delay, rgba}] covering one seamless loop (identical neighbours merged unless merge=false)
  function bake(scene, maxFrames, merge) {
    const vis = scene.layers.filter(l => l.visible !== false), multi = vis.filter(l => l.frames.length > 1);
    if (multi.length === 1 && !multi[0].timed && !vis.some(l => moving(l) || l.blink > 0 || l.timed)) {
      // only one layer animates and nothing moves/blinks: keep its own frames and durations exactly
      const l = multi[0], out = [];
      let t = 0;
      for (const f of l.frames) { const d = Math.max(MIN_DELAY, f.delay); out.push({ delay: d, rgba: render(scene, t) }); t += d; }
      return { frames: out.slice(0, MAX_FRAMES), length: t };
    }
    const { length, rates, tick } = plan(scene);
    const n = Math.trunc(Math.min(maxFrames || 450, Math.max(1, Math.floor(length / tick))));
    const step = length / n, out = [];
    for (let f = 0; f < n; f++) {
      const rgba = render(scene, f * step, rates), delay = pyRound((f + 1) * step) - pyRound(f * step);
      const last = out[out.length - 1];
      if (merge !== false && last && last.delay + delay <= 10000 && same(last.rgba, rgba)) last.delay += delay; else out.push({ delay, rgba });
    }
    return { frames: out.slice(0, MAX_FRAMES), length };
  }
  function same(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

  // RGBA (scene size) -> RGB for the 52x32 panel (smaller canvases are centred; alpha < 128 = black)
  function toPanel(rgba, w, h) {
    const PW = 52, PH = 32, rgb = new Uint8Array(PW * PH * 3), ox = Math.floor((PW - w) / 2), oy = Math.floor((PH - h) / 2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const X = x + ox, Y = y + oy; if (X < 0 || Y < 0 || X >= PW || Y >= PH) continue;
      const s = (y * w + x) * 4; if (rgba[s + 3] < 128) continue;
      rgb.set([rgba[s], rgba[s + 1], rgba[s + 2]], (Y * PW + X) * 3);
    }
    return rgb;
  }

  function buildPXA(frames, w, h) {  // frames: [{delay, rgba}] at 52x32
    const FR = 52 * 32 * 3, out = new Uint8Array(6 + frames.length * (2 + FR)), dv = new DataView(out.buffer);
    out.set([80, 88, 65, 49]); dv.setUint16(4, frames.length, true);
    let o = 6;
    for (const f of frames) {
      dv.setUint16(o, Math.min(10000, Math.max(MIN_DELAY, Math.round(f.delay))), true);
      out.set(w === 52 && h === 32 ? rgbOf(f.rgba) : toPanel(f.rgba, w, h), o + 2); o += 2 + FR;
    }
    return out;
  }
  function rgbOf(rgba) { const rgb = new Uint8Array(rgba.length / 4 * 3); for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; } return rgb; }

  function buildPXI(frames, w, h) {  // frames: [{delay, rgba}] at w x h; alpha snapped to 0/255
    const out = new Uint8Array(8 + frames.length * (2 + w * h * 4)), dv = new DataView(out.buffer);
    out.set([80, 88, 73, 49]); out[4] = w; out[5] = h; dv.setUint16(6, frames.length, true);
    let o = 8;
    for (const f of frames) {
      dv.setUint16(o, Math.min(60000, Math.max(MIN_DELAY, Math.round(f.delay))), true);
      const px = f.rgba.slice(); for (let i = 3; i < px.length; i += 4) px[i] = px[i] >= 128 ? 255 : 0;
      out.set(px, o + 2); o += 2 + w * h * 4;
    }
    return out;
  }

  // JSON (base64 pixels) <-> live objects
  function b64(u8) { if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64"); let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { if (typeof Buffer !== "undefined") return new Uint8ClampedArray(Buffer.from(s, "base64")); const b = atob(s), u = new Uint8ClampedArray(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function toJSON(scene) {
    return JSON.stringify({ version: 1, w: scene.w, h: scene.h, bg: scene.bg, meta: scene.meta, layers: scene.layers.map(l => Object.assign({}, l, {
      frames: l.frames.map(f => ({ w: f.w, h: f.h, delay: f.delay, rgba: b64(f.rgba) })) })) });
  }
  function fromJSON(text) {
    const s = typeof text === "string" ? JSON.parse(text) : text;
    for (const l of s.layers) {
      l.visible = l.visible !== false; l.x = l.x || 0; l.y = l.y || 0; l.dir = l.dir || [0, 0]; l.speed = l.speed || 0;
      l.opacity = l.opacity === undefined ? 100 : l.opacity; l.blink = l.blink || 0; l.tile = !!l.tile;
      for (const f of l.frames) f.rgba = unb64(f.rgba);
    }
    return s;
  }
  function clone(scene) {
    return { w: scene.w, h: scene.h, bg: scene.bg ? scene.bg.slice() : null, layers: scene.layers.map(l => Object.assign({}, l, {
      dir: l.dir.slice(), frames: l.frames.map(f => ({ w: f.w, h: f.h, delay: f.delay, rgba: f.rgba.slice() })) })) };
  }

  const api = { newScene, newLayer, plan, render, bake, frameAt, layerPos, toPanel, buildPXA, buildPXI, toJSON, fromJSON, clone, pyRound, seqTotal };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Scene = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
