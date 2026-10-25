// Minimal RFC 4180 CSV reader and writer (quotes, doubled quotes, CRLF, BOM).

export function parseCSV(text) {
  const s = String(text).replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", i = 0, quoted = false;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function cell(v) {
  const t = v == null ? "" : String(v);
  return /[",\r\n]/.test(t) || /^\s|\s$/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function writeCSV(rows) {
  return rows.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
