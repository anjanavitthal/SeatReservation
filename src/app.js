'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { localParts, addDays, addMinutes, isIsoDate } = require('./time');
const { seatLayout, isValidSeat } = require('./seats');

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
    trips: db.prepare(`
      SELECT s.id, s.departure_time, r.origin, r.destination, r.duration_minutes,
             b.name AS bus_name, b.operator, b.bus_type, b.seat_rows
      FROM schedules s JOIN routes r ON r.id = s.route_id JOIN buses b ON b.id = s.bus_id
      WHERE s.active = 1 AND r.origin = ? COLLATE NOCASE AND r.destination = ? COLLATE NOCASE
      ORDER BY s.departure_time`),
    trip: db.prepare(`
      SELECT s.id, s.departure_time, r.origin, r.destination, r.duration_minutes,
             b.name AS bus_name, b.operator, b.bus_type, b.seat_rows
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
    const total = t.seat_rows * 4;
    return {
      scheduleId: t.id, date,
      origin: t.origin, destination: t.destination,
      departureTime: t.departure_time,
      arrivalTime: arr.time, arrivalDayOffset: arr.dayOffset,
      durationMinutes: t.duration_minutes,
      bus: { name: t.bus_name, operator: t.operator, type: t.bus_type },
      totalSeats: total,
      availableSeats: total - q.bookedCount.get(t.id, date).c,
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
      layout: seatLayout(t.seat_rows),
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
    const bad = unique.filter((s) => !isValidSeat(s, t.seat_rows));
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
