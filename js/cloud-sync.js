const DB_NAME = "aoPICCloudDB";
const DB_VERSION = 1;
const CONFIG_KEY = "aoPIC:cloudConfig";
const MODE_KEY = "aoPIC:sharingMode";
const SETTINGS_KEY = "photoSyncSettings";
const IDENTITY_KEY = "cloudIdentity";
const SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.106.2/+esm";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(["wifi_only", "any_network", "manual"]);
const bridge = window.aoPICCloudBridge;

if (!bridge) throw new Error("aoPIC???????????????");

let cloudDb;
let provider;
let identity;
let busy = false;
let paused = false;

const byId = id => document.getElementById(id);
const ui = {
  projectUrl: byId("cloudProjectUrl"), publishableKey: byId("cloudPublishableKey"), saveConfig: byId("cloudSaveConfig"),
  localMode: byId("cloudLocalMode"), siteCode: byId("cloudSiteCode"), joinCode: byId("cloudJoinCode"),
  deviceName: byId("cloudDeviceName"), join: byId("cloudJoin"), site: byId("cloudSite"), role: byId("cloudRole"),
  network: byId("cloudNetwork"), pending: byId("cloudPending"), synced: byId("cloudSynced"), errors: byId("cloudErrors"),
  mode: byId("cloudSyncMode"), project: byId("cloudProject"), enqueue: byId("cloudEnqueueExisting"),
  progress: byId("cloudProgress"), now: byId("cloudSyncNow"), pause: byId("cloudPause"), resume: byId("cloudResume"),
  retry: byId("cloudRetry"), message: byId("cloudSyncMessage"), badge: byId("cloudQueueBadge")
};

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("????????????????????"));
    transaction.onerror = () => {};
  });
}

function openCloudDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("settings")) database.createObjectStore("settings", { keyPath: "key" });
      if (!database.objectStoreNames.contains("queue")) {
        const store = database.createObjectStore("queue", { keyPath: "queueId" });
        store.createIndex("siteId", "siteId", { unique: false });
        store.createIndex("photoUid", "photoUid", { unique: false });
        store.createIndex("status", "status", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSetting(key) {
  const tx = cloudDb.transaction("settings", "readonly");
  const row = await requestResult(tx.objectStore("settings").get(key));
  return row?.value ?? null;
}

async function setSetting(key, value) {
  const tx = cloudDb.transaction("settings", "readwrite");
  tx.objectStore("settings").put({ key, value: structuredClone(value), updatedAt: new Date().toISOString() });
  await transactionDone(tx);
}

async function getQueue() {
  const tx = cloudDb.transaction("queue", "readonly");
  return requestResult(tx.objectStore("queue").getAll());
}

async function putQueueItem(item) {
  const tx = cloudDb.transaction("queue", "readwrite");
  tx.objectStore("queue").put(structuredClone(item));
  await transactionDone(tx);
}

async function updateQueueItem(queueId, patch) {
  const tx = cloudDb.transaction("queue", "readwrite");
  const store = tx.objectStore("queue");
  const item = await requestResult(store.get(queueId));
  if (item) store.put({ ...item, ...structuredClone(patch), updatedAt: new Date().toISOString() });
  await transactionDone(tx);
}

async function recoverInterrupted() {
  const tx = cloudDb.transaction("queue", "readwrite");
  const store = tx.objectStore("queue");
  const rows = await requestResult(store.getAll());
  const now = new Date().toISOString();
  rows.filter(row => row.status === "uploading").forEach(row => store.put({
    ...row, status: "pending", errorType: "interrupted", lastError: "????????????????????", updatedAt: now
  }));
  await transactionDone(tx);
}

function validateConfig(input) {
  const projectUrl = String(input?.projectUrl || "").trim().replace(/\/+$/, "");
  const publishableKey = String(input?.publishableKey || "").trim();
  let url;
  try { url = new URL(projectUrl); } catch (_) { throw new Error("Project URL?????????????"); }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Project URL?HTTPS??????????");
  if (url.username || url.password || url.search || url.hash) throw new Error("Project URL????????????????");
  if (!local && (!/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || (url.pathname && url.pathname !== "/"))) throw new Error("Supabase?Project URL??????????");
  if (/^(sb_secret_|eyJ)/i.test(publishableKey) || /service[_-]?role|secret|database/i.test(publishableKey)) {
    throw new Error("????????????sb_publishable_????Publishable key????????????");
  }
  if (!/^sb_publishable_[A-Za-z0-9._-]{20,}$/.test(publishableKey)) throw new Error("Publishable key??????????");
  return { projectUrl, publishableKey };
}

function readConfig() {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    return value ? validateConfig(value) : null;
  } catch (_) {
    localStorage.removeItem(CONFIG_KEY);
    return null;
  }
}

async function readLocalConfig() {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return null;
  try {
    const response = await fetch("./config/cloud.local.json", { cache: "no-store", credentials: "same-origin" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`???????????????HTTP ${response.status}??`);
    return validateConfig(await response.json());
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("config/cloud.local.json????JSON????????");
    if (error?.message?.includes("??????")) throw error;
    return null;
  }
}

function networkStatus(navigatorLike = navigator) {
  if (navigatorLike.onLine === false) return "offline";
  const connection = navigatorLike.connection || navigatorLike.mozConnection || navigatorLike.webkitConnection;
  const type = String(connection?.type || "").toLowerCase();
  if (["wifi", "ethernet"].includes(type)) return "wifi";
  if (["cellular", "mobile", "wimax"].includes(type)) return "mobile";
  return "unknown";
}

function networkLabel(value) {
  return ({ wifi: "Wi-Fi", mobile: "??????", unknown: "????", offline: "?????" })[value] || "????";
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = [[1024 ** 3, "GB"], [1024 ** 2, "MB"], [1024, "KB"]];
  const [base, unit] = units.find(([size]) => bytes >= size) || [1, "bytes"];
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: base === 1 ? 0 : bytes / base >= 10 ? 1 : 2 }).format(bytes / base)} ${unit}`;
}

function message(text, error = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", error);
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!match) throw new Error("???JPEG????????????");
  const binary = atob(match[1].replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/jpeg" });
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hashBlob(blob) {
  return hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
}

async function decodeJpeg(blob) {
  const header = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  if (header.length !== 3 || header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff) throw new Error("JPEG????????????????");
  const source = typeof createImageBitmap === "function" ? await createImageBitmap(blob) : await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("JPEG??????????????")); };
    image.src = url;
  });
  return source;
}

async function createPackage(queueItem) {
  const photo = bridge.getPhotoByUid(queueItem.photoUid);
  if (!photo) throw new Error("??????????????????");
  if (String(photo.koujiId || "") !== String(queueItem.koujiId || "")) throw new Error("?????????????????????");
  const project = bridge.getProjectById(queueItem.koujiId);
  if (!project || project.projectUid !== queueItem.projectUid) throw new Error("?????????????????????");
  const blob = dataUrlToBlob(photo.dataUrl);
  if (Number(photo.bytes) && Number(photo.bytes) !== blob.size) throw new Error("JPEG????????????????");
  const source = await decodeJpeg(blob);
  try {
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    if (Number(photo.width) !== width || Number(photo.height) !== height) throw new Error("JPEG??????????????????");
    const sha256 = await hashBlob(blob);
    if (queueItem.sha256 && queueItem.sha256 !== sha256) throw new Error("JPEG?SHA-256??????????????");
    const scale = Math.min(1, 480 / Math.max(width, height));
    const thumbWidth = Math.max(1, Math.round(width * scale));
    const thumbHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;
    canvas.getContext("2d", { alpha: false }).drawImage(source, 0, 0, thumbWidth, thumbHeight);
    const thumbnailBlob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("?????????????????")), "image/jpeg", 0.76));
    const thumbnailSha256 = await hashBlob(thumbnailBlob);
    const snapshot = photo.boardSnapshot || {};
    return {
      eventId: queueItem.eventId, siteId: queueItem.siteId, deviceName: identity.deviceName,
      project: { projectUid: project.projectUid, koujiId: project.id, name: project.name, contractor: project.contractor || "" },
      photo: {
        photoUid: photo.photoUid, capturedAt: photo.date || null, sha256, mimeType: "image/jpeg", width, height, bytes: blob.size,
        metadata: {
          schemaVersion: photo.schemaVersion || 1, legacyId: photo.id ?? null,
          classification: { koushu: photo.koushu || "", shubetsu: photo.shubetsu || "", saibetsu: photo.saibetsu || "", sokuten: photo.sokuten || "", tekiyo: photo.tekiyo || "" },
          boardSnapshot: {
            koujimei: snapshot.koujimei ?? photo.koujimei ?? project.name ?? "", contractor: snapshot.contractor ?? project.contractor ?? "",
            koushu: snapshot.koushu ?? photo.koushu ?? "", shubetsu: snapshot.shubetsu ?? photo.shubetsu ?? "",
            saibetsu: snapshot.saibetsu ?? photo.saibetsu ?? "", sokuten: snapshot.sokuten ?? photo.sokuten ?? "", tekiyo: snapshot.tekiyo ?? photo.tekiyo ?? ""
          },
          ledger: { title: photo.ledger?.title || "", description: photo.ledger?.description || "", manual: photo.ledger?.manual === true }
        }
      },
      originalBlob: blob,
      thumbnail: { blob: thumbnailBlob, sha256: thumbnailSha256, bytes: thumbnailBlob.size, width: thumbWidth, height: thumbHeight }
    };
  } finally {
    source.close?.();
  }
}

async function createProvider(config) {
  const { createClient } = await import(SUPABASE_SDK_URL);
  const client = createClient(config.projectUrl, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "aoPIC:supabase-auth" }
  });
  return {
    async authenticate() {
      const current = await client.auth.getSession();
      if (current.error) throw current.error;
      if (current.data.session?.user) return current.data.session.user.id;
      const signed = await client.auth.signInAnonymously();
      if (signed.error) throw signed.error;
      return signed.data.user.id;
    },
    async restoreMembership() {
      const result = await client.from("site_members").select("site_id,role,device_name,sites!inner(site_code,name)").eq("active", true).order("last_seen_at", { ascending: false }).limit(2);
      if (result.error) throw result.error;
      if (!Array.isArray(result.data) || result.data.length !== 1) return null;
      const row = result.data[0];
      return { siteId: row.site_id, siteCode: row.sites?.site_code, siteName: row.sites?.name, role: row.role, deviceName: row.device_name || "????" };
    },
    async joinSite({ siteCode, joinCode, deviceName }) {
      const result = await client.rpc("join_site", { p_site_code: siteCode, p_join_code: joinCode, p_device_name: deviceName });
      if (result.error) throw result.error;
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!row?.site_id) {
        if (row?.error_code === "temporarily_blocked") throw new Error("????????????????????15?????????????");
        if (row?.error_code === "membership_disabled") throw new Error("??????????????????");
        throw new Error("??ID??????????????????");
      }
      return { siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name, role: row.member_role, deviceName };
    },
    async uploadPhotoPackage(pkg) {
      const { siteId, project, photo, originalBlob, thumbnail, eventId, deviceName } = pkg;
      let projectRow;
      let result = await client.from("projects").select("id,project_uid").eq("site_id", siteId).eq("project_uid", project.projectUid).maybeSingle();
      if (result.error) throw result.error;
      projectRow = result.data;
      if (!projectRow) {
        result = await client.from("projects").insert({ site_id: siteId, project_uid: project.projectUid, kouji_id: project.koujiId, name: project.name, contractor: project.contractor }).select("id,project_uid").single();
        if (result.error?.code === "23505") result = await client.from("projects").select("id,project_uid").eq("site_id", siteId).eq("project_uid", project.projectUid).single();
        if (result.error) throw result.error;
        projectRow = result.data;
      }
      result = await client.from("photos").select("id,project_id,photo_uid,sha256,bytes").eq("site_id", siteId).eq("photo_uid", photo.photoUid).maybeSingle();
      if (result.error) throw result.error;
      let photoRow = result.data;
      if (photoRow && (photoRow.project_id !== projectRow.id || photoRow.sha256 !== photo.sha256 || Number(photoRow.bytes) !== photo.bytes)) throw new Error("??photoUid???????????????");
      if (!photoRow) {
        const sameHash = await client.from("photos").select("photo_uid").eq("site_id", siteId).eq("sha256", photo.sha256).maybeSingle();
        if (sameHash.error) throw sameHash.error;
        if (sameHash.data) throw new Error("??SHA-256???photoUid??????????");
        result = await client.from("photos").insert({
          site_id: siteId, project_id: projectRow.id, photo_uid: photo.photoUid, captured_at: photo.capturedAt,
          sha256: photo.sha256, mime_type: "image/jpeg", width: photo.width, height: photo.height, bytes: photo.bytes, metadata: photo.metadata
        }).select("id,project_id,photo_uid,sha256,bytes").single();
        if (result.error?.code === "23505") result = await client.from("photos").select("id,project_id,photo_uid,sha256,bytes").eq("site_id", siteId).eq("photo_uid", photo.photoUid).single();
        if (result.error) throw result.error;
        photoRow = result.data;
        if (photoRow.project_id !== projectRow.id || photoRow.sha256 !== photo.sha256 || Number(photoRow.bytes) !== photo.bytes) throw new Error("??photoUid???????????????");
      }
      const originalPath = `${siteId}/photos/${photo.photoUid}.jpg`;
      const thumbnailPath = `${siteId}/thumbnails/${photo.photoUid}.jpg`;
      result = await client.from("photo_objects").select("status,object_path,sha256,bytes,upload_completed_at,thumbnail_object_path,thumbnail_sha256,thumbnail_bytes").eq("photo_id", photoRow.id).maybeSingle();
      if (result.error) throw result.error;
      const existing = result.data;
      if (existing?.status === "complete") {
        const same = existing.object_path === originalPath && existing.sha256 === photo.sha256 && Number(existing.bytes) === photo.bytes
          && existing.thumbnail_object_path === thumbnailPath && existing.thumbnail_sha256 === thumbnail.sha256 && Number(existing.thumbnail_bytes) === thumbnail.bytes;
        if (!same) throw new Error("?????????????????????????");
      } else {
        const bucket = client.storage.from("site-photos");
        let upload = await bucket.upload(originalPath, originalBlob, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
        if (upload.error) throw upload.error;
        upload = await bucket.upload(thumbnailPath, thumbnail.blob, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
        if (upload.error) throw upload.error;
        const completedAt = new Date().toISOString();
        result = await client.from("photo_objects").upsert({
          photo_id: photoRow.id, site_id: siteId, bucket_id: "site-photos", object_path: originalPath, sha256: photo.sha256,
          bytes: photo.bytes, status: "complete", upload_completed_at: completedAt, thumbnail_object_path: thumbnailPath,
          thumbnail_sha256: thumbnail.sha256, thumbnail_bytes: thumbnail.bytes, thumbnail_width: thumbnail.width, thumbnail_height: thumbnail.height
        }, { onConflict: "photo_id" });
        if (result.error) throw result.error;
      }
      result = await client.from("photo_objects").select("status,sha256,bytes,thumbnail_sha256,thumbnail_bytes,upload_completed_at").eq("photo_id", photoRow.id).single();
      if (result.error) throw result.error;
      const stored = result.data;
      if (stored.status !== "complete" || stored.sha256 !== photo.sha256 || Number(stored.bytes) !== photo.bytes || stored.thumbnail_sha256 !== thumbnail.sha256 || Number(stored.thumbnail_bytes) !== thumbnail.bytes || !stored.upload_completed_at) throw new Error("Supabase??????????????");
      result = await client.from("sync_events").insert({ event_id: eventId, site_id: siteId, entity_type: "photo", entity_id: photoRow.id, event_type: "photo_synced", device_name: deviceName, payload: { photoUid: photo.photoUid, sha256: photo.sha256 }, created_at: stored.upload_completed_at });
      if (result.error && result.error.code !== "23505") throw result.error;
      return { storedAt: stored.upload_completed_at };
    }
  };
}

function classifyError(error) {
  const text = String(error?.message || error || "????????????");
  const code = String(error?.code || "");
  if (/jwt|session|auth|sign.?in|??/i.test(text) || ["401", "PGRST301"].includes(code)) return { type: "auth", message: "?????????????????????????????" };
  if (/row.level|permission|policy|forbidden|??/i.test(text) || ["403", "42501"].includes(code)) return { type: "permission", message: "?????????????????????" };
  if (/quota|??.*??|insufficient storage/i.test(text) || code === "507") return { type: "quota", message: "???????????????????????" };
  if (/fetch|network|offline|??|connection/i.test(text)) return { type: "network", message: "?????????????????????" };
  return { type: "integrity", message: text };
}

async function settings() {
  const value = await getSetting(SETTINGS_KEY);
  return { mode: MODES.has(value?.mode) ? value.mode : "wifi_only", anyNetworkConfirmed: value?.anyNetworkConfirmed === true };
}

async function queuePhoto(photo, project, fixedIdentity) {
  if (!UUID_RE.test(photo.photoUid || "")) throw new Error("???photoUid??????????");
  if (!UUID_RE.test(project.projectUid || "")) throw new Error("???projectUid??????????");
  const rows = await getQueue();
  const existing = rows.find(row => row.siteId === fixedIdentity.siteId && row.photoUid === photo.photoUid);
  if (existing) return false;
  await putQueueItem({
    queueId: crypto.randomUUID(), eventId: crypto.randomUUID(), siteId: fixedIdentity.siteId, projectUid: project.projectUid,
    koujiId: project.id, photoUid: photo.photoUid, bytes: Number(photo.bytes) || 0, status: "pending", attempts: 0,
    errorType: "", lastError: "", queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  return true;
}

function summarize(rows, siteId = identity?.siteId) {
  const result = { pending: 0, uploading: 0, synced: 0, error: 0, paused: 0, bytes: 0, total: 0 };
  for (const row of rows.filter(item => !siteId || item.siteId === siteId)) {
    result.total += 1;
    if (Object.hasOwn(result, row.status)) result[row.status] += 1;
    if (["pending", "error", "paused"].includes(row.status)) result.bytes += Number(row.bytes) || 0;
  }
  return result;
}

async function render() {
  const rows = await getQueue();
  const summary = summarize(rows);
  const network = networkStatus();
  const configured = Boolean(provider && identity?.siteId);
  ui.site.textContent = identity?.siteName || identity?.siteCode || "???";
  ui.role.textContent = identity?.role || "?";
  ui.network.textContent = networkLabel(network);
  ui.pending.textContent = `${summary.pending + summary.paused + summary.error}? / ${formatBytes(summary.bytes)}`;
  ui.synced.textContent = `${summary.synced}?`;
  ui.errors.textContent = `${summary.error}?`;
  ui.progress.max = Math.max(1, summary.total);
  ui.progress.value = Math.min(summary.total, summary.synced + summary.error);
  ui.now.disabled = busy || !configured || summary.pending === 0 || network === "offline" || identity?.role === "viewer";
  ui.pause.disabled = summary.pending === 0;
  ui.resume.disabled = summary.paused === 0;
  ui.retry.disabled = summary.error === 0;
  ui.enqueue.disabled = !configured || identity?.role === "viewer" || !ui.project.value;
  ui.badge.textContent = `??? ${summary.pending + summary.paused + summary.error}?`;
  ui.badge.classList.toggle("show", configured || summary.total > 0);
}

async function processQueue({ manual = false } = {}) {
  if (busy || paused || !provider || !identity?.siteId || identity.role === "viewer") return;
  const currentSettings = await settings();
  const network = networkStatus();
  if (network === "offline") return message("??????????????????", true);
  if (!manual) {
    if (currentSettings.mode === "manual") return;
    if (currentSettings.mode === "wifi_only" && network !== "wifi") return message(`${networkLabel(network)}???????????????`);
    if (currentSettings.mode === "any_network" && !currentSettings.anyNetworkConfirmed) return;
  }
  const rows = (await getQueue()).filter(row => row.siteId === identity.siteId && row.status === "pending");
  if (!rows.length) return render();
  if (manual && ["mobile", "unknown"].includes(network)) {
    const total = rows.reduce((sum, row) => sum + Number(row.bytes || 0), 0);
    if (!confirm(`${rows.length}???${formatBytes(total)}?${networkLabel(network)}???????????????\n????????????????????????????`)) return;
  }
  busy = true;
  await render();
  try {
    for (let index = 0; index < rows.length && !paused; index += 1) {
      const item = rows[index];
      if (item.siteId !== identity.siteId) continue;
      await updateQueueItem(item.queueId, { status: "uploading", attempts: Number(item.attempts || 0) + 1, lastError: "" });
      message(`?????? ${index + 1}/${rows.length}?`);
      try {
        const pkg = await createPackage(item);
        await updateQueueItem(item.queueId, { sha256: pkg.photo.sha256, bytes: pkg.photo.bytes });
        const result = await provider.uploadPhotoPackage(pkg);
        await updateQueueItem(item.queueId, { status: "synced", syncedAt: result.storedAt, lastError: "", errorType: "" });
      } catch (error) {
        const classified = classifyError(error);
        const retryable = ["network", "auth"].includes(classified.type);
        await updateQueueItem(item.queueId, { status: retryable ? "pending" : "error", errorType: classified.type, lastError: classified.message });
        message(classified.message, true);
        if (retryable) break;
      }
      await render();
    }
    if (!paused && !(await getQueue()).some(row => row.siteId === identity.siteId && row.status === "pending")) message("????????????????????????????");
  } finally {
    busy = false;
    await render();
  }
}

async function connect(config, quiet = false) {
  provider = await createProvider(config);
  const userId = await provider.authenticate();
  if (identity?.userId && identity.userId !== userId) identity = null;
  identity = { ...(identity || {}), userId };
  if (!identity.siteId) {
    const restored = await provider.restoreMembership();
    if (restored) identity = { ...identity, ...restored };
  }
  await setSetting(IDENTITY_KEY, identity);
  localStorage.setItem(MODE_KEY, "cloud");
  if (!quiet) message(identity.siteId ? `${identity.siteName || identity.siteCode}?????????` : "??????????????????????????");
  await render();
  if (identity.siteId) processQueue();
}

async function enqueueSavedPhoto(photoUid) {
  if (!provider || !identity?.siteId || identity.role === "viewer") return;
  const photo = bridge.getPhotoByUid(photoUid);
  const project = photo ? bridge.getProjectById(photo.koujiId) : null;
  if (!photo || !project?.projectUid) return;
  await queuePhoto(photo, project, structuredClone(identity));
  await render();
  processQueue();
}

async function populateProjects() {
  const projects = bridge.getProjects().filter(project => UUID_RE.test(project.projectUid || ""));
  ui.project.replaceChildren(new Option("?????", ""), ...projects.map(project => new Option(project.name, project.id)));
}

ui.saveConfig.addEventListener("click", async () => {
  try {
    const config = validateConfig({ projectUrl: ui.projectUrl.value, publishableKey: ui.publishableKey.value });
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    await connect(config);
    ui.publishableKey.value = "";
  } catch (error) { message(error.message, true); }
});

ui.localMode.addEventListener("click", async () => {
  provider = null;
  localStorage.setItem(MODE_KEY, "local");
  message("??????????????????????");
  await render();
});

ui.join.addEventListener("click", async () => {
  if (!provider) return message("????????????????", true);
  try {
    const joined = await provider.joinSite({ siteCode: ui.siteCode.value.trim(), joinCode: ui.joinCode.value, deviceName: ui.deviceName.value.trim() || "????" });
    identity = { ...identity, ...joined };
    await setSetting(IDENTITY_KEY, identity);
    ui.joinCode.value = "";
    message(`${identity.siteName || identity.siteCode}??????????: ${identity.role}`);
    await render();
  } catch (error) { message(error.message || "??????????????", true); }
});

ui.mode.addEventListener("change", async () => {
  const previous = await settings();
  if (ui.mode.value === "any_network" && !previous.anyNetworkConfirmed) {
    if (!confirm("???????????????????????????????????????????????")) {
      ui.mode.value = previous.mode;
      return;
    }
  }
  await setSetting(SETTINGS_KEY, { mode: ui.mode.value, anyNetworkConfirmed: ui.mode.value === "any_network" });
  message(`??????${ui.mode.options[ui.mode.selectedIndex].textContent}?????????`);
  processQueue();
});

ui.enqueue.addEventListener("click", async () => {
  if (!identity?.siteId || identity.role === "viewer") return;
  const project = bridge.getProjectById(ui.project.value);
  if (!project) return;
  const photos = bridge.getPhotos().filter(photo => String(photo.koujiId || "") === String(project.id));
  const total = photos.reduce((sum, photo) => sum + Number(photo.bytes || 0), 0);
  if (!photos.length) return message("?????????????????????");
  if (!confirm(`${project.name}???${photos.length}???${formatBytes(total)}?????????????????????????????`)) return;
  let added = 0;
  for (const photo of photos) if (await queuePhoto(photo, project, structuredClone(identity))) added += 1;
  message(`${added}???????????????????????????????????`);
  await render();
  processQueue();
});

ui.now.addEventListener("click", () => processQueue({ manual: true }));
ui.pause.addEventListener("click", async () => {
  paused = true;
  const rows = await getQueue();
  await Promise.all(rows.filter(row => row.siteId === identity?.siteId && row.status === "pending").map(row => updateQueueItem(row.queueId, { status: "paused" })));
  message("??????????????????1???????????????");
  await render();
});
ui.resume.addEventListener("click", async () => {
  paused = false;
  const rows = await getQueue();
  await Promise.all(rows.filter(row => row.siteId === identity?.siteId && row.status === "paused").map(row => updateQueueItem(row.queueId, { status: "pending" })));
  message("????????????");
  await render();
  processQueue();
});
ui.retry.addEventListener("click", async () => {
  const rows = await getQueue();
  await Promise.all(rows.filter(row => row.siteId === identity?.siteId && row.status === "error").map(row => updateQueueItem(row.queueId, { status: "pending", errorType: "", lastError: "" })));
  await render();
  processQueue({ manual: true });
});
ui.badge.addEventListener("click", () => bridge.showSettings());
window.addEventListener("aoPIC:photo-saved", event => enqueueSavedPhoto(event.detail?.photoUid).catch(error => message(error.message, true)));
window.addEventListener("online", () => { render(); processQueue(); });
window.addEventListener("offline", render);
navigator.connection?.addEventListener?.("change", () => { render(); processQueue(); });

async function init() {
  await bridge.ready;
  cloudDb = await openCloudDb();
  await recoverInterrupted();
  identity = await getSetting(IDENTITY_KEY);
  const currentSettings = await settings();
  ui.mode.value = currentSettings.mode;
  await populateProjects();
  await render();
  const localConfig = await readLocalConfig();
  const config = localConfig || readConfig();
  if (localConfig) {
    ui.projectUrl.value = localConfig.projectUrl;
    message("git???????????????????????????");
  }
  if (config && localStorage.getItem(MODE_KEY) === "cloud") await connect(config, true);
  else message("??????????????????????");
}

init().catch(error => message(error.message || "?????????????????", true));
