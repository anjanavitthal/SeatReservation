'use strict';

const COLUMNS = ['A', 'B', 'C', 'D'];

function normalizeSeatConfig(config = {}) {
  if (typeof config === 'number') return { rows: config, columns: COLUMNS.length, columnOrder: [...COLUMNS], totalSeats: config * COLUMNS.length };

  const rows = Number(config.seat_rows ?? config.rows ?? 1);
  const rawColumns = Array.isArray(config.seat_columns)
    ? config.seat_columns
    : Array.isArray(config.seat_layout)
      ? config.seat_layout
      : String(config.seat_layout ?? '').split(',').filter(Boolean).map((s) => s.trim().toUpperCase());

  const columns = Array.isArray(rawColumns) && rawColumns.length > 0
    ? rawColumns
    : (Number(config.seat_columns ?? config.columns ?? COLUMNS.length) > 0
      ? COLUMNS.slice(0, Number(config.seat_columns ?? config.columns ?? COLUMNS.length))
      : [...COLUMNS]);

  const columnOrder = columns.map((c) => String(c).trim().toUpperCase()).filter(Boolean);
  const safeRows = Number.isFinite(rows) && rows > 0 ? rows : 1;
  const safeColumns = columnOrder.length > 0 ? columnOrder : [...COLUMNS];

  return {
    rows: safeRows,
    columns: safeColumns.length,
    columnOrder: safeColumns,
    totalSeats: safeRows * safeColumns.length,
  };
}

function seatLayout(config) {
  const { rows, columnOrder } = normalizeSeatConfig(config);
  const layout = [];
  for (let r = 1; r <= rows; r++) layout.push(columnOrder.map((c) => `${r}${c}`));
  return layout;
}

function isValidSeat(seat, config) {
  const normalized = normalizeSeatConfig(config);
  const m = /^(\d{1,2})([A-Z])$/.exec(String(seat || '').trim().toUpperCase());
  if (!m) return false;
  const row = Number(m[1]);
  const column = m[2];
  return row >= 1 && row <= normalized.rows && normalized.columnOrder.includes(column);
}

module.exports = { normalizeSeatConfig, seatLayout, isValidSeat, COLUMNS };
