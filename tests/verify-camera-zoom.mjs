import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

assert.match(html, /id="cameraZoomControl" hidden/);
assert.match(html, /id="cameraZoom" type="range"/);
assert.match(html, /getCapabilities\?\.\(\)\.zoom/);
assert.match(html, /applyConstraints\(\{advanced:\[\{zoom:target\}\]\}\)/);
assert.match(html, /cameraZoom:\$\{facingMode\}/);
assert.match(html, /saved[\s\S]*?:range\.min/);
assert.match(html, /cameraZoomControl\.hidden=true/);
assert.match(html, /20261111-camera-zoom1/);
assert.doesNotMatch(html, /zoom:\s*[12](?:\.5)?\s*[,}]/, "camera startup must not force 1.5x or 2x");

const helperSource = html.match(/function cameraZoomLabel[\s\S]*?(?=function setCameraZoomDisplay)/)?.[0];
assert.ok(helperSource, "camera zoom helpers must be present");
const { cameraZoomLabel, cameraZoomRange } = Function(`${helperSource}; return { cameraZoomLabel, cameraZoomRange };`)();
assert.equal(cameraZoomLabel(0.5), "0.5×");
assert.equal(cameraZoomLabel(1), "1×");
assert.deepEqual(cameraZoomRange({ getCapabilities: () => ({ zoom: { min: 0.5, max: 5, step: 0.1 } }) }), { min: 0.5, max: 5, step: 0.1 });
assert.equal(cameraZoomRange({ getCapabilities: () => ({}) }), null);

console.log("camera zoom verification passed");
