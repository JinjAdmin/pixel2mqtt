// node tests/bake_scene.js <scene.json> <out.anim> [--merge]
// Bakes a scene with pixel2mqtt/static/scene.js (the same code the editor runs) to a PXA1 .anim file.
const fs = require("fs"), path = require("path");
const Scene = require(path.join(__dirname, "..", "pixel2mqtt", "static", "scene.js"));
const [src, dst] = process.argv.slice(2), merge = process.argv.includes("--merge");
const scene = Scene.fromJSON(fs.readFileSync(src, "utf8"));
const { frames } = Scene.bake(scene, 450, merge);
fs.writeFileSync(dst, Scene.buildPXA(frames, scene.w, scene.h));
