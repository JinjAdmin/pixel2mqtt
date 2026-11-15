// node tests/test_scene.js - checks for static/scene.js (the editor's model, renderer and baker). Runs in CI.
const path = require("path");
const Scene = require(path.join(__dirname, "..", "pixel2mqtt", "static", "scene.js"));
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// a 52x32 tiled stripe layer moving left at 30 px/s + a 2-frame blinking sprite
const s = Scene.newScene(52, 32, [0, 0, 40]);
const bgl = s.layers[0];
for (let y = 0; y < 32; y++) for (let x = 0; x < 52; x++) if (x % 13 < 2) bgl.frames[0].rgba.set([255, 255, 255, 255], (y * 52 + x) * 4);
bgl.dir = [-1, 0]; bgl.speed = 30; bgl.tile = true;
const sp = Scene.newLayer(4, 4, "sprite"); sp.x = 10; sp.y = 10; sp.blink = 250;
sp.frames[0].rgba.fill(255); sp.frames.push({ w: 4, h: 4, delay: 100, rgba: new Uint8ClampedArray(64).fill(128) });
s.layers.push(sp);

const p = Scene.plan(s);
const wraps = p.length * p.rates.get(bgl) / 52;
check(Math.abs(wraps - Math.round(wraps)) < 1e-9, `mover fitted to a whole number of wraps per loop (${wraps.toFixed(3)} in ${p.length} ms)`);
check(p.length % 500 === 0, "loop is a multiple of the blink cycle");
const a = Scene.render(s, 0, p.rates), b = Scene.render(s, p.length, p.rates);
check(same(Array.from(a), Array.from(b)), "seamless loop: frame at t=length equals t=0");
const { frames } = Scene.bake(s, 450);
check(frames.length > 10 && frames.reduce((n, f) => n + f.delay, 0) === Math.round(p.length), `bake covers exactly one loop (${frames.length} frames)`);
check(frames.every(f => f.delay >= 20), "all delays >= 20 ms");
const px = Scene.render(s, 300, p.rates);  // t=300: blink hides the sprite (250..500 ms)
check(px[(11 * 52 + 11) * 4 + 2] !== 255 || px[(11 * 52 + 11) * 4] !== 255, "blink hides the layer in its off phase");

// a single animated layer keeps its own frames exactly
const f2 = Scene.newScene(52, 32, [0, 0, 0]); f2.layers[0].frames.push({ w: 52, h: 32, delay: 250, rgba: new Uint8ClampedArray(52 * 32 * 4).fill(200) });
f2.layers[0].frames[0].delay = 120;
const fb = Scene.bake(f2, 450).frames;
check(fb.length === 2 && fb[0].delay === 120 && fb[1].delay === 250, "frame-only scene keeps its frames and delays");

// JSON round trip and PXA/PXI encoders
const back = Scene.fromJSON(Scene.toJSON(s));
check(back.layers.length === 2 && same(Array.from(back.layers[1].frames[1].rgba), Array.from(sp.frames[1].rgba)) && back.layers[0].speed === 30, "JSON round trip");
const pxa = Scene.buildPXA(frames, 52, 32);
check(String.fromCharCode(...pxa.slice(0, 4)) === "PXA1" && (pxa[4] | pxa[5] << 8) === frames.length && pxa.length === 6 + frames.length * (2 + 4992), "PXA1 layout");
const ic = Scene.newScene(8, 6, null), pxi = Scene.buildPXI(Scene.bake(ic, 64).frames, 8, 6);
check(String.fromCharCode(...pxi.slice(0, 4)) === "PXI1" && pxi[4] === 8 && pxi[5] === 6, "PXI1 layout");
check(Scene.pyRound(2.5) === 2 && Scene.pyRound(3.5) === 4 && Scene.pyRound(2.4) === 2, "Python-style rounding");

console.log(fails ? `\n${fails} failure(s)` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
