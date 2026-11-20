// node tests/test_screens.js [--png dir]  - .scr renderer: pixel parity with pixeld's golden frames, plus spec checks
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const R = require("../pixel2mqtt/static/screenrender.js");
let fails = 0;
function ok(name, cond, extra) { console.log((cond ? "ok   " : "FAIL ") + name + (cond || extra === undefined ? "" : "  -> " + JSON.stringify(extra))); if (!cond) fails++; }
const pngDir = process.argv.includes("--png") ? process.argv[process.argv.indexOf("--png") + 1] : null;

// --- parity: pixeld-h6631/tests/screens/<name>.scr + .values.json + .raw, rendered as make_golden.sh does:
//     epoch 1763600000, TZ=UTC0, Fahrenheit ON, 12-hour clock OFF, no icon files, first frame
const FIX = path.join(__dirname, "..", "..", "pixeld-h6631", "tests", "screens");
const GOLD = { now: 1763600000, utc: true, fahrenheit: true, h12: false };
if (fs.existsSync(FIX)) {
  for (const f of fs.readdirSync(FIX).filter(f => f.endsWith(".scr")).sort()) {
    const name = f.slice(0, -4), raw = path.join(FIX, name + ".raw");
    if (!fs.existsSync(raw)) continue;
    const values = {};
    const vf = path.join(FIX, name + ".values.json");
    if (fs.existsSync(vf)) R.applyMessage(values, JSON.parse(fs.readFileSync(vf, "utf8")), GOLD.now);
    const ctx = Object.assign({ values }, GOLD);
    const s = R.parse(fs.readFileSync(path.join(FIX, f), "utf8"), name, ctx);
    const got = R.render(s, ctx), want = fs.readFileSync(raw).subarray(0, 52 * 32 * 3);
    const bad = [];
    for (let i = 0; i < got.length; i += 3) if (got[i] !== want[i] || got[i + 1] !== want[i + 1] || got[i + 2] !== want[i + 2]) bad.push(`(${(i / 3) % 52},${Math.floor(i / 3 / 52)}) got ${got[i]},${got[i + 1]},${got[i + 2]} want ${want[i]},${want[i + 1]},${want[i + 2]}`);
    ok(`parity ${name} (${s.elements.length} elements, ${s.errors.length} problems)`, !bad.length, `${bad.length} px differ, e.g. ${bad.slice(0, 4).join("; ")}`);
    if (s.errors.length) console.log("     problems:", JSON.stringify(s.errors));
    if (pngDir) { png(path.join(pngDir, name + ".js.png"), got); png(path.join(pngDir, name + ".c.png"), want); }
  }
} else console.log("skip parity: no ../pixeld-h6631/tests/screens");

// --- the spec's own example parses cleanly (bar 0 23 w=52 h=3 form included)
const PRINTER = `PXS1
name    3D printer
needs   printer.status printer.progress
show    printer.status in running,pause,prepare
linger  printer.status in finish,failed 30m
stale   1h
text   0 0  w=52 font=tiny align=center overflow=scroll color=#9696af "{printer.name|or:3D PRINT}"
text   1 7  font=big color=#ffffff "{printer.progress|int}"  if=printer.status==running
bar    0 23 w=52 h=3 value=printer.progress max=100 fill=#00a0ff..#28e678 bg=#1e1e2a pulse=1
text   0 27 w=30 font=tiny color=#ffa046 "{printer.remaining|dur:min}"
`;
const values = {}, now = GOLD.now;
R.applyMessage(values, { "printer.status": "running", "printer.progress": 41.7, "printer.remaining": 75, x: 41.7, big: 61764.2, chg: -1.25, pos: 3,
  st: "running", empty: "", tc: [20, "°C"], hm: "16:41", s: "Hello", ser: [1, 2, 5] }, now);
const ctx = Object.assign({ values }, GOLD, { fahrenheit: false });
const scr = R.parse(PRINTER, "printer", ctx);
ok("spec example parses without problems", scr.errors.length === 0, scr.errors);
ok("directives", scr.name === "3D printer" && scr.stale === 3600 && scr.lingerSecs === 1800);
const fmt = s => R.formatText(s, ctx).text;
ok("int / dec / thousands", fmt("{x|int} {x|dec:1} {big|thousands}") === "42 41.7 61,764", fmt("{x|int} {x|dec:1} {big|thousands}"));
ok("pct (printf rounding) and sign", fmt("{chg|pct} {pos|sign}") === "-1.2% +3", fmt("{chg|pct} {pos|sign}"));
ok("dur", fmt("{printer.remaining|dur:min}") === "1H15M" && R.formatText("{x|dur:s}", ctx).text === "42S");
ok("map / or", fmt("{st|map:running=PRINTING,*=IDLE} {nope|or:N/A} {empty|or:-}") === "PRINTING N/A -");
ok("temp", fmt("{tc|temp}") === "20" && R.formatText("{tc|temp}", Object.assign({}, ctx, { fahrenheit: true })).text === "68");
ok("time", fmt("{hm|time}") === "16:41" && R.formatText("{hm|time}", Object.assign({}, ctx, { h12: true })).text === "4:41");
ok("built-ins (UTC)", fmt("{time} {date}") === "00:53 THU NOV 20", fmt("{time} {date}"));
ok("trend", fmt("{ser.trend}") === "4");
ok("unknown formatter is reported", R.formatText("{x|bogus}", ctx).errors.length === 1);
ok("errors keep the rest", (() => { const s = R.parse('PXS1\ntext 0 0 font=medium "x"\npixel 1 1', "e", ctx); return s.errors[0].line === 2 && /font/.test(s.errors[0].msg) && s.elements.length === 2; })());
ok("visibility: needs + show", R.visibility(scr, ctx).show && !R.visibility(scr, Object.assign({}, ctx, { values: {} })).show);
ok("blink= as pixeld: hidden while phase(t, 500/ms, 2) is 1", (() => { const s = R.parse('PXS1\npixel 0 0 blink=500', "b"); return R.render(s, { now: 100, t: 100.2 })[0] === 255 && R.render(s, { now: 100, t: 101.2 })[0] === 0; })());
ok("blink out of range is reported", R.parse('PXS1\npixel 0 0 blink=10', "b").errors[0].msg === "blink must be 50..10000 ms");
ok("icon name from a template", (() => { const v = {}; R.setValue(v, "ticker.symbol", "BTC", 1); const s = R.parse('PXS1\nicon 0 0 "@coin:{ticker.symbol}"', "c"); return R.render(s, { values: v, now: 1 })[(4 * 52 + 0) * 3] === 247; })());
ok("text widths", R.textWidth("42", "small") === 11 && R.textWidth("42", "tiny") === 7 && R.textWidth("42", "big") === 22);

function png(file, fb) {
  const S = 10, w = 52 * S, h = 32 * S, img = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (Math.floor(y / S) * 52 + Math.floor(x / S)) * 3, o = y * (w * 3 + 1) + 1 + x * 3; img[o] = fb[s]; img[o + 1] = fb[s + 1]; img[o + 2] = fb[s + 2]; }
  const tbl = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tbl[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = tbl[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cc]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(img)), chunk("IEND", Buffer.alloc(0))]));
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
