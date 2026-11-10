import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../js/cloud-sync.js", import.meta.url), "utf8");
const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const helperSource = source.match(/function summarize[\s\S]*?(?=function siteStatusLabel)/)?.[0];

assert.ok(helperSource, "queue summary helpers must be present");
assert.match(index, /hasPhotoByUid:uid=>photos\.some\(/);
assert.match(index, /cloud-sync\.js\?v=20261110-orphan-sync1/);

const existing = new Set(["photo-pending", "photo-error", "photo-synced"]);
const bridge = {
  hasPhotoByUid: photoUid => existing.has(photoUid),
  getPhotoByUid: () => {
    throw new Error("the allocation-heavy fallback must not run when hasPhotoByUid is available");
  }
};
const identity = { siteId: "site-a" };
const { summarize, currentPhotoQueue } = Function(
  "bridge",
  "identity",
  `${helperSource}; return { summarize, currentPhotoQueue };`
)(bridge, identity);

const rows = [
  { queueId: "q1", siteId: "site-a", photoUid: "photo-pending", status: "pending", bytes: 10 },
  { queueId: "q2", siteId: "site-a", photoUid: "missing-photo", status: "pending", bytes: 20 },
  { queueId: "q3", siteId: "site-a", photoUid: "photo-error", status: "error", bytes: 30 },
  { queueId: "q4", siteId: "site-a", photoUid: "photo-synced", status: "synced", bytes: 40 },
  { queueId: "q5", siteId: "site-b", photoUid: "photo-pending", status: "pending", bytes: 50 }
];

assert.deepEqual(currentPhotoQueue(rows, "site-a").map(row => row.queueId), ["q1", "q3", "q4"]);
assert.deepEqual(summarize(rows, "site-a"), {
  pending: 1,
  uploading: 0,
  synced: 1,
  error: 1,
  paused: 0,
  bytes: 40,
  total: 3
});
assert.equal(rows.length, 5, "orphan queue records must be ignored without being deleted");

console.log("orphan sync count verification passed");
