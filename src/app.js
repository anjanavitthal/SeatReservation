'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { localParts, addDays, addMinutes, isIsoDate } = require('./time');
const { normalizeSeatConfig, seatLayout, isValidSeat } = require('./seats');

const DEFAULTS = {
  timeZone: process.env.TZ_NAME || 'Asia/Kolkata',
  windowDays: Number(process.env.BOOKING_WINDOW_DAYS || 3), // today + N days ahead
  cutoffMinutes: Number(process.env.BOOKING_CUTOFF_MINUTES || 15), // close booking N min before departure
  maxSeatsPerBooking: Number(process.env.MAX_SEATS_PER_BOOKING || 6),
};

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const PHONE_RE = /^\+?[0-9]{7,15}$/;
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function newReference() {
  const bytes = crypto.randomBytes(8);
  let s = 'BS';
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return s;
}

const normalizePhone = (p) => String(p || '').replace(/[\s()-]/g, '');
const maskPhone = (p) => (p.length <= 4 ? '****' : `${'*'.repeat(p.length - 4)}${p.slice(-4)}`);

function createApp({ db, now = () => new Date(), config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- helpers ----------
  const clock = () => localParts(now(), cfg.timeZone);

  function bookableDates() {
    const { date } = clock();
    return Array.from({ length: cfg.windowDays + 1 }, (_, i) => addDays(date, i));
  }

  function assertDateInWindow(date) {
    if (!isIsoDate(date)) throw new ApiError(400, 'INVALID_DATE', 'Date must be YYYY-MM-DD.');
    const dates = bookableDates();
    if (date < dates[0]) throw new ApiError(400, 'DATE_IN_PAST', 'That date has already passed.');
    if (date > dates[dates.length - 1]) {
      throw new ApiError(400, 'DATE_TOO_FAR', `Seats can be booked at most ${cfg.windowDays} days in advance.`);
    }
  }

  /** Booking closes `cutoffMinutes` before departure (local time). */
  function isClosed(date, departureTime) {
    const c = clock();
    const { time: closeAt, dayOffset } = addMinutes(departureTime, -cfg.cutoffMinutes);
    const closeDate = addDays(date, dayOffset);
    return `${c.date} ${c.time}` >= `${closeDate} ${closeAt}`;
  }

  const q = {
    cities: db.prepare('SELECT DISTINCT origin AS city FROM routes UNION SELECT destination FROM routes ORDER BY 1'),
    routes: db.prepare('SELECT id, origin, destination, duration_minutes FROM routes ORDER BY origin, destination'),
    buses: db.prepare('SELECT id, name, operator, bus_type, seat_rows, seat_columns, seat_layout FROM buses ORDER BY name'),
    busRouteTimes: db.prepare(`
      SELECT s.bus_id, r.origin, r.destination, s.departure_time
      FROM schedules s
      JOIN routes r ON r.id = s.route_id
      WHERE s.active = 1
      ORDER BY s.bus_id, r.origin, r.destination, s.departure_time`),
    busById: db.prepare('SELECT id, name, operator, bus_type, seat_rows, seat_columns, seat_layout FROM buses WHERE id = ?'),
    insertBus: db.prepare(`INSERT INTO buses (name, operator, bus_type, seat_rows, seat_columns, seat_layout)
                          VALUES (?,?,?,?,?,?)`),
    insertSchedule: db.prepare('INSERT INTO schedules (route_id, bus_id, departure_time) VALUES (?,?,?)'),
    trips: db.prepare(`
      SELECT s.id, s.departure_time, r.origin, r.destination, r.duration_minutes,
             b.name AS bus_name, b.operator, b.bus_type, b.seat_rows, b.seat_columns, b.seat_layout
      FROM schedules s JOIN routes r ON r.id = s.route_id JOIN buses b ON b.id = s.bus_id
      WHERE s.active = 1 AND r.origin = ? COLLATE NOCASE AND r.destination = ? COLLATE NOCASE
      ORDER BY s.departure_time`),
    trip: db.prepare(`
      SELECT s.id, s.departure_time, r.origin, r.destination, r.duration_minutes,
             b.name AS bus_name, b.operator, b.bus_type, b.seat_rows, b.seat_columns, b.seat_layout
      FROM schedules s JOIN routes r ON r.id = s.route_id JOIN buses b ON b.id = s.bus_id
      WHERE s.active = 1 AND s.id = ?`),
    bookedSeats: db.prepare('SELECT seat_no FROM booking_seats WHERE schedule_id = ? AND travel_date = ? AND active = 1'),
    bookedCount: db.prepare('SELECT COUNT(*) AS c FROM booking_seats WHERE schedule_id = ? AND travel_date = ? AND active = 1'),
    insertBooking: db.prepare(`INSERT INTO bookings (reference, schedule_id, travel_date, passenger_name, phone)
                               VALUES (?,?,?,?,?)`),
    insertSeat: db.prepare('INSERT INTO booking_seats (booking_id, schedule_id, travel_date, seat_no) VALUES (?,?,?,?)'),
    bookingByRef: db.prepare('SELECT * FROM bookings WHERE reference = ?'),
    seatsForBooking: db.prepare('SELECT seat_no FROM booking_seats WHERE booking_id = ? ORDER BY seat_no'),
    cancelBooking: db.prepare(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = datetime('now')
                               WHERE id = ? AND status = 'CONFIRMED'`),
    releaseSeats: db.prepare('UPDATE booking_seats SET active = 0 WHERE booking_id = ?'),
  };

  function tripView(t, date) {
    const arr = addMinutes(t.departure_time, t.duration_minutes);
    const seatCfg = normalizeSeatConfig(t);
    return {
      scheduleId: t.id, date,
      origin: t.origin, destination: t.destination,
      departureTime: t.departure_time,
      arrivalTime: arr.time, arrivalDayOffset: arr.dayOffset,
      durationMinutes: t.duration_minutes,
      bus: {
        name: t.bus_name,
        operator: t.operator,
        type: t.bus_type,
        seatRows: seatCfg.rows,
        seatColumns: seatCfg.columns,
        seatLayout: seatCfg.columnOrder,
      },
      totalSeats: seatCfg.totalSeats,
      availableSeats: seatCfg.totalSeats - q.bookedCount.get(t.id, date).c,
      bookingOpen: !isClosed(date, t.departure_time),
    };
  }

  function bookingView(b) {
    const t = q.trip.get(b.schedule_id);
    return {
      reference: b.reference,
      status: b.status,
      passengerName: b.passenger_name,
      phone: maskPhone(b.phone),
      seats: q.seatsForBooking.all(b.id).map((r) => r.seat_no),
      trip: t ? tripView(t, b.travel_date) : { scheduleId: b.schedule_id, date: b.travel_date },
      createdAt: b.created_at,
      cancelledAt: b.cancelled_at,
    };
  }

  const wrap = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };

  // ---------- routes ----------
  app.get('/api/config', wrap((req, res) => {
    res.json({
      timeZone: cfg.timeZone,
      bookableDates: bookableDates(),
      windowDays: cfg.windowDays,
      cutoffMinutes: cfg.cutoffMinutes,
      maxSeatsPerBooking: cfg.maxSeatsPerBooking,
    });
  }));

  app.get('/api/cities', wrap((req, res) => res.json(q.cities.all().map((r) => r.city))));

  app.get('/api/routes', wrap((req, res) => {
    res.json(q.routes.all().map((r) => ({
      id: r.id,
      origin: r.origin,
      destination: r.destination,
      durationMinutes: r.duration_minutes,
      label: `${r.origin} → ${r.destination}`,
    })));
  }));

  app.get('/api/buses', wrap((req, res) => {
    const routesByBus = new Map();
    for (const row of q.busRouteTimes.all()) {
      if (!routesByBus.has(row.bus_id)) routesByBus.set(row.bus_id, new Map());
      const byRoute = routesByBus.get(row.bus_id);
      const key = `${row.origin}::${row.destination}`;
      if (!byRoute.has(key)) byRoute.set(key, { origin: row.origin, destination: row.destination, departureTimes: [] });
      byRoute.get(key).departureTimes.push(row.departure_time);
    }

    res.json(q.buses.all().map((b) => {
      const routes = Array.from((routesByBus.get(b.id) || new Map()).values()).map((r) => ({
        origin: r.origin,
        destination: r.destination,
        departureTimes: [...new Set(r.departureTimes)].sort(),
      }));

      return {
        id: b.id,
        name: b.name,
        operator: b.operator,
        busType: b.bus_type,
        seatRows: b.seat_rows,
        seatColumns: b.seat_columns,
        seatLayout: String(b.seat_layout || '').split(',').map((v) => v.trim()).filter(Boolean),
        totalSeats: b.seat_rows * b.seat_columns,
        routes,
      };
    }));
  }));

  app.post('/api/buses', wrap((req, res) => {
    const { name, operator, busType, seatRows, seatColumns, seatLayout, routeId, routeIds, departureTime, departureTimes } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanOperator = String(operator || '').trim();
    const cleanBusType = String(busType || '').trim();
    const parsedRows = Number(seatRows);
    const parsedColumns = Number(seatColumns);
    const rawRouteIds = Array.isArray(routeIds) ? routeIds : Array.isArray(routeId) ? routeId : [routeId];
    const selectedRouteIds = rawRouteIds
      .flatMap((value) => String(value ?? '').split(',').map((part) => part.trim()))
      .filter(Boolean)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    const rawDepartureTimes = Array.isArray(departureTimes) ? departureTimes : [departureTime || '08:00'];

    if (!cleanName || !cleanOperator || !cleanBusType) {
      throw new ApiError(400, 'INVALID_BUS', 'Name, operator, and bus type are required.');
    }
    if (!Number.isInteger(parsedRows) || parsedRows < 1 || parsedRows > 20) {
      throw new ApiError(400, 'INVALID_BUS', 'Seat rows must be an integer between 1 and 20.');
    }

    const config = normalizeSeatConfig({
      seat_rows: parsedRows,
      seat_columns: Number.isInteger(parsedColumns) && parsedColumns > 0 ? parsedColumns : undefined,
      seat_layout: seatLayout,
    });

    const normalizedSeatLayout = config.columnOrder.join(',');
    const created = q.insertBus.run(cleanName, cleanOperator, cleanBusType, config.rows, config.columns, normalizedSeatLayout);
    const busId = created.lastInsertRowid;

    selectedRouteIds.forEach((selectedRouteId, index) => {
      const route = db.prepare('SELECT id FROM routes WHERE id = ?').get(selectedRouteId);
      if (!route) return;
      const departure = String(rawDepartureTimes[index] ?? rawDepartureTimes[0] ?? '08:00');
      q.insertSchedule.run(route.id, busId, departure);
    });

    const bus = q.busById.get(busId);
    res.status(201).json({
      id: bus.id,
      name: bus.name,
      operator: bus.operator,
      busType: bus.bus_type,
      seatRows: bus.seat_rows,
      seatColumns: bus.seat_columns,
      seatLayout: String(bus.seat_layout || '').split(',').map((v) => v.trim()).filter(Boolean),
      totalSeats: bus.seat_rows * bus.seat_columns,
      routeIds: selectedRouteIds,
    });
  }));

  app.get('/api/trips', wrap((req, res) => {
    const { from, to, date } = req.query;
    if (!from || !to) throw new ApiError(400, 'MISSING_ROUTE', 'Both "from" and "to" are required.');
    assertDateInWindow(date);
    res.json(q.trips.all(String(from), String(to)).map((t) => tripView(t, date)));
  }));

  app.get('/api/trips/:scheduleId/:date/seats', wrap((req, res) => {
    const { date } = req.params;
    assertDateInWindow(date);
    const t = q.trip.get(Number(req.params.scheduleId));
    if (!t) throw new ApiError(404, 'TRIP_NOT_FOUND', 'Trip not found.');
    res.json({
      trip: tripView(t, date),
      layout: seatLayout(t),
      booked: q.bookedSeats.all(t.id, date).map((r) => r.seat_no),
    });
  }));

  app.post('/api/bookings', wrap((req, res) => {
    const { scheduleId, date, seats, name, phone } = req.body || {};
    assertDateInWindow(date);
    const t = q.trip.get(Number(scheduleId));
    if (!t) throw new ApiError(404, 'TRIP_NOT_FOUND', 'Trip not found.');
    if (isClosed(date, t.departure_time)) {
      throw new ApiError(400, 'BOOKING_CLOSED', `Booking closes ${cfg.cutoffMinutes} minutes before departure.`);
    }

    const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
    if (cleanName.length < 2 || cleanName.length > 60) {
      throw new ApiError(400, 'INVALID_NAME', 'Name must be 2–60 characters.');
    }
    const cleanPhone = normalizePhone(phone);
    if (!PHONE_RE.test(cleanPhone)) throw new ApiError(400, 'INVALID_PHONE', 'Enter a valid phone number (7–15 digits).');

    if (!Array.isArray(seats) || seats.length === 0) throw new ApiError(400, 'NO_SEATS', 'Select at least one seat.');
    const unique = [...new Set(seats.map((s) => String(s).toUpperCase()))];
    if (unique.length !== seats.length) throw new ApiError(400, 'DUPLICATE_SEATS', 'A seat was selected twice.');
    if (unique.length > cfg.maxSeatsPerBooking) {
      throw new ApiError(400, 'TOO_MANY_SEATS', `You can book up to ${cfg.maxSeatsPerBooking} seats at a time.`);
    }
    const bad = unique.filter((s) => !isValidSeat(s, t));
    if (bad.length) throw new ApiError(400, 'INVALID_SEAT', `Invalid seat(s): ${bad.join(', ')}`);

    let booking;
    try {
      booking = db.transaction(() => {
        const ref = newReference();
        const id = q.insertBooking.run(ref, t.id, date, cleanName, cleanPhone).lastInsertRowid;
        for (const s of unique) q.insertSeat.run(id, t.id, date, s); // unique index rejects taken seats
        return q.bookingByRef.get(ref);
      })();
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
        const taken = new Set(q.bookedSeats.all(t.id, date).map((r) => r.seat_no));
        const conflict = unique.filter((s) => taken.has(s));
        const err = new ApiError(409, 'SEAT_TAKEN', `Sorry, already booked: ${conflict.join(', ') || 'one of your seats'}.`);
        err.seats = conflict;
        throw err;
      }
      throw e;
    }
    res.status(201).json(bookingView(booking));
  }));

  function findOwnedBooking(reference, phone) {
    const b = q.bookingByRef.get(String(reference || '').trim().toUpperCase());
    // Same response for "not found" and "wrong phone" so references can't be probed.
    if (!b || b.phone !== normalizePhone(phone)) {
      throw new ApiError(404, 'BOOKING_NOT_FOUND', 'No booking matches that reference and phone number.');
    }
    return b;
  }

  app.get('/api/bookings/:reference', wrap((req, res) => {
    res.json(bookingView(findOwnedBooking(req.params.reference, req.query.phone)));
  }));

  app.post('/api/bookings/:reference/cancel', wrap((req, res) => {
    const b = findOwnedBooking(req.params.reference, (req.body || {}).phone);
    if (b.status === 'CANCELLED') throw new ApiError(400, 'ALREADY_CANCELLED', 'This booking is already cancelled.');
    const t = q.trip.get(b.schedule_id);
    if (t && isClosed(b.travel_date, t.departure_time)) {
      throw new ApiError(400, 'CANCEL_CLOSED', 'This trip has departed or is about to depart and can no longer be cancelled.');
    }
    db.transaction(() => { q.cancelBooking.run(b.id); q.releaseSeats.run(b.id); })();
    res.json(bookingView(q.bookingByRef.get(b.reference)));
  }));

  // ---------- errors ----------
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.seats && { seats: err.seats }) } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body.' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  return app;
}

module.exports = { createApp };
