import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

assert.match(html, /#photoGrid\{[^}]*min-height:0[^}]*grid-auto-rows:max-content/);
assert.match(html, /\.photo-thumb\{[^}]*aspect-ratio:4\/3/);
assert.match(html, /id="galleryBulkEdit"/);
assert.match(html, /id="galleryActionMessage"/);
assert.match(html, /className='photo-index'/);
assert.match(html, /function dbPutMany\(items\)/);
assert.match(html, /const t=db\.transaction\(STORE,'readwrite'\)/);
assert.match(html, /画像内の黒板は変更されません/);
assert.match(html, /if\(!p\.ledger\|\|p\.ledger\.manual!==true\)\{p\.ledger=generateLedger\(p\)\}/);
assert.match(html, /写真の整理情報を変更しました/);
assert.match(html, /共有済み写真の分類は変更されません/);

console.log("gallery and bulk classification verification: OK");
