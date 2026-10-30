// Barcode text -> a stable key for the barcode map, plus GS1 lot and expiry when present.
// Retail codes (UPC-A, UPC-E, EAN-8, EAN-13, ITF-14) and GS1 (01) all become a 14-digit GTIN,
// so the same product matches whether its box shows a 1D or a 2D code. A GS1 Digital Link
// (a QR web link carrying the GTIN, e.g. https://brand.com/01/00012345678905/10/LOT) does too.

const GS = "\u001d";

// GS1 Application Identifiers: fixed data length, or null for variable (ends at GS, max 30).
const FIXED = {
  "00": 18, "01": 14, "02": 14, "03": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6,
  "20": 2, "4326": 6, "7003": 10, "7006": 6,
};
const VARIABLE_2 = new Set(["10", "21", "22", "30", "37", "90", "91", "92", "93", "94", "95", "96", "97", "98", "99"]);
const VARIABLE_3 = new Set(["235", "240", "241", "242", "243", "250", "251", "253", "254", "255", "400", "401", "402", "403", "410", "411", "412", "413", "414", "415", "416", "417", "420", "421", "422", "423", "424", "425", "426", "427", "710", "711", "712", "713", "714", "715"]);
const VARIABLE_4 = new Set(["7001", "7002", "7004", "7005", "7007", "7008", "7009", "7010", "7020", "7021", "7022", "7023", "7240", "8001", "8002", "8003", "8004", "8005", "8006", "8007", "8008", "8009", "8010", "8011", "8012", "8013", "8017", "8018", "8019", "8020", "8026", "8110", "8111", "8112", "8200"]);

function readAI(s, i) {
  // Returns [ai, length or null] for the AI starting at s[i], or null if unknown.
  const two = s.slice(i, i + 2), three = s.slice(i, i + 3), four = s.slice(i, i + 4);
  if (four in FIXED) return [four, FIXED[four]];
  if (VARIABLE_4.has(four)) return [four, null];
  if (/^3[1-6]\d\d$/.test(four)) return [four, 6];           // measures: 4-digit AI + 6 digits
  if (/^39[0-4]\d$/.test(four)) return [four, null];          // amounts
  if (VARIABLE_3.has(three)) return [three, null];
  if (two in FIXED) return [two, FIXED[two]];
  if (VARIABLE_2.has(two)) return [two, null];
  return null;
}

// Parses GS1 element strings in raw form ("0109...17...10LOT", GS-separated) or bracketed form
// ("(01)09...(17)...(10)LOT"). Returns {ai: value} or null if it does not look like GS1.
export function parseGS1(text) {
  let s = String(text).replace(/^\](d2|C1|Q3|e0|J1)/, "");
  if (s.startsWith("(")) {
    const out = {};
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(new RegExp(GS, "g"), "").trim();
    return Object.keys(out).length ? out : null;
  }
  s = s.replace(/^\u001d+/, "");
  const out = {};
  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) { i++; continue; }
    const hit = readAI(s, i);
    if (!hit) return Object.keys(out).length && "01" in out ? out : null;
    const [ai, len] = hit;
    i += ai.length;
    let val;
    if (len) {
      val = s.slice(i, i + len);
      if (val.length !== len) return null;
      i += len;
    } else {
      const end = s.indexOf(GS, i);
      val = end === -1 ? s.slice(i) : s.slice(i, end);
      i = end === -1 ? s.length : end + 1;
    }
    out[ai] = val;
  }
  return Object.keys(out).length ? out : null;
}

// GS1 Digital Link URL -> {ai: value} with 01 (GTIN, padded to 14), and 10, 17, 21 when present,
// from the path (/01/<gtin>/10/<lot>) or the query (?17=YYMMDD). Null if it carries no GTIN.
const LINK_KEYS = { "01": "01", gtin: "01", "10": "10", lot: "10", "21": "21", ser: "21", "17": "17", exp: "17" };
export function parseDigitalLink(text) {
  let url;
  try { url = new URL(String(text).trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const out = {};
  const parts = url.pathname.split("/").filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  for (let i = 0; i < parts.length - 1; i++) {
    const ai = LINK_KEYS[parts[i].toLowerCase()];
    if (ai && !(ai in out)) { out[ai] = parts[i + 1]; i++; }
  }
  for (const [k, v] of url.searchParams) {
    const ai = LINK_KEYS[k.toLowerCase()];
    if (ai && !(ai in out)) out[ai] = v;
  }
  if (!/^(\d{8}|\d{12,14})$/.test(out["01"] || "")) return null;
  out["01"] = out["01"].padStart(14, "0");
  return out;
}

function gtinCheckOk(digits) {
  const d = digits.split("").map(Number);
  const check = d.pop();
  let sum = 0;
  d.reverse().forEach((n, k) => { sum += n * (k % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

// UPC-E (8 digits with number system and check digit) -> UPC-A (12 digits).
export function upcEtoA(upce) {
  if (!/^[01]\d{7}$/.test(upce)) return null;
  const ns = upce[0], d = upce.slice(1, 7), check = upce[7];
  const last = d[5];
  let body;
  if ("012".includes(last)) body = d.slice(0, 2) + last + "0000" + d.slice(2, 5);
  else if (last === "3") body = d.slice(0, 3) + "00000" + d.slice(3, 5);
  else if (last === "4") body = d.slice(0, 4) + "00000" + d[4];
  else body = d.slice(0, 5) + "0000" + last;
  return ns + body + check;
}

// GS1 date YYMMDD -> "YYYY-MM-DD"; DD = 00 means the end of that month ("YYYY-MM").
export function gs1Date(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd || "")) return "";
  const yy = Number(yymmdd.slice(0, 2)), mm = yymmdd.slice(2, 4), dd = yymmdd.slice(4, 6);
  const yyyy = 2000 + yy;   // GS1 century rule only matters for dates beyond 2049
  return dd === "00" ? `${yyyy}-${mm}` : `${yyyy}-${mm}-${dd}`;
}

// Some makers print a non-GS1 2D code "LOT;YYYY.MM;YYYY.MM;REF" (lot; made; expiry; catalogue
// number). The REF names the product, so it is the key; lot and expiry change box to box.
export function parseLotRef(text) {
  const m = /^([A-Za-z0-9-]+);(\d{4})\.(0[1-9]|1[0-2]);(\d{4})\.(0[1-9]|1[0-2]);([A-Za-z0-9-]+)$/.exec(String(text || "").trim());
  return m ? { lot: m[1], made: `${m[2]}-${m[3]}`, expiry: `${m[4]}-${m[5]}`, ref: m[6].toUpperCase() } : null;
}

// format: BarcodeDetector format name; text: rawValue.
// Returns {key, gtin, lot, expiry, label, gs1, link}; link = a web link with no GTIN in it.
export function readCode(format, text) {
  const raw = String(text || "").trim();
  const digits = /^\d+$/.test(raw) ? raw : "";
  let gtin = "";
  let gs1 = null;

  if (format === "upc_e" && digits.length === 8) gtin = (upcEtoA(digits) || "").padStart(14, "0");
  else if (["ean_13", "ean_8", "upc_a", "itf"].includes(format) && [8, 12, 13, 14].includes(digits.length)) {
    gtin = digits.padStart(14, "0");
  }
  if (!gtin) {
    gs1 = parseGS1(raw) || parseDigitalLink(raw);
    if (gs1 && /^\d{14}$/.test(gs1["01"] || "")) gtin = gs1["01"];
    else if (gs1 && !("01" in gs1)) gs1 = null;
  }
  if (gtin && !gtinCheckOk(gtin)) gtin = "";
  const lr = gtin ? null : parseLotRef(raw);

  const lot = gs1?.["10"] || lr?.lot || "";
  const expiry = gs1Date(gs1?.["17"]) || lr?.expiry || "";
  const clean = raw.replace(/[\u0000-\u001f]/g, " ").trim();
  const key = gtin ? `gtin:${gtin}` : lr ? `ref:${lr.ref}` : `raw:${clean}`;
  const label = gtin ? `GTIN ${gtin.replace(/^0+(?=\d{12,})/, "")}` : lr ? `REF ${lr.ref}` : clean;
  const link = !gtin && /^https?:\/\//i.test(clean);
  return { key, gtin, lot, expiry, label, gs1, link };
}
