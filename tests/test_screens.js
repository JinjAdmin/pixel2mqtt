// node tests/test_screens.js [--png out.png]  - .scr renderer: spec examples, formatters, conditions, parity fixtures
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const R = require("../pixel2mqtt/static/screenrender.js");
let fails = 0;
function ok(name, cond, extra) { console.log((cond ? "ok   " : "FAIL ") + name + (cond || extra === undefined ? "" : "  -> " + JSON.stringify(extra))); if (!cond) fails++; }

const PRINTER = `PXS1
name    3D printer
needs   printer.status printer.progress
show    printer.status in running,pause,prepare
linger  printer.status in finish,failed 30m
stale   1h

text   0 0  w=52 font=tiny align=center overflow=scroll color=#9696af "{printer.name|or:3D PRINT}"
icon   37 7 printer_build frame=printer.progress range=0,100
text   1 7  font=big color=#ffffff "{printer.progress|int}"  if=printer.status==running
text   1 7  font=big color=#ffcd3c "{printer.progress|int}"  if=printer.status==pause
text   1 11 font=small color=#3cdc78 "DONE!"                 if=printer.status==finish
bar    0 23 w=52 h=3 value=printer.progress max=100 fill=#00a0ff..#28e678 bg=#1e1e2a pulse=1
text   0 27 w=30 font=tiny color=#ffa046 "{printer.remaining|dur:min}"
text   30 27 w=22 font=tiny align=right color=#8c8ca0 "{printer.layer}/{printer.layers}"
`;

// --- the spec's own example: note "bar 0 23 w=52 h=3" uses w=/h= options although bar takes positional w h
const scr = R.parse(PRINTER, "printer");
ok("spec example parses without errors", scr.errors.length === 0, scr.errors);
console.log("     errors:", JSON.stringify(scr.errors));
ok("directives", scr.name === "3D printer" && scr.needs.join() === "printer.status,printer.progress" && scr.stale === 3600 && scr.linger.secs === 1800);

const now = new Date(2026, 10, 19, 16, 41, 5), nowMs = now.getTime();
const values = {};
const set = (k, v) => R.setValue(values, k, v, nowMs);
set("printer.status", "running"); set("printer.progress", 41.7); set("printer.remaining", 75); set("printer.layer", 120); set("printer.layers", 300);
const ctx = { values, now, nowMs, t: 0 };
const fmt = s => R.format(R.parseTemplate(s), ctx);

// --- formatters (spec table)
set("x", 41.7); set("big", 61764.2); set("chg", -1.25); set("pos", 3); set("d1", 75); set("d2", 42); set("st", "running"); set("empty", "");
set("tc", [20, "°C"]); set("tf", [48.2, "°F"]); set("hm", "16:41"); set("s", "Hello");
ok("int 41.7 -> 42", fmt("{x|int}") === "42");
ok("dec:1 -> 41.7", fmt("{x|dec:1}") === "41.7");
ok("thousands 61764.2 -> 61,764", fmt("{big|thousands}") === "61,764");
ok("pct -1.25 -> -1.3%", fmt("{chg|pct}") === "-1.3%", fmt("{chg|pct}"));
ok("sign +3", fmt("{pos|sign}") === "+3");
ok("dur:min 75 -> 1H15M", fmt("{d1|dur:min}") === "1H15M");
ok("dur:min 42 -> 42M", fmt("{d2|dur:min}") === "42M");
ok("map running -> PRINTING", fmt("{st|map:running=PRINTING,*=IDLE}") === "PRINTING");
ok("or: on missing", fmt("{nope|or:N/A}") === "N/A" && fmt("{empty|or:-}") === "-");
ok("temp C->C / F->F", fmt("{tc|temp}") === "20" && fmt("{tf|temp}") === "9");
ok("temp with the F switch", R.format(R.parseTemplate("{tc|temp}"), Object.assign({}, ctx, { fahrenheit: true })) === "68");
ok("time 24h / 12h", fmt("{hm|time}") === "16:41" && R.format(R.parseTemplate("{hm|time}"), Object.assign({}, ctx, { h12: true })) === "4:41");
ok("ago", (set("ts", Math.floor(nowMs / 1000) - 300), fmt("{ts|ago}") === "5M AGO"));
ok("upper/trunc", fmt("{s|upper|trunc:3}") === "HEL");
ok("literal braces", fmt("{{x}}") === "{x}");
ok("built-ins", fmt("{time} {date}") === "16:41 THU NOV 19", fmt("{time} {date}"));

// --- conditions
const c = s => R.evalCond(R.parseCond(s), ctx);
ok("== text, case-insensitive", c("st==RUNNING"));
ok("numbers compare as numbers", c("x>9") && !c("x<9"));
ok("in", c("st in pause,running") && !c("st in finish"));
ok("&& binds tighter than ||", c("x<0 && x<0 || st==running") && !c("x<0 && st==running"));
ok("has/fresh", c("has(x)") && !c("has(nope)") && c("fresh(x)"));
ok("missing: only != is true", !c("nope==1") && c("nope!=1"));
ok("colour rules", (() => { const r = R.parseColor("chg>0:#28dc50,chg<0:#ff3c3c,#b4b4b4"); return r.rules.length === 2 && r.def.join() === "180,180,180"; })());
ok("colour rule with 'in' commas", R.parseColor("st in a,running:#ff0000,#000000").rules.length === 1);

// --- rendering
const fb = R.render(scr, ctx);
ok("renders 52x32 RGB", fb.length === 52 * 32 * 3);
const at = (x, y) => [...fb.slice((y * 52 + x) * 3, (y * 52 + x) * 3 + 3)].join();
ok("bar start is the gradient's first colour", at(0, 23) === "0,160,255", at(0, 23));
ok("bar empty part is bg", at(51, 24) === "30,30,42", at(51, 24));
ok("text width: small/tiny/big", R.textWidth("42", "small") === 11 && R.textWidth("42", "tiny") === 7 && R.textWidth("42", "big") === 22);
ok("warnings: tiny can't draw '!'", R.warnings(R.parse('PXS1\ntext 0 0 font=tiny "HI!"').elements[0], ctx).some(w => w.includes("'!'")));
ok("errors keep the rest", (() => { const s = R.parse('PXS1\ntext 0 0 font=medium "x"\npixel 1 1'); return s.errors[0].line === 2 && /font/.test(s.errors[0].msg) && s.elements.length === 1; })());
ok("visibility: needs + show", R.visibility(scr, ctx).show && !R.visibility(scr, { values: {}, nowMs }).show);

// --- parity with pixeld's golden frames (pixeld-h6631/tests/screens/<name>.scr + .values.json + .raw)
const FIX = path.join(__dirname, "..", "..", "pixeld-h6631", "tests", "screens");
if (fs.existsSync(FIX)) {
  for (const f of fs.readdirSync(FIX).filter(f => f.endsWith(".scr"))) {
    const name = f.slice(0, -4), raw = path.join(FIX, name + ".raw");
    if (!fs.existsSync(raw)) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(FIX, name + ".values.json"), "utf8"));
    const vals = {}, vnow = meta._now ? Date.parse(meta._now) : nowMs;
    for (const [k, v] of Object.entries(meta)) if (!k.startsWith("_")) R.setValue(vals, k, v, vnow);
    const s = R.parse(fs.readFileSync(path.join(FIX, f), "utf8"), name);
    const got = R.render(s, { values: vals, nowMs: vnow, t: meta._t || 0, fahrenheit: !!meta._fahrenheit, h12: !!meta._h12 });
    const want = fs.readFileSync(raw);
    let diff = 0; for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) diff++;
    ok(`parity ${name}`, diff === 0, `${diff} bytes differ`);
  }
} else console.log("skip parity: no pixeld-h6631/tests/screens yet");

// optional PNG of the printer screen (x10) for eyeballing
const pi = process.argv.indexOf("--png");
if (pi > 0) {
  const S = 10, w = 52 * S, h = 32 * S, rawImg = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (Math.floor(y / S) * 52 + Math.floor(x / S)) * 3, o = y * (w * 3 + 1) + 1 + x * 3; rawImg[o] = fb[s]; rawImg[o + 1] = fb[s + 1]; rawImg[o + 2] = fb[s + 2]; }
  const tbl = []; for (let n = 0; n < 256; n++) { let c2 = n; for (let k = 0; k < 8; k++) c2 = c2 & 1 ? 0xedb88320 ^ (c2 >>> 1) : c2 >>> 1; tbl[n] = c2 >>> 0; }
  const crc = b => { let c2 = 0xffffffff; for (const x of b) c2 = tbl[(c2 ^ x) & 255] ^ (c2 >>> 8); return (c2 ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cc]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(process.argv[pi + 1], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(rawImg)), chunk("IEND", Buffer.alloc(0))]));
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
