// QBO Physical Inventory Worksheet: read it, and write it back with the counts filled in.
import { parseCSV, writeCSV } from "./csv.js";

const HEADER_FIRST = "Product/Service";
// Columns are found by header name: QBO adds or drops columns (e.g. Category) depending on the
// report settings. The positions are the 2026-10-25 layout, used only when a header is missing.
const HEADERS = {
  name: ["product/service"], memo: ["memo/description"], supplier: ["preferred supplier name"],
  qoh: ["quantity on hand"], count: ["physical count"],
};
const FALLBACK = { name: 0, memo: 1, supplier: 2, qoh: 3, count: 4 };

function columns(header) {
  const names = header.map(h => (h || "").trim().toLowerCase());
  const col = {};
  for (const [k, labels] of Object.entries(HEADERS)) {
    const i = names.findIndex(n => labels.includes(n));
    col[k] = i === -1 ? FALLBACK[k] : i;
  }
  if (!names.includes("quantity on hand") || !names.includes("physical count")) {
    throw new Error("The worksheet has no 'Quantity on hand' or 'Physical Count' column. Export it again from QBO.");
  }
  return col;
}

export function num(v) {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

export function round(n) {
  return Math.round(n * 10000) / 10000;
}

export function fmt(n) {
  if (n == null || n === "") return "";
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, "");
}

// text: the worksheet CSV as QBO exported it. helper: the pack's per-row list, or null.
// Returns {grid, headerIndex, col, items}; items[i].row is its index in grid, col the column indexes.
export function readWorksheet(text, helper) {
  const grid = parseCSV(text);
  const headerIndex = grid.findIndex(r => (r[0] || "").trim() === HEADER_FIRST);
  if (headerIndex === -1) throw new Error("This file is not a QBO Physical Inventory Worksheet (no 'Product/Service' header).");
  const COL = columns(grid[headerIndex]);
  const items = [];
  const seen = {};
  for (let r = headerIndex + 1; r < grid.length; r++) {
    const cells = grid[r];
    if (!cells.some(c => c.trim())) break;
    const name = (cells[COL.name] || "").trim();
    seen[name] = (seen[name] || 0) + 1;
    const h = helper ? helper[items.length] : null;
    if (helper && h && h.name !== name) throw new Error(`Count file rows do not line up with the worksheet at "${name}".`);
    items.push({
      key: h?.id ? `id:${h.id}` : seen[name] > 1 ? `name:${name}#${seen[name]}` : `name:${name}`,
      row: r,
      name,
      memo: (cells[COL.memo] || "").trim(),
      supplier: (cells[COL.supplier] || "").trim(),
      qoh: num(cells[COL.qoh]),
      id: h?.id || "",
      sku: h?.sku || "",
      box: h?.box || null,
      retired: !!h?.retired,
      hint: h?.hint || "",
      hand: !!h?.hand,
      tester: !!h?.tester,
      retail: h?.retail ? `id:${h.retail}` : "",
    });
  }
  if (!items.length) throw new Error("The worksheet has no item rows.");
  return { grid, headerIndex, col: COL, items };
}

// Staff testers carry the same barcode as the retail product, so a barcode always names the retail
// item (the count file pairs each tester with its retail item). In tester shelf mode a scan counts
// the retail item's tester instead.
export function testerLinks(items) {
  const byKey = new Map(items.map(it => [it.key, it]));
  const testerOf = new Map();
  for (const it of items) if (it.tester && it.retail && byKey.has(it.retail)) testerOf.set(it.retail, it);
  return { byKey, testerOf };
}

// The item a scan counts, given the item its barcode names. null: nothing to count (tester shelf
// mode, and the product has no tester item). A barcode taught to a tester before testers were
// paired still counts the retail item outside tester shelf mode.
export function scanTarget(it, testerMode, links) {
  if (it.tester) return testerMode ? it : links.byKey.get(it.retail) || it;
  return testerMode ? links.testerOf.get(it.key) || null : it;
}

// The item a new barcode is saved against: a tester's retail item, if it has one.
export function codeOwner(it, links) {
  return (it.tester && links.byKey.get(it.retail)) || it;
}

// totals: {key: {q, lots: {"lot|expiry": n}, by: {counter: q}}}.
export function lotText(lots) {
  return Object.entries(lots || {})
    .filter(([, n]) => n)
    .map(([k, n]) => {
      const [lot, exp] = k.split("|");
      return [lot ? `Lot ${lot}` : "No lot", exp ? `exp ${exp}` : "", `x${fmt(n)}`].filter(Boolean).join(" ");
    })
    .join("; ");
}

export function buildExport(sheet, totals, stamp) {
  const grid = sheet.grid.map(r => r.slice());
  const width = grid[sheet.headerIndex].length;
  grid[sheet.headerIndex] = [...grid[sheet.headerIndex], "Difference", "Lot / expiry (scanned)", "Counted by"];
  for (const it of sheet.items) {
    const t = totals[it.key];
    const row = grid[it.row];
    while (row.length < width) row.push("");
    const counted = t && t.q != null;
    row[sheet.col.count] = counted ? fmt(t.q) : "";
    row.push(
      counted ? fmt(round(t.q - it.qoh)) : "",
      counted ? lotText(t.lots) || (it.hand ? "Counted by hand (no barcode)" : "") : "",
      counted ? Object.entries(t.by).map(([who, q]) => `${who} ${fmt(q)}`).join("; ") : "",
    );
  }
  grid.push([`Counted with the Inventory Count scanner; file made ${stamp}. Blank Physical Count = not counted.`]);
  return "﻿" + writeCSV(grid);
}
