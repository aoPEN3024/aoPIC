const DB_NAME = "aoPICCloudDB";
const DB_VERSION = 1;
const CONFIG_KEY = "aoPIC:cloudConfig";
const MODE_KEY = "aoPIC:sharingMode";
const AUTH_STORAGE_KEY = "aoPIC:supabase-auth-rest";
const LOCAL_CONFIG_PATH = "./config/cloud.local.json";
const PUBLIC_CONFIG_PATH = "./config/cloud.public.v1.json";
const SETTINGS_KEY = "photoSyncSettings";
const IDENTITY_KEY = "cloudIdentity";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(["wifi_only", "any_network", "manual"]);
const bridge = window.aoPICCloudBridge;

if (!bridge) throw new Error("aoPICのデータ連携が初期化されていません");

let cloudDb;
let provider;
let identity;
let deploymentConfig;
let busy = false;
let paused = false;
let siteActionBusy = false;
let memberships = [];
let siteStatusFilter = "active";

const byId = id => document.getElementById(id);
const ui = {
  projectUrl: byId("cloudProjectUrl"), publishableKey: byId("cloudPublishableKey"), saveConfig: byId("cloudSaveConfig"),
  localMode: byId("cloudLocalMode"), siteCode: byId("cloudSiteCode"), joinCode: byId("cloudJoinCode"),
  deviceName: byId("cloudDeviceName"), join: byId("cloudJoin"), site: byId("cloudSite"), role: byId("cloudRole"),
  createSiteName: byId("cloudCreateSiteName"), createSiteCode: byId("cloudCreateSiteCode"),
  createJoinCode: byId("cloudCreateJoinCode"), createJoinCodeConfirm: byId("cloudCreateJoinCodeConfirm"),
  createAdminCode: byId("cloudCreateAdminCode"), createAdminCodeConfirm: byId("cloudCreateAdminCodeConfirm"),
  createDeviceName: byId("cloudCreateDeviceName"), creationCode: byId("cloudCreationCode"),
  createSite: byId("cloudCreateSite"),
  network: byId("cloudNetwork"), pending: byId("cloudPending"), synced: byId("cloudSynced"), errors: byId("cloudErrors"),
  mode: byId("cloudSyncMode"), project: byId("cloudProject"), enqueue: byId("cloudEnqueueExisting"),
  progress: byId("cloudProgress"), now: byId("cloudSyncNow"), pause: byId("cloudPause"), resume: byId("cloudResume"),
  retry: byId("cloudRetry"), message: byId("cloudSyncMessage"), badge: byId("cloudQueueBadge")
};
Object.assign(ui, {
  adminPanel: byId("cloudAdminPanel"), adminSiteName: byId("cloudAdminSiteName"),
  adminSiteCode: byId("cloudAdminSiteCode"), adminSave: byId("cloudAdminSave"),
  adminJoinCode: byId("cloudAdminJoinCode"), adminJoinCodeConfirm: byId("cloudAdminJoinCodeConfirm"),
  adminRotateCode: byId("cloudAdminRotateCode"), adminClose: byId("cloudAdminClose"),
  adminReopen: byId("cloudAdminReopen"), adminTrash: byId("cloudAdminTrash"),
  adminRestore: byId("cloudAdminRestore"), deleteEmptyBox: byId("cloudDeleteEmptyBox"),
  adminDeleteEmpty: byId("cloudAdminDeleteEmpty"), adminClaimSiteCode: byId("cloudAdminClaimSiteCode"),
  adminClaimCode: byId("cloudAdminClaimCode"), adminClaimDeviceName: byId("cloudAdminClaimDeviceName"),
  adminClaim: byId("cloudAdminClaim"), siteListPanel: byId("cloudSiteListPanel"),
  siteList: byId("cloudSiteList"), siteListEmpty: byId("cloudSiteListEmpty"),
  nonAdminNotice: byId("cloudNonAdminNotice"), adminCodeUnavailable: byId("cloudAdminCodeUnavailable"),
  openAdminClaim: byId("cloudOpenAdminClaim"), adminAccessStatus: byId("cloudAdminAccessStatus"),
  adminAccessCode: byId("cloudAdminAccessCode"), adminAccessCodeConfirm: byId("cloudAdminAccessCodeConfirm"),
  adminAccessSave: byId("cloudAdminAccessSave"), memberList: byId("cloudMemberList")
});

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("データの保存が中断されました"));
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
    ...row, status: "pending", errorType: "interrupted", lastError: "送信が中断されました", updatedAt: now
  }));
  await transactionDone(tx);
}

function validateConfig(input) {
  const projectUrl = String(input?.projectUrl || "").trim().replace(/\/+$/, "");
  const publishableKey = String(input?.publishableKey || "").trim();
  let url;
  try { url = new URL(projectUrl); } catch (_) { throw new Error("Project URLの形式が正しくありません"); }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Project URLはHTTPSを指定してください");
  if (url.username || url.password || url.search || url.hash) throw new Error("Project URLに不要な情報が含まれています");
  if (!local && (!/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || (url.pathname && url.pathname !== "/"))) throw new Error("接続先のURLが正しくありません");
  if (/^(sb_secret_|eyJ)/i.test(publishableKey) || /service[_-]?role|secret|database/i.test(publishableKey)) {
    throw new Error("接続キーが未入力です（sb_publishable_ で始まるキーを入力してください）");
  }
  if (!/^sb_publishable_[A-Za-z0-9._-]{20,}$/.test(publishableKey)) throw new Error("接続キーの形式が正しくありません");
  return { projectUrl, publishableKey };
}

function validateSiteCreation(input) {
  const siteName = String(input.siteName || "").trim();
  const siteCode = String(input.siteCode || "").trim().toUpperCase();
  const joinCode = String(input.joinCode || "");
  const joinCodeConfirm = String(input.joinCodeConfirm || "");
  const deviceName = String(input.deviceName || "").trim();
  const creationCode = String(input.creationCode || "");
  const adminCode = validateAdminCode(input.adminCode, input.adminCodeConfirm);
  const control = /[\u0000-\u001f\u007f]/;
  if (!siteName || siteName.length > 160 || control.test(siteName)) throw new Error("現場名は1～160文字で入力してください");
  if (!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(siteCode)) throw new Error("現場IDは英大文字・数字・_・-を使い、3～40文字で入力してください");
  if (joinCode.length < 8 || joinCode.length > 64 || new TextEncoder().encode(joinCode).length > 72 || /[\s\u0000-\u001f\u007f]/.test(joinCode)) {
    throw new Error("参加コードは空白を含まない8～64文字で入力してください");
  }
  if (joinCode !== joinCodeConfirm) throw new Error("参加コードと確認入力が一致しません");
  if (!deviceName || deviceName.length > 80 || control.test(deviceName)) throw new Error("端末の名前は1～80文字で入力してください");
  if (creationCode.length < 16 || creationCode.length > 64 || new TextEncoder().encode(creationCode).length > 72 || /[\s\u0000-\u001f\u007f]/.test(creationCode)) {
    throw new Error("現場作成コードは空白を含まない16～64文字で入力してください");
  }
  return { siteName, siteCode, joinCode, deviceName, creationCode, adminCode };
}

function validateAdminCode(value, confirmation) {
  const code = String(value || "");
  if (code !== String(confirmation || "")) throw new Error("現場管理コードと確認入力が一致しません");
  const categories = [
    /[a-z]/.test(code), /[A-Z]/.test(code), /[0-9]/.test(code), /[^A-Za-z0-9]/.test(code)
  ].filter(Boolean).length;
  if (code.length < 8 || code.length > 64 || new TextEncoder().encode(code).length > 72
      || /[\s\u0000-\u001f\u007f]/.test(code) || categories < 2
      || /^(password|admin|administrator|qwerty|letmein|aopen|aoalb|aopic|12345678|87654321)$/i.test(code)
      || /^(.)\1{7,}$/.test(code)) {
    throw new Error("現場管理コードは空白を含まない8～64文字で、英字・数字・記号のうち2種類以上を使用してください");
  }
  return code;
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

function hasStoredAuthSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
    return Boolean(stored?.access_token && stored?.refresh_token);
  } catch (_) {
    return false;
  }
}

async function readDeploymentConfig() {
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  const configPath = isLocal ? LOCAL_CONFIG_PATH : PUBLIC_CONFIG_PATH;
  try {
    const response = await fetch(configPath, { cache: "no-store", credentials: "same-origin" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`設定の取得に失敗しました（詳細: ${response.status}）`);
    const parsed = await response.json();
    if (!isLocal && (parsed?.schemaVersion !== 1 || parsed?.cloudSharingEnabled !== true)) {
      throw new Error("公開用クラウド設定が無効、または未対応の形式です");
    }
    return validateConfig(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${configPath} の内容が正しくありません`);
    if (error?.message?.startsWith("設定の取得に失敗しました")) throw error;
    if (!isLocal) throw error;
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
  return ({ wifi: "Wi-Fi", mobile: "モバイル通信", unknown: "回線を確認できません", offline: "オフライン" })[value] || "回線を確認できません";
}

function roleLabel(value) {
  return ({ admin: "管理者", editor: "メンバー", viewer: "閲覧のみ" })[value] || "−";
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
  if (!match) throw new Error("写真データが正しくありません");
  const binary = atob(match[1].replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/jpeg" });
}

function isLegacyBase64Size(photo, actualBytes) {
  const encoded = String(photo?.dataUrl || "").slice(String(photo?.dataUrl || "").indexOf(",") + 1).replace(/\s/g, "");
  const recordedBytes = Number(photo?.bytes);
  const legacyBytes = Math.round(encoded.length * 3 / 4);
  return Number.isFinite(recordedBytes)
    && recordedBytes === legacyBytes
    && recordedBytes >= actualBytes
    && recordedBytes - actualBytes <= 2;
}

async function withSyncStage(stage, task) {
  try {
    return await task();
  } catch (error) {
    if (error && !error.syncStage) error.syncStage = stage;
    throw error;
  }
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hashBlob(blob) {
  return hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
}

async function decodeJpeg(blob) {
  const header = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  if (header.length !== 3 || header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff) throw new Error("写真データが正しくありません");
  const source = typeof createImageBitmap === "function" ? await createImageBitmap(blob) : await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("写真データを読み込めませんでした")); };
    image.src = url;
  });
  return source;
}

async function createPackage(queueItem) {
  const photo = bridge.getPhotoByUid(queueItem.photoUid);
  if (!photo) throw new Error("写真が見つかりません");
  if (String(photo.koujiId || "") !== String(queueItem.koujiId || "")) throw new Error("工事情報が一致しません");
  const project = bridge.getProjectById(queueItem.koujiId);
  if (!project || project.projectUid !== queueItem.projectUid) throw new Error("工事情報が一致しません");
  const blob = dataUrlToBlob(photo.dataUrl);
  if (Number(photo.bytes) && Number(photo.bytes) !== blob.size && !isLegacyBase64Size(photo, blob.size)) {
    throw new Error("写真データが一致しません");
  }
  const source = await decodeJpeg(blob);
  try {
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    if (Number(photo.width) !== width || Number(photo.height) !== height) throw new Error("写真データが一致しません");
    const sha256 = await hashBlob(blob);
    if (queueItem.sha256 && queueItem.sha256 !== sha256) throw new Error("写真データが一致しません");
    const scale = Math.min(1, 480 / Math.max(width, height));
    const thumbWidth = Math.max(1, Math.round(width * scale));
    const thumbHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;
    canvas.getContext("2d", { alpha: false }).drawImage(source, 0, 0, thumbWidth, thumbHeight);
    const thumbnailBlob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("サムネイルの作成に失敗しました")), "image/jpeg", 0.76));
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
  const authKey = AUTH_STORAGE_KEY;
  let session;
  try { session = JSON.parse(localStorage.getItem(authKey) || "null"); } catch (_) { session = null; }

  async function timedFetch(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    catch (error) {
      if (error?.name === "AbortError") throw new Error("接続先から応答がありませんでした。通信環境を確認して、もう一度お試しください");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function authFetch(path, options = {}) {
    const response = await timedFetch(`${config.projectUrl}/auth/v1/${path}`, {
      ...options, headers: { apikey: config.publishableKey, "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.msg || data.message || `認証に失敗しました。接続設定を確認してください`), { code: String(response.status) });
    return data;
  }

  async function ensureSession(forceRefresh = false) {
    const expiresSoon = !session?.access_token || Number(session.expires_at || 0) * 1000 < Date.now() + 60000;
    if (!forceRefresh && !expiresSoon) return session;
    if (session?.refresh_token) {
      try {
        session = await authFetch("token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: session.refresh_token }) });
      } catch (_) { session = null; }
    }
    if (!session?.access_token) session = await authFetch("signup", { method: "POST", body: "{}" });
    localStorage.setItem(authKey, JSON.stringify(session));
    return session;
  }

  async function api(path, { method = "GET", body, headers = {}, raw = false, retry = true } = {}) {
    await ensureSession();
    const response = await timedFetch(`${config.projectUrl}${path}`, {
      method, body: body == null ? undefined : raw ? body : JSON.stringify(body),
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${session.access_token}`, ...(raw ? {} : { "Content-Type": "application/json" }), ...headers }
    });
    if (response.status === 401 && retry) {
      await ensureSession(true);
      return api(path, { method, body, headers, raw, retry: false });
    }
    const text = await response.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch (_) { return text; } })() : null;
    if (!response.ok) throw Object.assign(new Error(data?.message || data?.msg || data?.error || `接続先との通信に失敗しました。通信環境を確認してください`), { code: data?.code || String(response.status), details: data?.details });
    return data;
  }

  function query(table, params = {}) {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => value != null && search.set(key, String(value)));
    return `/rest/v1/${table}?${search}`;
  }

  const oneOrNull = rows => Array.isArray(rows) && rows.length ? rows[0] : null;
  const insert = (table, body, onConflict = "") => api(`/rest/v1/${table}${onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : ""}`, {
    method: "POST", body, headers: { Prefer: `${onConflict ? "resolution=merge-duplicates," : ""}return=representation` }
  }).then(rows => oneOrNull(rows));

  return {
    async authenticate() {
      const current = await ensureSession();
      return current.user?.id;
    },
    async restoreMembership() {
      const rows = await api("/rest/v1/rpc/list_my_sites", { method: "POST", body: {} });
      if (!Array.isArray(rows) || rows.length !== 1) return null;
      const row = rows[0];
      return { siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name, siteStatus: row.site_status || "active", siteRevision: Number(row.site_revision || 1), role: row.member_role, deviceName: row.device_name || "この端末", updatedAt: row.site_updated_at, adminCodeConfigured: row.admin_code_configured === true };
    },
    async listMySites() {
      const rows = await api("/rest/v1/rpc/list_my_sites", { method: "POST", body: {} });
      return (rows || []).map(row => ({
        siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name,
        siteStatus: row.site_status || "active", siteRevision: Number(row.site_revision || 1),
        role: row.member_role, deviceName: row.device_name || "この端末",
        updatedAt: row.site_updated_at, adminCodeConfigured: row.admin_code_configured === true
      }));
    },
    async joinSite({ siteCode, joinCode, deviceName }) {
      const data = await api("/rest/v1/rpc/join_site", { method: "POST", body: { p_site_code: siteCode, p_join_code: joinCode, p_device_name: deviceName } });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.site_id) {
        if (row?.error_code === "temporarily_blocked") throw new Error("参加が一時的に制限されています。15分ほど待って再度お試しください");
        if (row?.error_code === "membership_disabled") throw new Error("この現場への参加は無効化されています");
        throw new Error("現場IDまたは参加コードが正しくありません");
      }
      return { siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name, role: row.member_role, deviceName };
    },
    async createSite({ siteName, siteCode, joinCode, deviceName, creationCode, adminCode }) {
      let data;
      try {
        data = await api("/rest/v1/rpc/create_site", {
          method: "POST",
          body: {
            p_site_name: siteName,
            p_site_code: siteCode,
            p_site_join_code: joinCode,
            p_device_name: deviceName,
            p_site_creation_code: creationCode,
            p_site_admin_code: adminCode
          }
        });
      } catch (_) {
        throw new Error("現場を作成できませんでした。接続状態を確認して、もう一度お試しください");
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.site_id) {
        if (row?.error_code === "temporarily_blocked") throw new Error("現場作成が一時的に制限されています。15分ほど待って再度お試しください");
        if (row?.error_code === "site_code_exists") throw new Error("その現場IDはすでに使用されています。別の現場IDを入力してください");
        if (row?.error_code === "creation_unavailable") throw new Error("現場作成機能がまだ準備されていません。管理者へ確認してください");
        if (row?.error_code === "auth_required") throw new Error("認証を確認できませんでした。接続先を保存し直してください");
        throw new Error("入力内容または現場作成コードを確認してください");
      }
      return { siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name, role: row.member_role, deviceName, adminCodeConfigured: row.admin_code_configured === true };
    },
    async claimSiteAdmin({ siteCode, adminCode, deviceName }) {
      const data = await api("/rest/v1/rpc/claim_site_admin", {
        method: "POST",
        body: { p_site_code: siteCode, p_site_admin_code: adminCode, p_device_name: deviceName }
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.site_id) {
        if (row?.error_code === "temporarily_blocked") throw new Error("確認回数が上限に達しました。15分ほど待って再度お試しください");
        throw new Error("現場管理コードが違うか、現在利用できません");
      }
      return {
        siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name,
        role: row.member_role, siteStatus: row.site_status || "active",
        siteRevision: Number(row.site_revision || 1),
        adminCodeConfigured: row.admin_code_configured === true, deviceName
      };
    },
    async refreshSite(siteId) {
      const row = oneOrNull(await api(query("sites", { select: "id,site_code,name,status,revision", id: `eq.${siteId}`, limit: 1 })));
      if (!row) throw new Error("共有工事の情報を確認できませんでした");
      return { siteId: row.id, siteCode: row.site_code, siteName: row.name, siteStatus: row.status || "active", siteRevision: Number(row.revision || 1) };
    },
    async siteRpc(name, body) {
      const result = await api(`/rest/v1/rpc/${name}`, { method: "POST", body });
      if (name === "list_site_members_admin") return result || [];
      return Array.isArray(result) ? result[0] : result;
    },
    async uploadPhotoPackage(pkg) {
      const { siteId, project, photo, originalBlob, thumbnail, eventId, deviceName } = pkg;
      let projectRow = oneOrNull(await withSyncStage("現場所属・工事情報確認", () => api(query("projects", { select: "id,project_uid", site_id: `eq.${siteId}`, project_uid: `eq.${project.projectUid}`, limit: 1 }))));
      if (!projectRow) {
        try { projectRow = await withSyncStage("工事情報登録", () => insert("projects", { site_id: siteId, project_uid: project.projectUid, kouji_id: project.koujiId, name: project.name, contractor: project.contractor })); }
        catch (error) {
          if (error.code !== "23505") throw error;
          projectRow = oneOrNull(await withSyncStage("工事情報再確認", () => api(query("projects", { select: "id,project_uid", site_id: `eq.${siteId}`, project_uid: `eq.${project.projectUid}`, limit: 1 }))));
        }
      }
      let photoRow = oneOrNull(await withSyncStage("写真メタデータ確認", () => api(query("photos", { select: "id,project_id,photo_uid,sha256,bytes", site_id: `eq.${siteId}`, photo_uid: `eq.${photo.photoUid}`, limit: 1 }))));
      if (photoRow && (photoRow.project_id !== projectRow.id || photoRow.sha256 !== photo.sha256 || Number(photoRow.bytes) !== photo.bytes)) throw new Error("同じ写真が別の情報で登録されています");
      if (!photoRow) {
        const sameHash = oneOrNull(await withSyncStage("写真重複確認", () => api(query("photos", { select: "photo_uid", site_id: `eq.${siteId}`, sha256: `eq.${photo.sha256}`, limit: 1 }))));
        if (sameHash) throw new Error("同じ写真がすでに登録されています");
        try {
          photoRow = await withSyncStage("写真メタデータ登録", () => insert("photos", { site_id: siteId, project_id: projectRow.id, photo_uid: photo.photoUid, captured_at: photo.capturedAt, sha256: photo.sha256, mime_type: "image/jpeg", width: photo.width, height: photo.height, bytes: photo.bytes, metadata: photo.metadata }));
        } catch (error) {
          if (error.code !== "23505") throw error;
          photoRow = oneOrNull(await withSyncStage("写真メタデータ再確認", () => api(query("photos", { select: "id,project_id,photo_uid,sha256,bytes", site_id: `eq.${siteId}`, photo_uid: `eq.${photo.photoUid}`, limit: 1 }))));
        }
        if (photoRow.project_id !== projectRow.id || photoRow.sha256 !== photo.sha256 || Number(photoRow.bytes) !== photo.bytes) throw new Error("同じ写真が別の情報で登録されています");
      }
      const originalPath = `${siteId}/photos/${photo.photoUid}.jpg`;
      const thumbnailPath = `${siteId}/thumbnails/${photo.photoUid}.jpg`;
      const existing = oneOrNull(await withSyncStage("送信状況確認", () => api(query("photo_objects", { select: "status,object_path,sha256,bytes,upload_completed_at,thumbnail_object_path,thumbnail_sha256,thumbnail_bytes", photo_id: `eq.${photoRow.id}`, limit: 1 }))));
      if (existing?.status === "complete") {
        const same = existing.object_path === originalPath && existing.sha256 === photo.sha256 && Number(existing.bytes) === photo.bytes
          && existing.thumbnail_object_path === thumbnailPath && existing.thumbnail_sha256 === thumbnail.sha256 && Number(existing.thumbnail_bytes) === thumbnail.bytes;
        if (!same) throw new Error("登録内容が一致しません");
      } else {
        await withSyncStage("原寸Storage送信", () => api(`/storage/v1/object/site-photos/${originalPath}`, { method: "POST", body: originalBlob, raw: true, headers: { "Content-Type": "image/jpeg", "x-upsert": "true", "cache-control": "max-age=31536000" } }));
        await withSyncStage("サムネイルStorage送信", () => api(`/storage/v1/object/site-photos/${thumbnailPath}`, { method: "POST", body: thumbnail.blob, raw: true, headers: { "Content-Type": "image/jpeg", "x-upsert": "true", "cache-control": "max-age=31536000" } }));
        const completedAt = new Date().toISOString();
        await withSyncStage("送信完了情報登録", () => insert("photo_objects", {
          photo_id: photoRow.id, site_id: siteId, bucket_id: "site-photos", object_path: originalPath, sha256: photo.sha256,
          bytes: photo.bytes, status: "complete", upload_completed_at: completedAt, thumbnail_object_path: thumbnailPath,
          thumbnail_sha256: thumbnail.sha256, thumbnail_bytes: thumbnail.bytes, thumbnail_width: thumbnail.width, thumbnail_height: thumbnail.height
        }, "photo_id"));
      }
      const stored = oneOrNull(await withSyncStage("送信完了確認", () => api(query("photo_objects", { select: "status,sha256,bytes,thumbnail_sha256,thumbnail_bytes,upload_completed_at", photo_id: `eq.${photoRow.id}`, limit: 1 }))));
      if (stored.status !== "complete" || stored.sha256 !== photo.sha256 || Number(stored.bytes) !== photo.bytes || stored.thumbnail_sha256 !== thumbnail.sha256 || Number(stored.thumbnail_bytes) !== thumbnail.bytes || !stored.upload_completed_at) throw new Error("送信後の確認に失敗しました");
      try { await withSyncStage("同期イベント登録", () => insert("sync_events", { event_id: eventId, site_id: siteId, entity_type: "photo", entity_id: photoRow.id, event_type: "photo_synced", device_name: deviceName, payload: { photoUid: photo.photoUid, sha256: photo.sha256 }, created_at: stored.upload_completed_at })); }
      catch (error) { if (error.code !== "23505") throw error; }
      return { storedAt: stored.upload_completed_at };
    }
  };
}

function classifyError(error) {
  const text = String(error?.message || error || "エラーが発生しました");
  const code = String(error?.code || "");
  if (/jwt|session|auth|sign.?in/i.test(text) || ["401", "PGRST301"].includes(code)) return { type: "auth", message: "認証の有効期限が切れました。もう一度接続してください" };
  if (/row.level|permission|policy|forbidden/i.test(text) || ["403", "42501"].includes(code)) return { type: "permission", message: "送信する権限がありません" };
  if (/quota|insufficient storage/i.test(text) || code === "507") return { type: "quota", message: "保存容量が不足しています" };
  if (/fetch|network|offline|connection/i.test(text)) return { type: "network", message: "通信に失敗しました。接続を確認してください" };
  return { type: "integrity", message: text };
}

async function settings() {
  const value = await getSetting(SETTINGS_KEY);
  return { mode: MODES.has(value?.mode) ? value.mode : "wifi_only", anyNetworkConfirmed: value?.anyNetworkConfirmed === true };
}

async function queuePhoto(photo, project, fixedIdentity) {
  if (!UUID_RE.test(photo.photoUid || "")) throw new Error("写真の識別情報が正しくありません");
  if (!UUID_RE.test(project.projectUid || "")) throw new Error("工事の識別情報が正しくありません");
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

function siteStatusLabel(value) {
  return ({ active: "利用中", closed: "終了済み", trashed: "ごみ箱" })[value] || value;
}

function renderSiteList() {
  const rows = memberships.filter(item => item.siteStatus === siteStatusFilter);
  ui.siteList.replaceChildren(...rows.map(item => {
    const card = document.createElement("div");
    card.className = "cloud-site-item";
    if (item.siteId === identity?.siteId) card.classList.add("selected");
    const title = document.createElement("h4");
    title.textContent = item.siteName;
    const meta = document.createElement("p");
    const updated = item.updatedAt ? new Date(item.updatedAt).toLocaleString("ja-JP") : "―";
    meta.textContent = `${item.siteCode} / ${roleLabel(item.role)} / ${siteStatusLabel(item.siteStatus)} / 最終更新 ${updated}`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.siteId === identity?.siteId ? "この工事を表示中" : "この工事を開く";
    button.disabled = item.siteId === identity?.siteId;
    button.addEventListener("click", () => switchSite(item));
    card.append(title, meta, button);
    return card;
  }));
  ui.siteListEmpty.hidden = rows.length > 0;
  document.querySelectorAll("[data-cloud-site-status]").forEach(button => {
    button.classList.toggle("active", button.dataset.cloudSiteStatus === siteStatusFilter);
  });
}

async function refreshMemberships() {
  memberships = provider?.listMySites ? await provider.listMySites() : [];
  const current = memberships.find(item => item.siteId === identity?.siteId);
  if (current) identity = { ...identity, ...current };
}

async function switchSite(item) {
  if (siteActionBusy || !item?.siteId) return;
  siteActionBusy = true;
  try {
    identity = { ...identity, ...item };
    await setSetting(IDENTITY_KEY, identity);
    message(`${item.siteName}を開きました`);
    await render();
  } catch (error) {
    message(error?.message || "工事を切り替えられませんでした", true);
  } finally {
    siteActionBusy = false;
    await render();
  }
}

async function renderMembers() {
  if (!provider || identity?.role !== "admin") return;
  try {
    const rows = await provider.siteRpc("list_site_members_admin", { p_site_id: identity.siteId });
    ui.memberList.replaceChildren(...rows.map(member => {
      const row = document.createElement("div");
      row.className = "cloud-member-item";
      const text = document.createElement("span");
      text.textContent = `${member.device_name} / ${roleLabel(member.member_role)} / ${new Date(member.last_seen_at).toLocaleString("ja-JP")} / ${member.active ? "有効" : "停止中"}${member.is_current_device ? "（この端末）" : ""}`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = member.active ? "停止" : "再開";
      button.addEventListener("click", () => toggleMember(member));
      row.append(text, button);
      return row;
    }));
  } catch (_) {
    ui.memberList.textContent = "端末一覧を確認できませんでした";
  }
}

async function toggleMember(member) {
  const nextActive = !member.active;
  if (member.is_current_device && !nextActive
      && !confirm("この端末を停止すると、この工事を操作できなくなります。別の有効な管理者端末があることを確認しましたか？")) return;
  if (!member.is_current_device && !confirm(`${member.device_name}を${nextActive ? "再開" : "停止"}しますか？`)) return;
  await runAdminAction(nextActive ? "端末を再開" : "端末を停止", async () => {
    await provider.siteRpc("set_site_member_active_v2", {
      p_site_id: identity.siteId, p_member_id: member.member_id,
      p_active: nextActive, p_expected_revision: identity.siteRevision
    });
    if (member.is_current_device && !nextActive) {
      identity = { userId: identity.userId };
      await refreshMemberships();
      await setSetting(IDENTITY_KEY, identity);
      return { skipRefresh: true };
    }
    return null;
  });
}

async function render() {
  const rows = await getQueue();
  const summary = summarize(rows);
  const network = networkStatus();
  const configured = Boolean(provider && identity?.siteId);
  ui.site.textContent = identity?.siteName || identity?.siteCode || "未接続";
  ui.role.textContent = roleLabel(identity?.role);
  ui.network.textContent = networkLabel(network);
  ui.pending.textContent = `${summary.pending + summary.paused + summary.error}件 / ${formatBytes(summary.bytes)}`;
  ui.synced.textContent = `${summary.synced}件`;
  ui.errors.textContent = `${summary.error}件`;
  ui.progress.max = Math.max(1, summary.total);
  ui.progress.value = Math.min(summary.total, summary.synced + summary.error);
  const writable = configured && identity?.siteStatus !== "closed" && identity?.siteStatus !== "trashed";
  ui.now.disabled = busy || !writable || summary.pending === 0 || network === "offline" || identity?.role === "viewer";
  ui.pause.disabled = summary.pending === 0;
  ui.resume.disabled = summary.paused === 0;
  ui.retry.disabled = summary.error === 0;
  ui.retry.style.display = summary.error === 0 ? "none" : "";
  ui.enqueue.disabled = !writable || identity?.role === "viewer" || !ui.project.value;
  ui.createSite.disabled = siteActionBusy || !provider;
  ui.join.disabled = siteActionBusy || !provider;
  ui.adminClaim.disabled = siteActionBusy || !provider;
  ui.badge.textContent = `未送信 ${summary.pending + summary.paused + summary.error}件`;
  ui.badge.classList.toggle("show", configured || summary.total > 0);
  const admin = configured && identity?.role === "admin";
  ui.adminPanel.hidden = !admin;
  ui.nonAdminNotice.hidden = !configured || admin;
  ui.adminCodeUnavailable.hidden = !configured || Boolean(identity?.adminCodeConfigured);
  ui.openAdminClaim.hidden = !identity?.adminCodeConfigured;
  ui.siteListPanel.hidden = !provider || memberships.length === 0;
  renderSiteList();
  if (admin) {
    if (document.activeElement !== ui.adminSiteName) ui.adminSiteName.value = identity.siteName || "";
    if (document.activeElement !== ui.adminSiteCode) ui.adminSiteCode.value = identity.siteCode || "";
    ui.adminClose.style.display = identity.siteStatus === "closed" ? "none" : "";
    ui.adminReopen.style.display = identity.siteStatus === "closed" ? "" : "none";
    ui.adminTrash.style.display = identity.siteStatus === "trashed" ? "none" : "";
    ui.adminRestore.style.display = identity.siteStatus === "trashed" ? "" : "none";
    ui.deleteEmptyBox.hidden = identity.siteStatus !== "trashed";
    ui.adminAccessStatus.textContent = identity.adminCodeConfigured
      ? "別端末から管理者として入れる設定済みです。変更すると旧コードは直ちに使えなくなります。"
      : "別端末から管理するため、現場管理コードを設定してください。";
    ui.adminAccessSave.textContent = identity.adminCodeConfigured
      ? "現場管理コードを変更" : "現場管理コードを設定";
    await renderMembers();
  }
}

async function refreshIdentitySite() {
  if (!provider || !identity?.siteId) return;
  identity = { ...identity, ...(await provider.refreshSite(identity.siteId)) };
  await setSetting(IDENTITY_KEY, identity);
  await render();
}

async function runAdminAction(label, action) {
  if (identity?.role !== "admin" || siteActionBusy) return;
  siteActionBusy = true;
  try {
    message(`${label}しています…`);
    const result = await action();
    if (!result?.skipRefresh) {
      await refreshIdentitySite();
      await refreshMemberships();
    }
    message(`${label}しました`);
  } catch (error) {
    message(/revision_conflict/i.test(error.message)
      ? "別の端末で工事情報が更新されました。最新情報を確認して、もう一度操作してください"
      : (error.message || `${label}できませんでした`), true);
  } finally {
    siteActionBusy = false;
  }
}

async function processQueue({ manual = false } = {}) {
  if (busy || paused || !provider || !identity?.siteId || identity.role === "viewer" || ["closed","trashed"].includes(identity.siteStatus)) return;
  const currentSettings = await settings();
  const network = networkStatus();
  const rows = (await getQueue()).filter(row => row.siteId === identity.siteId && row.status === "pending");
  if (!rows.length) return render();
  if (network === "offline") return message("オフラインのため送信できません", true);
  if (!manual) {
    if (currentSettings.mode === "manual") return;
    if (currentSettings.mode === "wifi_only" && network !== "wifi") {
      return message(network === "unknown"
        ? "Wi-Fi接続を確認できないため、写真を端末に保存しています"
        : `${networkLabel(network)}のため写真はこの端末に保存しています`);
    }
    if (currentSettings.mode === "any_network" && !currentSettings.anyNetworkConfirmed) return;
  }
  if (manual && ["mobile", "unknown"].includes(network)) {
    const total = rows.reduce((sum, row) => sum + Number(row.bytes || 0), 0);
    if (!confirm(`未送信の写真${rows.length}件（${formatBytes(total)}）を${networkLabel(network)}で送信します。\nよろしいですか？`)) return;
  }
  busy = true;
  await render();
  try {
    for (let index = 0; index < rows.length && !paused; index += 1) {
      const item = rows[index];
      if (item.siteId !== identity.siteId) continue;
      await updateQueueItem(item.queueId, { status: "uploading", attempts: Number(item.attempts || 0) + 1, lastError: "" });
      message(`送信中 ${index + 1}/${rows.length}件`);
      let stage = "送信準備";
      try {
        const pkg = await createPackage(item);
        await updateQueueItem(item.queueId, { sha256: pkg.photo.sha256, bytes: pkg.photo.bytes });
        stage = "クラウド保存";
        const result = await provider.uploadPhotoPackage(pkg);
        stage = "ローカル送信状態更新";
        await updateQueueItem(item.queueId, { status: "synced", syncedAt: result.storedAt, lastError: "", errorType: "" });
      } catch (error) {
        const classified = classifyError(error);
        const failedStage = error.syncStage || stage;
        const retryable = ["network", "auth"].includes(classified.type);
        console.error("[aoPIC cloud sync] 送信失敗", { stage: failedStage, photo: String(item.photoUid || "").slice(0, 8), code: String(error?.code || ""), type: classified.type });
        const detailedMessage = `${failedStage}: ${classified.message}`;
        await updateQueueItem(item.queueId, { status: retryable ? "pending" : "error", errorType: classified.type, lastError: detailedMessage });
        message(detailedMessage, true);
        if (retryable) break;
      }
      await render();
    }
    if (!paused) {
      const remaining = (await getQueue()).filter(row => row.siteId === identity.siteId);
      const hasPending = remaining.some(row => row.status === "pending");
      const errorCount = remaining.filter(row => row.status === "error").length;
      if (!hasPending && errorCount > 0) {
        message(`送信できなかった写真が${errorCount}件あります。「失敗分を再送信」を押してください`, true);
      } else if (!hasPending) {
        message("未送信の写真をすべて送信しました");
      }
    }
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
  await refreshMemberships();
  const selected = memberships.find(item => item.siteId === identity.siteId);
  if (selected) identity = { ...identity, ...selected };
  else if (memberships.length === 1) identity = { ...identity, ...memberships[0] };
  else if (identity.siteId) identity = { userId };
  await setSetting(IDENTITY_KEY, identity);
  localStorage.setItem(MODE_KEY, "cloud");
  if (!quiet) message(identity.siteId
    ? `${identity.siteName || identity.siteCode}に接続しました`
    : "接続先を確認しました。新しい現場を作成するか、既存の現場へ参加してください");
  await render();
  if (identity.siteId) processQueue();
}

async function enqueueSavedPhoto(photoUid) {
  if (!provider || !identity?.siteId || identity.role === "viewer" || ["closed","trashed"].includes(identity.siteStatus)) return;
  const photo = bridge.getPhotoByUid(photoUid);
  const project = photo ? bridge.getProjectById(photo.koujiId) : null;
  if (!photo || !project?.projectUid) return;
  await queuePhoto(photo, project, structuredClone(identity));
  await render();
  processQueue();
}

async function populateProjects() {
  const projects = bridge.getProjects().filter(project => UUID_RE.test(project.projectUid || ""));
  ui.project.replaceChildren(new Option("工事を選ぶ", ""), ...projects.map(project => new Option(project.name, project.id)));
}

ui.saveConfig.addEventListener("click", async () => {
  try {
    const saved = readConfig();
    const config = validateConfig({
      projectUrl: ui.projectUrl.value || deploymentConfig?.projectUrl || saved?.projectUrl,
      publishableKey: ui.publishableKey.value || deploymentConfig?.publishableKey || saved?.publishableKey
    });
    message("接続先を確認しています…");
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    await connect(config);
    ui.publishableKey.value = "";
  } catch (error) { message(error.message, true); }
});

ui.localMode.addEventListener("click", async () => {
  provider = null;
  localStorage.setItem(MODE_KEY, "local");
  message("この端末だけで使う設定に切り替えました。送信待ちの写真は送信されません");
  await render();
});

ui.createSite.addEventListener("click", async () => {
  if (!provider) return message("先に接続先を保存してください", true);
  if (siteActionBusy) return;
  siteActionBusy = true;
  try {
    await render();
    const input = validateSiteCreation({
      siteName: ui.createSiteName.value,
      siteCode: ui.createSiteCode.value,
      joinCode: ui.createJoinCode.value,
      joinCodeConfirm: ui.createJoinCodeConfirm.value,
      adminCode: ui.createAdminCode.value,
      adminCodeConfirm: ui.createAdminCodeConfirm.value,
      deviceName: ui.createDeviceName.value,
      creationCode: ui.creationCode.value
    });
    message("新しい共有現場を作成しています…");
    const created = await provider.createSite(input);
    identity = { userId: identity?.userId, ...created };
    await refreshMemberships();
    await setSetting(IDENTITY_KEY, identity);
    await refreshIdentitySite();
    ui.createSiteCode.value = created.siteCode;
    message(`${identity.siteName || identity.siteCode}を作成しました。あなたは管理者です。既存写真は自動送信されません`);
    bridge.showCamera?.();
    await render();
  } catch (error) {
    message(error.message || "現場を作成できませんでした", true);
  } finally {
    ui.createJoinCode.value = "";
    ui.createJoinCodeConfirm.value = "";
    ui.createAdminCode.value = "";
    ui.createAdminCodeConfirm.value = "";
    ui.creationCode.value = "";
    siteActionBusy = false;
    await render();
  }
});

ui.join.addEventListener("click", async () => {
  if (!provider) return message("先に接続先を保存してください", true);
  if (siteActionBusy) return;
  siteActionBusy = true;
  try {
    await render();
    const joined = await provider.joinSite({ siteCode: ui.siteCode.value.trim(), joinCode: ui.joinCode.value, deviceName: ui.deviceName.value.trim() || "この端末" });
    identity = { ...identity, ...joined };
    await refreshMemberships();
    await setSetting(IDENTITY_KEY, identity);
    await refreshIdentitySite();
    message(`${identity.siteName || identity.siteCode}に参加しました（${roleLabel(identity.role)}）`);
    bridge.showCamera?.();
    await render();
  } catch (error) {
    message(error.message || "参加できませんでした", true);
  } finally {
    ui.joinCode.value = "";
    siteActionBusy = false;
    await render();
  }
});

ui.adminClaim.addEventListener("click", async () => {
  if (!provider) return message("先に工事の共有を開始してください", true);
  if (siteActionBusy) return;
  siteActionBusy = true;
  try {
    const claimed = await provider.claimSiteAdmin({
      siteCode: ui.adminClaimSiteCode.value.trim(),
      adminCode: ui.adminClaimCode.value,
      deviceName: ui.adminClaimDeviceName.value.trim() || "この端末"
    });
    identity = { ...identity, ...claimed };
    await refreshMemberships();
    await setSetting(IDENTITY_KEY, identity);
    message("管理者として接続しました");
  } catch (error) {
    message(error?.message || "現場管理コードが違うか、現在利用できません", true);
  } finally {
    ui.adminClaimCode.value = "";
    siteActionBusy = false;
    await render();
  }
});
ui.openAdminClaim.addEventListener("click", () => {
  ui.adminClaimSiteCode.value = identity?.siteCode || "";
  ui.adminClaimDeviceName.value = identity?.deviceName || "この端末";
  ui.adminClaimCode.focus();
});
document.querySelectorAll("[data-cloud-site-status]").forEach(button => button.addEventListener("click", () => {
  siteStatusFilter = button.dataset.cloudSiteStatus;
  renderSiteList();
}));

ui.mode.addEventListener("change", async () => {
  const previous = await settings();
  if (ui.mode.value === "any_network" && !previous.anyNetworkConfirmed) {
    if (!confirm("モバイル通信を含むすべての回線で写真を自動送信します。通信量が発生する場合があります。よろしいですか？")) {
      ui.mode.value = previous.mode;
      return;
    }
  }
  await setSetting(SETTINGS_KEY, { mode: ui.mode.value, anyNetworkConfirmed: ui.mode.value === "any_network" });
  message(`送信タイミングを「${ui.mode.options[ui.mode.selectedIndex].textContent}」に変更しました`);
  processQueue();
});
ui.project.addEventListener("change", render);

ui.enqueue.addEventListener("click", async () => {
  if (!identity?.siteId || identity.role === "viewer") return;
  const project = bridge.getProjectById(ui.project.value);
  if (!project) return;
  const photos = bridge.getPhotos().filter(photo => String(photo.koujiId || "") === String(project.id));
  const total = photos.reduce((sum, photo) => sum + Number(photo.bytes || 0), 0);
  if (!photos.length) return message("追加できる写真がありませんでした");
  if (!confirm(`「${project.name}」の写真${photos.length}件（${formatBytes(total)}）を送信対象に追加します。よろしいですか？`)) return;
  let added = 0;
  for (const photo of photos) if (await queuePhoto(photo, project, structuredClone(identity))) added += 1;
  message(`${added}件を送信対象に追加しました`);
  await render();
  processQueue();
});

ui.now.addEventListener("click", () => processQueue({ manual: true }));
ui.pause.addEventListener("click", async () => {
  paused = true;
  const rows = await getQueue();
  await Promise.all(rows.filter(row => row.siteId === identity?.siteId && row.status === "pending").map(row => updateQueueItem(row.queueId, { status: "paused" })));
  message("写真の送信を一時停止しました。未送信の写真は端末内に保持されています");
  await render();
});
ui.resume.addEventListener("click", async () => {
  paused = false;
  const rows = await getQueue();
  await Promise.all(rows.filter(row => row.siteId === identity?.siteId && row.status === "paused").map(row => updateQueueItem(row.queueId, { status: "pending" })));
  message("写真の送信を再開しました。現在の通信設定に従って送信します");
  await render();
  processQueue();
});
ui.retry.addEventListener("click", async () => {
  const rows = await getQueue();
  await Promise.all(rows.filter(row => row.siteId === identity?.siteId && row.status === "error").map(row => updateQueueItem(row.queueId, { status: "pending", errorType: "", lastError: "" })));
  message("失敗した写真を送信待ちへ戻し、再送を開始しました");
  await render();
  processQueue({ manual: true });
});
ui.adminSave.addEventListener("click", () => runAdminAction("工事情報を保存", async () => {
  await provider.siteRpc("update_site", {
    p_site_id: identity.siteId, p_expected_revision: identity.siteRevision,
    p_name: ui.adminSiteName.value, p_site_code: ui.adminSiteCode.value
  });
}));
ui.adminRotateCode.addEventListener("click", () => runAdminAction("参加コードを変更", async () => {
  const code = ui.adminJoinCode.value;
  if (!code || code !== ui.adminJoinCodeConfirm.value) throw new Error("参加コードと確認入力が一致しません");
  await provider.siteRpc("rotate_site_join_code", { p_site_id: identity.siteId, p_new_code: code, p_grant_role: "editor" });
  ui.adminJoinCode.value = "";
  ui.adminJoinCodeConfirm.value = "";
}));
ui.adminAccessSave.addEventListener("click", () => runAdminAction(
  identity?.adminCodeConfigured ? "現場管理コードを変更" : "現場管理コードを設定",
  async () => {
    try {
      const code = validateAdminCode(ui.adminAccessCode.value, ui.adminAccessCodeConfirm.value);
      await provider.siteRpc(
        identity.adminCodeConfigured ? "rotate_site_admin_code" : "set_initial_site_admin_code",
        { p_site_id: identity.siteId, p_expected_revision: identity.siteRevision, p_new_code: code }
      );
      identity.adminCodeConfigured = true;
    } finally {
      ui.adminAccessCode.value = "";
      ui.adminAccessCodeConfirm.value = "";
    }
  }
));
ui.adminClose.addEventListener("click", async () => {
  const rows = await getQueue(), count = rows.filter(row => row.siteId === identity?.siteId && ["pending","paused","error"].includes(row.status)).length;
  if (!confirm(`工事を終了すると新しい参加と写真送信が止まります。写真・台帳・参加者は削除されません。${count ? `\n送信待ちの写真が${count}件あります。` : ""}\nよろしいですか？`)) return;
  runAdminAction("工事を終了", () => provider.siteRpc("close_site", { p_site_id: identity.siteId, p_expected_revision: identity.siteRevision }));
});
ui.adminReopen.addEventListener("click", () => runAdminAction("工事を再開", () => provider.siteRpc("reopen_site", { p_site_id: identity.siteId, p_expected_revision: identity.siteRevision })));
ui.adminTrash.addEventListener("click", () => {
  if (prompt("ごみ箱へ移動しても写真は削除されません。確認のため工事名を入力してください。") !== identity.siteName) return;
  runAdminAction("工事をごみ箱へ移動", () => provider.siteRpc("trash_site", { p_site_id: identity.siteId, p_expected_revision: identity.siteRevision }));
});
ui.adminRestore.addEventListener("click", () => runAdminAction("工事を復元", () => provider.siteRpc("restore_site", {
  p_site_id: identity.siteId, p_expected_revision: identity.siteRevision
})));
ui.adminDeleteEmpty.addEventListener("click", () => {
  const confirmed = prompt("空工事であることを共有先で再確認します。完全削除する工事名を入力してください。");
  if (confirmed !== identity.siteName) return;
  runAdminAction("この工事を完全に削除", async () => {
    await provider.siteRpc("delete_empty_site", {
      p_site_id: identity.siteId, p_expected_revision: identity.siteRevision, p_confirm_name: confirmed
    });
    identity = { userId: identity.userId };
    await refreshMemberships();
    await setSetting(IDENTITY_KEY, identity);
    return { skipRefresh: true };
  });
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
  deploymentConfig = await readDeploymentConfig();
  const config = deploymentConfig || readConfig();
  const deviceCandidate = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "現場スマートフォン" : "この端末";
  if (!ui.createDeviceName.value || ui.createDeviceName.value === "この端末") ui.createDeviceName.value = deviceCandidate;
  if (!ui.deviceName.value || ui.deviceName.value === "この端末") ui.deviceName.value = deviceCandidate;
  if (!ui.adminClaimDeviceName.value || ui.adminClaimDeviceName.value === "この端末") ui.adminClaimDeviceName.value = deviceCandidate;
  if (deploymentConfig) {
    ui.projectUrl.value = deploymentConfig.projectUrl;
    message(["localhost", "127.0.0.1"].includes(location.hostname)
      ? "ローカル設定ファイルから接続先を読み込みました"
      : "工事の共有を利用できます。開始する場合は「工事の共有を開始」を押してください");
  }
  if (config && localStorage.getItem(MODE_KEY) === "cloud" && hasStoredAuthSession()) {
    message("接続先を確認しています…");
    await connect(config, true);
    message(identity?.siteId
      ? `${identity.siteName || identity.siteCode}に接続しました`
      : "準備ができました。新しい共有工事を作るか、工事へ参加してください");
  } else {
    if (localStorage.getItem(MODE_KEY) === "cloud") localStorage.setItem(MODE_KEY, "local");
    message(config
      ? "この端末だけで使っています。工事を共有する場合は「工事の共有を開始」を押してください"
      : "この端末だけで使う設定になっています");
  }
}

init().catch(error => message(error.message || "初期化に失敗しました", true));
