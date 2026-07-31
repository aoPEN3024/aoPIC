import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sync = await readFile(new URL("../js/cloud-sync.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

assert.match(sync, /rpc\/check_photo_upload_state/);
assert.match(sync, /upload_state === "trashed"/);
assert.match(sync, /code: "PHOTO_TRASHED"/);
assert.match(sync, /errorType !== "shared_deleted"/);
assert.match(html, /cloud-sync\.js\?v=20260731-photo-trash-compat1/);
assert.doesNotMatch(sync, /service_role|database password|secret key/i);

console.log("aoPIC photo trash compatibility verification: OK");
