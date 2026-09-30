'use strict';
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routes (
  id               INTEGER PRIMARY KEY,
  origin           TEXT NOT NULL,
  destination      TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  UNIQUE (origin, destination)
);

CREATE TABLE IF NOT EXISTS buses (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  operator    TEXT NOT NULL,
  bus_type    TEXT NOT NULL,
  seat_rows   INTEGER NOT NULL CHECK (seat_rows BETWEEN 1 AND 20),
  seat_columns INTEGER NOT NULL DEFAULT 4 CHECK (seat_columns BETWEEN 1 AND 12),
  seat_layout TEXT NOT NULL DEFAULT 'A,B,C,D'
);

-- A schedule is a bus running a route every day at a fixed time.
CREATE TABLE IF NOT EXISTS schedules (
  id             INTEGER PRIMARY KEY,
  route_id       INTEGER NOT NULL REFERENCES routes(id),
  bus_id         INTEGER NOT NULL REFERENCES buses(id),
  departure_time TEXT NOT NULL CHECK (departure_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id             INTEGER PRIMARY KEY,
  reference      TEXT NOT NULL UNIQUE,
  schedule_id    INTEGER NOT NULL REFERENCES schedules(id),
  travel_date    TEXT NOT NULL,
  passenger_name TEXT NOT NULL,
  phone          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','CANCELLED')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at   TEXT
);

CREATE TABLE IF NOT EXISTS booking_seats (
  booking_id  INTEGER NOT NULL REFERENCES bookings(id),
  schedule_id INTEGER NOT NULL,
  travel_date TEXT NOT NULL,
  seat_no     TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (booking_id, seat_no)
);

-- The core guarantee: a seat on a given trip can be held by only one active booking.
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_seat
  ON booking_seats (schedule_id, travel_date, seat_no) WHERE active = 1;
`;

function ensureBusSeatColumns(db) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('buses')").all().map((c) => c.name);
  if (!columns.includes('seat_columns')) {
    db.exec("ALTER TABLE buses ADD COLUMN seat_columns INTEGER NOT NULL DEFAULT 4 CHECK (seat_columns BETWEEN 1 AND 12)");
  }
  if (!columns.includes('seat_layout')) {
    db.exec("ALTER TABLE buses ADD COLUMN seat_layout TEXT NOT NULL DEFAULT 'A,B,C,D'");
  }
  db.prepare("UPDATE buses SET seat_columns = COALESCE(seat_columns, 4), seat_layout = COALESCE(seat_layout, 'A,B,C,D') WHERE seat_columns IS NULL OR seat_layout IS NULL").run();
}

function openDb(file = process.env.DB_FILE || 'data/bus.db') {
  if (file !== ':memory:') {
    require('fs').mkdirSync(require('path').dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureBusSeatColumns(db);
  return db;
}

function seed(db) {
  if (db.prepare('SELECT COUNT(*) c FROM routes').get().c > 0) return;

  const routes = [
    ['Mumbai', 'Pune', 180], ['Pune', 'Mumbai', 180],
    ['Bengaluru', 'Chennai', 360], ['Chennai', 'Bengaluru', 360],
    ['Hyderabad', 'Bengaluru', 600], ['Bengaluru', 'Hyderabad', 600],
    ['Mumbai', 'Goa', 660], ['Goa', 'Mumbai', 660],
    ['Delhi', 'Jaipur', 330], ['Jaipur', 'Delhi', 330],
    ['Thandla', 'Indore', 240], ['Indore', 'Thandla', 240]
  ];
  const buses = [
    ['Shivneri Express', 'MSRTC', 'AC Seater', 10, 4, 'A,B,C,D'],
    ['Deccan Queen', 'Deccan Travels', 'Non-AC Seater', 11, 4, 'A,B,C,D'],
    ['Green Line', 'GreenLine Travels', 'AC Seater', 10, 4, 'A,B,C,D'],
    ['Orange Cruiser', 'Orange Tours', 'Volvo AC Seater', 12, 4, 'A,B,C,D'],
    ['Royal Rider', 'Royal Travels', 'AC Seater', 9, 3, 'A,B,C'],
  ];
  const times = ['06:00', '09:30', '14:00', '18:45', '22:30'];

  const tx = db.transaction(() => {
    const insR = db.prepare('INSERT INTO routes (origin, destination, duration_minutes) VALUES (?,?,?)');
    const insB = db.prepare('INSERT INTO buses (name, operator, bus_type, seat_rows, seat_columns, seat_layout) VALUES (?,?,?,?,?,?)');
    const insS = db.prepare('INSERT INTO schedules (route_id, bus_id, departure_time) VALUES (?,?,?)');
    const routeIds = routes.map((r) => insR.run(...r).lastInsertRowid);
    const busIds = buses.map((b) => insB.run(...b).lastInsertRowid);
    routeIds.forEach((rid, i) => {
      // 3 departures per route, rotating buses and times
      for (let k = 0; k < 3; k++) {
        insS.run(rid, busIds[(i + k) % busIds.length], times[(i + k * 2) % times.length]);
      }
    });
  });
  tx();
}

module.exports = { openDb, seed };
