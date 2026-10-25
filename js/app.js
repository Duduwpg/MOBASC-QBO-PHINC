// Inventory Count: scan barcodes on a phone and fill in QBO's Physical Inventory Worksheet.
// Everything stays on the phone (localStorage). Files go in and out by the phone's own
// file picker and share sheet; nothing is sent to any server.
import { readCode } from "./codes.js";
import { readWorksheet, buildExport, lotText, fmt, round } from "./sheet.js";

const VERSION = "2026-10-26.6";
const STATE_KEY = "invCount.state.v1";
const CODES_KEY = "invCount.codes.v1";
const SAME_CODE_GAP_MS = 1200;   // the same code must leave the view this long to count again
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "itf",
  "databar", "databar_expanded", "databar_limited", "data_matrix", "qr_code", "micro_qr_code",
  "rm_qr_code", "pdf417"];

const $ = id => document.getElementById(id);

// ---------- storage (always wrapped: private tabs and full storage throw) ----------
let storageOk = true;
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { storageOk = false; return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { storageOk = false; showBanner(); }
}

const state = Object.assign({
  counter: "", deviceId: "", sound: true, askQty: false, pack: null, counts: {}, others: [], log: [],
}, load(STATE_KEY, {}));
if (!state.deviceId) state.deviceId = Math.random().toString(36).slice(2, 10);
let codes = load(CODES_KEY, {});
let sheet = null;          // parsed worksheet
let byKey = new Map();     // item key -> item
let current = null;        // item shown on the card
let lastScan = null;       // {code, itemKey} of the latest scan, for "wrong item"
let filter = "todo";

function persist() { save(STATE_KEY, state); }
function persistCodes() { save(CODES_KEY, codes); }

// ---------- worksheet ----------
function usePack(pack) {
  sheet = readWorksheet(pack.csv, pack.rows || null);
  byKey = new Map(sheet.items.map(it => [it.key, it]));
  state.pack = pack;
}

function itemFor(entry) {
  if (!entry) return null;
  return byKey.get(entry.key) || sheet.items.find(it => it.name === entry.name) || null;
}

// ---------- counts ----------
function mine(key) { return state.counts[key]; }

function change(key, delta, lot) {
  const first = state.counts[key]?.q == null;
  const c = state.counts[key] || (state.counts[key] = { q: 0, lots: {} });
  if (c.q == null) c.q = 0;
  c.q = Math.max(0, round(c.q + delta));
  if (lot) {
    c.lots[lot] = Math.max(0, round((c.lots[lot] || 0) + delta));
    if (!c.lots[lot]) delete c.lots[lot];
  }
  state.log.push({ key, delta, lot: lot || "", first });
  if (state.log.length > 300) state.log.shift();
  persist();
}

function setQty(key, q) {
  const first = state.counts[key]?.q == null;
  const c = state.counts[key] || (state.counts[key] = { q: 0, lots: {} });
  const before = c.q ?? 0;
  c.q = round(q);
  state.log.push({ key, delta: round(c.q - before), lot: "", set: true, first });
  persist();
}

function undo() {
  const e = state.log.pop();
  if (!e) return toast("Nothing to undo");
  const c = state.counts[e.key];
  if (c) {
    c.q = Math.max(0, round((c.q || 0) - e.delta));
    if (e.lot) {
      c.lots[e.lot] = Math.max(0, round((c.lots[e.lot] || 0) - e.delta));
      if (!c.lots[e.lot]) delete c.lots[e.lot];
    }
    if (!c.q && !Object.keys(c.lots).length && e.first) delete state.counts[e.key];
  }
  persist();
  const it = byKey.get(e.key);
  if (it) showCard(it);
  render();
  toast(`Undone: ${it ? it.name : "last change"}`);
}

function totals() {
  const out = {};
  const add = (who, counts) => {
    for (const [key, c] of Object.entries(counts || {})) {
      if (c == null || c.q == null) continue;
      const t = out[key] || (out[key] = { q: 0, lots: {}, by: {} });
      t.q = round(t.q + c.q);
      t.by[who] = round((t.by[who] || 0) + c.q);
      for (const [lot, n] of Object.entries(c.lots || {})) t.lots[lot] = round((t.lots[lot] || 0) + n);
    }
  };
  add(state.counter || "This phone", state.counts);
  for (const o of state.others) add(o.counter || o.deviceId, o.counts);
  return out;
}

// ---------- scanning ----------
let detector = null, stream = null, scanning = false, busy = false, wakeLock = null;
let seen = { key: "", at: 0 };
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

async function getDetector() {
  if (detector) return detector;
  const api = window.BarcodeDetectionAPI;
  if (!api) throw new Error("The barcode reader did not load. Reload the page.");
  api.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => path.endsWith(".wasm") ? new URL("vendor/" + path, location.href).href : prefix + path,
    },
    fireImmediately: true,
  });
  const supported = await api.BarcodeDetector.getSupportedFormats();
  detector = new api.BarcodeDetector({ formats: FORMATS.filter(f => supported.includes(f)) });
  return detector;
}

async function startCamera() {
  try {
    await getDetector();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    const msg = e && e.name === "NotAllowedError"
      ? "Camera blocked. Allow camera access for this site in the browser settings, then try again."
      : `Camera did not start: ${e.message || e}`;
    return toast(msg, 6000);
  }
  const video = $("video");
  video.srcObject = stream;
  await video.play().catch(() => {});
  const track = stream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch { /* not supported */ }
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  $("torchBtn").hidden = !caps.torch;
  $("camIdle").hidden = true;
  $("camBtn").textContent = "Stop";
  $("camBtn").classList.remove("primary");
  scanning = true;
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* optional */ }
  unlockAudio();
  loop();
}

function stopCamera() {
  scanning = false;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  $("video").srcObject = null;
  $("camIdle").hidden = false;
  $("torchBtn").hidden = true;
  $("camBtn").textContent = "Start scanning";
  $("camBtn").classList.add("primary");
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

let torchOn = false;
async function toggleTorch() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
}

// Read the area inside the aiming box only: faster, and avoids reading a neighbouring box.
function grabFrame(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sx = vw * 0.06, sy = vh * 0.16, sw = vw * 0.88, sh = vh * 0.68;
  const scale = Math.min(1, 1280 / sw);
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function loop() {
  if (!scanning) return;
  // While a dialog is open, treat the last code as still in view: when the dialog closes, a
  // barcode still in front of the camera must leave the view before it counts again.
  if (document.querySelector("dialog[open]")) seen.at = Date.now();
  else if (!busy) {
    busy = true;
    try {
      const frame = grabFrame($("video"));
      const found = frame ? await detector.detect(frame) : [];
      const now = Date.now();
      if (found.length) {
        const b = found[0];
        const code = readCode(b.format, b.rawValue);
        if (code.key === seen.key && now - seen.at < SAME_CODE_GAP_MS) seen.at = now;
        else { seen = { key: code.key, at: now }; onCode(code, b.format); }
      }
    } catch (e) {
      console.error(e);
    }
    busy = false;
  }
  requestAnimationFrame(loop);
}

function onCode(code, format) {
  const entry = codes[code.key];
  const it = itemFor(entry);
  if (!it) return teach(code, format);
  countScan(it, code);
}

// Normally a scan counts 1. With "Ask how many on each scan" on, it asks for the number of
// that item in front of the counter and adds it (a stack of 6 boxes = one scan + "6").
async function countScan(it, code) {
  const lot = code.lot || code.expiry ? `${code.lot}|${code.expiry}` : "";
  let n = 1;
  if (state.askQty) {
    feedback(it.retired ? "retired" : "ok");
    showCard(it, true);
    const so = mine(it.key)?.q;
    const v = await ask(it.name,
      `${howToCount(it) ? howToCount(it) + " " : ""}How many here? This is added to the count` +
      (so ? ` (counted so far: ${fmt(so)}).` : "."), "1", true);
    if (v == null || v === "") { toast("Not counted."); return; }
    n = Number(v.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { toast("That is not a number. Not counted."); return; }
    if (n === 0) { toast("Nothing added."); return; }
  }
  change(it.key, n, lot);
  lastScan = { code, itemKey: it.key };
  showCard(it, true);
  render();
  if (!state.askQty) feedback(it.retired ? "retired" : "ok");
  else if (n !== 1) toast(`Added ${fmt(n)}: ${it.name}`);
}

// ---------- teach an unknown barcode ----------
let teachCode = null;

function teach(code, format, reteach = false) {
  teachCode = { code, format, reteach };
  feedback("unknown");
  $("teachTitle").textContent = reteach ? "Which item is this barcode?" : "New barcode";
  const bits = [code.label];
  if (code.lot) bits.push(`lot ${code.lot}`);
  if (code.expiry) bits.push(`exp ${code.expiry}`);
  $("teachCode").textContent = bits.join(" · ");
  $("teachLink").hidden = !code.link;
  $("teachSearch").value = "";
  renderSuppliers();
  renderPick("");
  $("teach").showModal();
}

// Supplier groups in the teach list: tap a supplier to see only its items. The last supplier
// picked stays selected, since a shelf usually holds one supplier's products.
const NO_SUPPLIER = "No supplier";
const OTHER = "__other";        // suppliers with fewer than SMALL items share one "Other" button
const SMALL = 3;
let pickSupplier = "";
let smallSuppliers = new Set();

function supplierOf(it) { return it.supplier || NO_SUPPLIER; }
function shortSupplier(name) {
  return name.replace(/[,.]?\s+(inc|ltd|llc|corp|corporation|limited|co)\.?$/i, "").replace(/\s*\(.*\)$/, "").trim() || name;
}

function renderSuppliers() {
  const n = {};
  for (const it of sheet.items) n[supplierOf(it)] = (n[supplierOf(it)] || 0) + 1;
  smallSuppliers = new Set(Object.keys(n).filter(s => s !== NO_SUPPLIER && n[s] < SMALL));
  const names = Object.keys(n).filter(s => !smallSuppliers.has(s))
    .sort((a, b) => (a === NO_SUPPLIER) - (b === NO_SUPPLIER) || n[b] - n[a] || a.localeCompare(b));
  const nOther = [...smallSuppliers].reduce((t, s) => t + n[s], 0);
  if (pickSupplier && pickSupplier !== OTHER && !names.includes(pickSupplier)) pickSupplier = "";
  if (pickSupplier === OTHER && !nOther) pickSupplier = "";
  const chip = (value, label, count) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (value === pickSupplier ? " on" : "");
    b.dataset.supplier = value;
    b.textContent = label + " ";
    const c = document.createElement("b");
    c.textContent = count;
    b.append(c);
    return b;
  };
  const chips = names.map(s => chip(s, shortSupplier(s), n[s]));
  if (nOther) chips.splice(chips.length - (n[NO_SUPPLIER] ? 1 : 0), 0, chip(OTHER, "Other", nOther));
  $("teachSuppliers").replaceChildren(chip("", "All", sheet.items.length), ...chips);
}

function renderPick(q) {
  const list = $("teachList");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = sheet.items
    .filter(it => !pickSupplier || (pickSupplier === OTHER ? smallSuppliers.has(supplierOf(it)) : supplierOf(it) === pickSupplier))
    .filter(it => words.every(w => `${it.name} ${it.memo} ${it.sku} ${it.supplier}`.toLowerCase().includes(w)))
    .sort((a, b) => a.retired - b.retired || a.name.localeCompare(b.name));
  list.replaceChildren(...hits.slice(0, pickSupplier ? 300 : 80).map(it => {
    const li = document.createElement("li");
    li.dataset.key = it.key;
    li.innerHTML = `<div><div class="nm"></div><div class="sub"></div></div>`;
    li.querySelector(".nm").textContent = it.name;
    const showSup = (!pickSupplier || pickSupplier === OTHER) && it.supplier;   // a single-supplier list needn't repeat it
    li.querySelector(".sub").textContent = [it.retired ? "Discontinued" : "", showSup && shortSupplier(it.supplier), it.sku && `SKU ${it.sku}`, it.memo].filter(Boolean).join(" · ");
    return li;
  }));
  if (!hits.length) list.innerHTML = `<li class="empty">No match</li>`;
}

function pickTaught(key) {
  const it = byKey.get(key);
  if (!it || !teachCode) return;
  const { code, reteach } = teachCode;
  if (reteach && lastScan && lastScan.code.key === code.key) {
    undoLastScanOf(lastScan.itemKey);
  }
  codes[code.key] = { key: it.key, name: it.name, at: new Date().toISOString() };
  persistCodes();
  $("teach").close();
  teachCode = null;
  countScan(it, code);
  toast(`Saved: this barcode is ${it.name}`);
}

function undoLastScanOf(key) {
  for (let i = state.log.length - 1; i >= 0; i--) {
    if (state.log[i].key === key && !state.log[i].set) {
      const [e] = state.log.splice(i, 1);
      state.log.push(e);
      undo();
      return;
    }
  }
}

// ---------- feedback ----------
let audio = null;
function unlockAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { audio = null; }
}
function tone(freq, start, len) {
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = freq;
  o.type = "square";
  g.gain.setValueAtTime(0.08, audio.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + start + len);
  o.connect(g).connect(audio.destination);
  o.start(audio.currentTime + start);
  o.stop(audio.currentTime + start + len + 0.02);
}
function feedback(kind) {
  const flash = $("flash");
  flash.classList.toggle("bad", kind !== "ok");
  flash.classList.add("show");
  setTimeout(() => flash.classList.remove("show"), 120);
  try { navigator.vibrate?.(kind === "ok" ? 60 : [80, 60, 80]); } catch { /* optional */ }
  if (!state.sound || !audio) return;
  try {
    if (kind === "ok") tone(1760, 0, 0.09);
    else if (kind === "retired") { tone(880, 0, 0.12); tone(660, 0.16, 0.18); }
    else { tone(520, 0, 0.12); tone(520, 0.18, 0.12); }
  } catch { /* audio is optional */ }
}

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function showBanner() {
  const b = $("banner");
  b.hidden = storageOk;
  b.textContent = "This browser is not saving anything (private tab or storage full). Counts will be lost on reload: open the page in a normal tab, or send your counts file often.";
}

// ---------- card ----------
// Product-specific hints come in the count file (kept private); box sizes give the generic ones.
function howToCount(it) {
  if (it.hint) return it.hint;
  if (it.box && it.box > 1) return `Count boxes. ${it.box} syringes per box; a loose syringe = ${fmt(1 / it.box)} box.`;
  if (it.box === 1) return "Count boxes. 1 syringe per box.";
  return "";
}

function showCard(it, fromScan = false) {
  current = it;
  const c = mine(it.key);
  const card = $("card");
  card.hidden = false;
  card.classList.toggle("retired", it.retired);
  card.classList.toggle("hit", fromScan && !it.retired);
  $("cardRetired").hidden = !it.retired;
  $("cardName").textContent = it.name;
  $("cardMemo").textContent = [it.sku && `SKU ${it.sku}`, it.memo, it.supplier].filter(Boolean).join(" · ");
  $("cardHow").textContent = howToCount(it);
  $("cardQty").textContent = c && c.q != null ? fmt(c.q) : "–";
  $("cardQoh").textContent = fmt(it.qoh);
  $("syringeBtn").hidden = !(it.box > 1);
  $("syringeBtn").dataset.d = it.box > 1 ? String(1 / it.box) : "";
  $("reteachBtn").hidden = !(fromScan && lastScan && lastScan.itemKey === it.key);
  const lots = Object.entries(c?.lots || {});
  const today = new Date().toISOString().slice(0, 10);
  const el = $("cardLots");
  el.replaceChildren();
  if (lots.length) {
    el.append("Scanned lots: ");
    lots.forEach(([k, n], i) => {
      const exp = k.split("|")[1];
      const expired = exp && exp.length >= 7 && exp < today.slice(0, exp.length);
      const span = document.createElement("span");
      span.textContent = lotText({ [k]: n }) + (expired ? " (EXPIRED)" : "");
      if (expired) span.className = "expired";
      el.append(span);
      if (i < lots.length - 1) el.append("; ");
    });
  }
  if (fromScan) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ---------- list ----------
function render() {
  if (!sheet) return;
  const q = $("search").value.toLowerCase().split(/\s+/).filter(Boolean);
  const counted = it => mine(it.key)?.q != null;
  const n = { todo: 0, done: 0, retired: 0, all: sheet.items.length };
  for (const it of sheet.items) {
    if (it.retired) n.retired++;
    if (counted(it)) n.done++;
    else if (!it.retired) n.todo++;
  }
  $("nTodo").textContent = n.todo;
  $("nDone").textContent = n.done;
  $("nRetired").textContent = n.retired;
  $("nAll").textContent = n.all;
  $("retiredHelp").hidden = filter !== "retired";

  const show = sheet.items.filter(it => {
    if (filter === "todo" && (counted(it) || it.retired)) return false;
    if (filter === "done" && !counted(it)) return false;
    if (filter === "retired" && !it.retired) return false;
    return q.every(w => `${it.name} ${it.memo} ${it.sku} ${it.supplier}`.toLowerCase().includes(w));
  });
  const list = $("list");
  list.replaceChildren(...show.map(it => {
    const li = document.createElement("li");
    li.dataset.key = it.key;
    const c = mine(it.key);
    li.innerHTML = `<div><div class="nm"></div><div class="sub"></div></div><div class="ct"></div>`;
    li.querySelector(".nm").textContent = it.name;
    li.querySelector(".sub").textContent = [it.retired ? "Discontinued" : "", `QBO ${fmt(it.qoh)}`, it.memo].filter(Boolean).join(" · ");
    const ct = li.querySelector(".ct");
    ct.textContent = c?.q != null ? fmt(c.q) : "–";
    if (c?.q != null) ct.classList.add("done");
    else if (it.retired) ct.classList.add("ret");
    return li;
  }));
  if (!show.length) list.innerHTML = `<li class="empty">${filter === "todo" && !q.length ? "Everything is counted." : "Nothing here."}</li>`;
  renderTools();
}

function renderTools() {
  $("who").textContent = state.counter || "";
  $("nameInput").value = state.counter || "";
  $("soundToggle").checked = state.sound !== false;
  $("askQtyToggle").checked = !!state.askQty;
  $("nCodes").textContent = Object.keys(codes).length;
  $("packInfo").textContent = state.pack ? `Count file: ${state.pack.source || "worksheet"}${state.pack.created ? `, made ${state.pack.created.slice(0, 16).replace("T", " ")}` : ""}. ${sheet.items.length} items.` : "";
  $("ver").textContent = VERSION;
  const ul = $("others");
  ul.replaceChildren(...state.others.map((o, i) => {
    const li = document.createElement("li");
    const items = Object.values(o.counts || {}).filter(c => c.q != null).length;
    li.innerHTML = `<span></span><button class="btn link" data-action="drop-other" data-i="${i}">Remove</button>`;
    li.firstChild.textContent = `${o.counter || o.deviceId}: ${items} items (sent ${localStamp(o.exported)})`;
    return li;
  }));
  const t = totals();
  const active = sheet.items.filter(it => !it.retired);
  const missing = active.filter(it => !t[it.key]).length;
  const retiredLeft = sheet.items.filter(it => it.retired && !t[it.key]).length;
  const people = 1 + state.others.length;
  $("summary").textContent = `Combined from ${people} ${people === 1 ? "phone" : "phones"}: ${Object.keys(t).length} items counted. ` +
    (missing ? `${missing} active items not counted yet. ` : "All active items counted. ") +
    (retiredLeft ? `${retiredLeft} discontinued items not confirmed.` : "");
}

// ---------- files in and out ----------
async function shareOrDownload(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

function localStamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : stampNow(d);
}

function stampNow(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fileStamp() { return stampNow().replace(" ", "_").replace(":", ""); }
function safeName(s) { return (s || "phone").replace(/[^\w-]+/g, "_"); }

function codesForExport() {
  return Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, { key: v.key, name: v.name, at: v.at || "" }]));
}

function exportCounts() {
  const body = {
    kind: "inv-count-counts", version: 1, counter: state.counter, deviceId: state.deviceId,
    exported: new Date().toISOString(), source: state.pack?.source || "", packCreated: state.pack?.created || "",
    counts: state.counts, codes: codesForExport(),
  };
  shareOrDownload(`inv-counts-${safeName(state.counter)}-${fileStamp()}.json`, JSON.stringify(body), "application/json");
}

function exportCodes() {
  const body = { kind: "inv-count-barcodes", version: 1, exported: new Date().toISOString(), codes: codesForExport() };
  shareOrDownload(`inv-barcodes-${fileStamp()}.json`, JSON.stringify(body), "application/json");
}

function exportSheet() {
  const t = totals();
  const missing = sheet.items.filter(it => !it.retired && !t[it.key]).length;
  const csv = buildExport(sheet, t, stampNow());
  shareOrDownload(`Physical-Inventory-Count-${fileStamp()}.csv`, csv, "text/csv");
  if (missing) toast(`Made the sheet. ${missing} active items are blank (not counted).`, 5000);
}

// When two lists disagree about a barcode, the newer teach wins (a re-teach fixes a mistake).
// Entries keep the time they were taught; lists from before 2026-10-26 have none and count as oldest.
function mergeCodes(incoming) {
  let added = 0, updated = 0, clash = 0;
  for (const [k, v] of Object.entries(incoming || {})) {
    if (!v || !v.key) continue;
    const have = codes[k];
    if (!have) { codes[k] = { key: v.key, name: v.name, at: v.at || "" }; added++; }
    else if (have.key !== v.key) {
      if ((v.at || "") > (have.at || "")) { codes[k] = { key: v.key, name: v.name, at: v.at }; updated++; }
      else clash++;
    }
  }
  persistCodes();
  return { added, updated, clash };
}

function codeNote(m) {
  return [m.added && `${m.added} new barcodes`, m.updated && `${m.updated} changed to a newer teach`,
    m.clash && `${m.clash} kept as taught on this phone (newer)`].filter(Boolean).join(", ");
}

async function openFiles(files) {
  const notes = [];
  for (const f of files) {
    try {
      const text = await f.text();
      const isJson = /^\s*[{[]/.test(text);
      if (!isJson) {
        const pack = { kind: "inv-count-pack", source: f.name, created: new Date().toISOString(), csv: text, rows: null };
        if (!(await startNewCount(pack))) { notes.push("Kept the current count."); continue; }
        notes.push(`Loaded worksheet ${f.name} (no helper data: discontinued items are not marked).`);
        continue;
      }
      const d = JSON.parse(text);
      if (d.kind === "inv-count-pack") {
        if (state.pack && state.pack.source === d.source && state.pack.created === d.created) {
          notes.push("That count file is already loaded.");
          continue;
        }
        if (!(await startNewCount(d))) { notes.push("Kept the current count."); continue; }
        const m = mergeCodes(d.codes);
        notes.push(`New count started from ${d.source}: ${sheet.items.length} items` +
          (d.codes ? `, ${Object.keys(d.codes).length} known barcodes` + (codeNote(m) ? ` (${codeNote(m)})` : "") : "") + ".");
      } else if (d.kind === "inv-count-counts") {
        if (!sheet) throw new Error("Open the count file first.");
        if (d.deviceId === state.deviceId) { notes.push("That counts file came from this phone; skipped."); continue; }
        if (state.pack && (d.source !== state.pack.source || d.packCreated !== state.pack.created)) {
          notes.push(`${d.counter || "That phone"}'s counts are from a different count file (an older count?); not added. Everyone must open the same count file.`);
          continue;
        }
        state.others = state.others.filter(o => o.deviceId !== d.deviceId);
        state.others.push({ counter: d.counter, deviceId: d.deviceId, exported: d.exported, counts: d.counts || {} });
        const m = mergeCodes(d.codes);
        notes.push(`Added ${d.counter || "a phone"}'s counts` + (codeNote(m) ? `; barcodes: ${codeNote(m)}` : "") + ".");
      } else if (d.kind === "inv-count-barcodes") {
        const m = mergeCodes(d.codes);
        notes.push(`Barcode list: ${codeNote(m) || "nothing new"}.`);
      } else {
        throw new Error("Not an Inventory Count file.");
      }
    } catch (e) {
      notes.push(`${f.name}: ${e.message || e}`);
    }
  }
  persist();
  boot();
  toast(notes.join(" "), 6000);
}

// A different count file means a new count: this phone's counts and the other phones' files
// belong to the old one. The barcode list is kept, since barcodes don't change between counts.
async function startNewCount(pack) {
  const hasCounts = Object.keys(state.counts).length || state.others.length;
  if (sheet && hasCounts) {
    const ok = await confirmBox("Start a new count?",
      `This phone still has counts from ${state.pack?.source || "the last count file"}` +
      `${state.pack?.created ? ` (made ${localStamp(state.pack.created)})` : ""}. ` +
      "They will be cleared. If you have not sent them yet, tap Cancel and send your counts file first. The barcode list is kept.",
      "Clear and start");
    if (!ok) return false;
  }
  usePack(pack);
  state.counts = {}; state.others = []; state.log = [];
  current = null; lastScan = null;
  $("card").hidden = true;
  return true;
}

function confirmBox(title, hint, okLabel) {
  $("askInput").hidden = true;
  $("askOk").textContent = okLabel;
  return ask(title, hint, "", false).then(v => {
    $("askInput").hidden = false;
    $("askOk").textContent = "OK";
    return v != null;
  });
}

// ---------- ask for a number or text ----------
function ask(title, hint, value, numeric) {
  return new Promise(resolve => {
    const dlg = $("ask"), input = $("askInput");
    $("askTitle").textContent = title;
    $("askHint").textContent = hint;
    input.value = value ?? "";
    input.inputMode = numeric ? "decimal" : "text";
    input.type = "text";
    dlg.returnValue = "";
    // The close event arrives a moment after close(). If the next question has already opened by
    // then, this late event belongs to the previous one: ignore it.
    dlg.onclose = () => { if (!dlg.open) resolve(dlg.returnValue === "ok" ? input.value.trim() : null); };
    dlg.showModal();
    if (!input.hidden) setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

// ---------- actions ----------
let clearArmed = 0;
const actions = {
  "open-file": () => {
    if (!sheet) {
      const n = $("setupName").value.trim();
      if (n) { state.counter = n; persist(); }
    }
    $("fileInput").click();
  },
  camera: () => (scanning ? stopCamera() : startCamera()),
  torch: toggleTorch,
  "type-code": async () => {
    const v = await ask("Type the barcode", "The digits under the barcode.", "", true);
    if (v) onCode(readCode(/^\d{8}$/.test(v) ? "ean_8" : /^\d{12,14}$/.test(v) ? "ean_13" : "code_128", v), "typed");
  },
  add: el => { if (current) { change(current.key, Number(el.dataset.d)); showCard(current); render(); } },
  syringe: el => { if (current) { change(current.key, Number(el.dataset.d)); showCard(current); render(); } },
  zero: () => { if (current) { setQty(current.key, 0); showCard(current); render(); } },
  set: async () => {
    if (!current) return;
    const c = mine(current.key);
    const v = await ask(current.name, howToCount(current) || "Total on hand. Decimals are fine (0.5).", c?.q != null ? fmt(c.q) : "", true);
    if (v == null || v === "") return;
    const n = Number(v.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return toast("That is not a number.");
    setQty(current.key, n);
    showCard(current);
    render();
  },
  undo,
  reteach: () => { if (lastScan) teach(lastScan.code, "", true); },
  "close-card": () => { $("card").hidden = true; current = null; },
  "retired-zero": () => {
    let n = 0;
    for (const it of sheet.items) {
      if (it.retired && mine(it.key)?.q == null) { state.counts[it.key] = { q: 0, lots: {} }; n++; }
    }
    persist(); render();
    toast(`${n} discontinued items marked 0.`);
  },
  "export-counts": exportCounts,
  "export-codes": exportCodes,
  "export-sheet": exportSheet,
  "drop-other": el => { state.others.splice(Number(el.dataset.i), 1); persist(); renderTools(); },
  "clear-counts": el => {
    if (Date.now() - clearArmed > 4000) {
      clearArmed = Date.now();
      el.textContent = "Tap again to clear all my counts";
      setTimeout(() => { el.textContent = "Clear my counts"; }, 4000);
      return;
    }
    clearArmed = 0;
    state.counts = {}; state.log = []; state.others = [];
    persist(); el.textContent = "Clear my counts"; $("card").hidden = true; render();
    toast("Counts cleared. The barcode list is kept.");
  },
};

document.addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](el); return; }
  const chip = e.target.closest("[data-filter]");
  if (chip) {
    filter = chip.dataset.filter;
    document.querySelectorAll(".chip").forEach(c => c.classList.toggle("on", c === chip));
    render();
    return;
  }
  const li = e.target.closest("#list li[data-key]");
  if (li) { showCard(byKey.get(li.dataset.key)); $("card").scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
  const sup = e.target.closest("#teachSuppliers [data-supplier]");
  if (sup) {
    pickSupplier = sup.dataset.supplier;
    renderSuppliers();
    renderPick($("teachSearch").value);
    $("teachList").scrollTop = 0;
    return;
  }
  const pick = e.target.closest("#teachList li[data-key]");
  if (pick) pickTaught(pick.dataset.key);
});

$("search").addEventListener("input", render);
$("teachSearch").addEventListener("input", e => renderPick(e.target.value));
$("teach").addEventListener("close", () => { if (!$("teach").open) teachCode = null; seen.at = Date.now(); });
$("fileInput").addEventListener("change", e => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) openFiles(fs); });
$("setupName").addEventListener("change", e => { state.counter = e.target.value.trim(); persist(); });
$("nameInput").addEventListener("change", e => { state.counter = e.target.value.trim(); persist(); renderTools(); });
$("soundToggle").addEventListener("change", e => { state.sound = e.target.checked; persist(); });
$("askQtyToggle").addEventListener("change", e => {
  state.askQty = e.target.checked; persist();
  toast(state.askQty ? "Each scan now asks how many." : "Each scan counts 1.");
});
$("askInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("ask").close("ok"); } });
document.addEventListener("visibilitychange", () => { if (document.hidden && scanning) stopCamera(); });

// ---------- start ----------
function boot() {
  showBanner();
  if (state.pack && !sheet) {
    try { usePack(state.pack); } catch (e) { state.pack = null; toast(e.message, 6000); }
  }
  $("setup").hidden = !!sheet;
  $("main").hidden = !sheet;
  $("setupName").value = state.counter || "";
  if (sheet) render();
}

boot();
persist();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
