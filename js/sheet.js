// QBO Physical Inventory Worksheet: read it, and write it back with the counts filled in.
import { parseCSV, writeCSV } from "./csv.js";

const HEADER_FIRST = "Product/Service";
const COL = { name: 0, memo: 1, supplier: 2, qoh: 3, count: 4 };

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
// Returns {grid, headerIndex, items}; items[i].row is its index in grid.
export function readWorksheet(text, helper) {
  const grid = parseCSV(text);
  const headerIndex = grid.findIndex(r => (r[0] || "").trim() === HEADER_FIRST);
  if (headerIndex === -1) throw new Error("This file is not a QBO Physical Inventory Worksheet (no 'Product/Service' header).");
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
    });
  }
  if (!items.length) throw new Error("The worksheet has no item rows.");
  return { grid, headerIndex, items };
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
    row[COL.count] = counted ? fmt(t.q) : "";
    row.push(
      counted ? fmt(round(t.q - it.qoh)) : "",
      counted ? lotText(t.lots) : "",
      counted ? Object.entries(t.by).map(([who, q]) => `${who} ${fmt(q)}`).join("; ") : "",
    );
  }
  grid.push([`Counted with the Inventory Count scanner; file made ${stamp}. Blank Physical Count = not counted.`]);
  return "﻿" + writeCSV(grid);
}
