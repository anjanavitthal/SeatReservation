'use strict';

// 2+2 layout: A B | aisle | C D
const COLUMNS = ['A', 'B', 'C', 'D'];

function seatLayout(rows) {
  const layout = [];
  for (let r = 1; r <= rows; r++) layout.push(COLUMNS.map((c) => `${r}${c}`));
  return layout;
}

function isValidSeat(seat, rows) {
  const m = /^(\d{1,2})([A-D])$/.exec(seat);
  return !!m && Number(m[1]) >= 1 && Number(m[1]) <= rows;
}

module.exports = { seatLayout, isValidSeat, COLUMNS };
