'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, seed } = require('../src/db');
const { createApp } = require('../src/app');

// Fixed clock: 2026-10-01 08:00 IST (02:30 UTC)
let nowValue = new Date('2026-10-01T02:30:00Z');

async function setup() {
  const db = openDb(':memory:');
  seed(db);
  const server = createApp({ db, now: () => nowValue }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const res = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: res.status, body: await res.json() };
  };
  const trip = db.prepare(`SELECT s.id, s.departure_time FROM schedules s JOIN routes r ON r.id = s.route_id
    WHERE r.origin='Mumbai' AND r.destination='Pune' ORDER BY s.departure_time DESC LIMIT 1`).get();
  return { db, server, call, trip };
}

test('booking window is today + 3 days', async (t) => {
  const { server, call } = await setup(); t.after(() => server.close());
  const { body } = await call('/api/config');
  assert.deepEqual(body.bookableDates, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal((await call('/api/trips?from=Mumbai&to=Pune&date=2026-10-05')).body.error.code, 'DATE_TOO_FAR');
  assert.equal((await call('/api/trips?from=Mumbai&to=Pune&date=2026-09-30')).body.error.code, 'DATE_IN_PAST');
  assert.equal((await call('/api/trips?from=Mumbai&to=Pune&date=2026-10-04')).status, 200);
});

test('book, prevent double booking, look up, cancel frees seats', async (t) => {
  const { server, call, trip } = await setup(); t.after(() => server.close());
  const date = '2026-10-02';
  const ok = await call('/api/bookings', { scheduleId: trip.id, date, seats: ['1A', '1B'], name: 'Test Rider', phone: '98765 43210' });
  assert.equal(ok.status, 201);
  assert.match(ok.body.reference, /^BS[A-Z2-9]{8}$/);
  assert.equal(ok.body.phone, '******3210'); // masked

  const clash = await call('/api/bookings', { scheduleId: trip.id, date, seats: ['1B', '2A'], name: 'Other', phone: '9123456780' });
  assert.equal(clash.status, 409);
  assert.deepEqual(clash.body.error.seats, ['1B']);

  // clash must not leave partial seats behind
  const seats = await call(`/api/trips/${trip.id}/${date}/seats`);
  assert.deepEqual(seats.body.booked.sort(), ['1A', '1B']);

  // same seat on another date is fine
  assert.equal((await call('/api/bookings', { scheduleId: trip.id, date: '2026-10-03', seats: ['1A'], name: 'Other', phone: '9123456780' })).status, 201);

  const ref = ok.body.reference;
  assert.equal((await call(`/api/bookings/${ref}?phone=0000000000`)).status, 404);
  assert.equal((await call(`/api/bookings/${ref.toLowerCase()}?phone=9876543210`)).body.status, 'CONFIRMED');

  const cancelled = await call(`/api/bookings/${ref}/cancel`, { phone: '9876543210' });
  assert.equal(cancelled.body.status, 'CANCELLED');
  assert.equal((await call(`/api/bookings/${ref}/cancel`, { phone: '9876543210' })).body.error.code, 'ALREADY_CANCELLED');
  assert.equal((await call('/api/bookings', { scheduleId: trip.id, date, seats: ['1B'], name: 'Third', phone: '9000000000' })).status, 201);
});

test('validation', async (t) => {
  const { server, call, trip } = await setup(); t.after(() => server.close());
  const base = { scheduleId: trip.id, date: '2026-10-02', seats: ['1A'], name: 'Valid Name', phone: '9876543210' };
  const code = async (over) => (await call('/api/bookings', { ...base, ...over })).body.error?.code;
  assert.equal(await code({ name: 'A' }), 'INVALID_NAME');
  assert.equal(await code({ phone: '12ab' }), 'INVALID_PHONE');
  assert.equal(await code({ seats: [] }), 'NO_SEATS');
  assert.equal(await code({ seats: ['1A', '1a'] }), 'DUPLICATE_SEATS');
  assert.equal(await code({ seats: ['99Z'] }), 'INVALID_SEAT');
  assert.equal(await code({ seats: ['1A', '1B', '1C', '1D', '2A', '2B', '2C'] }), 'TOO_MANY_SEATS');
  assert.equal(await code({ scheduleId: 9999 }), 'TRIP_NOT_FOUND');
});

test('admin can add a bus with custom seat layout', async (t) => {
  const { server, call, db } = await setup(); t.after(() => server.close());
  const route = db.prepare('SELECT id FROM routes WHERE origin = ? AND destination = ?').get('Mumbai', 'Pune');
  const created = await call('/api/buses', {
    name: 'City Cruiser',
    operator: 'Metro Transit',
    busType: 'Sleeper',
    seatRows: 3,
    seatColumns: 2,
    seatLayout: 'A,B',
    routeId: route.id,
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'City Cruiser');
  assert.equal(created.body.seatRows, 3);
  assert.deepEqual(created.body.seatLayout, ['A', 'B']);
  assert.equal(created.body.totalSeats, 6);
  assert.equal((await call('/api/buses')).body.some((b) => b.name === 'City Cruiser'), true);
  assert.ok((await call('/api/buses')).body.find((b) => b.name === 'City Cruiser').routes.some((r) => r.origin === 'Mumbai' && r.destination === 'Pune'));
});

test('admin can add a bus with multiple routes', async (t) => {
  const { server, call, db } = await setup(); t.after(() => server.close());
  const routeA = db.prepare('SELECT id FROM routes WHERE origin = ? AND destination = ?').get('Mumbai', 'Pune');
  const routeB = db.prepare('SELECT id FROM routes WHERE origin = ? AND destination = ?').get('Pune', 'Mumbai');
  const created = await call('/api/buses', {
    name: 'Multi Route Bus',
    operator: 'City Fleet',
    busType: 'AC Sleeper',
    seatRows: 4,
    seatColumns: 2,
    seatLayout: 'A,B',
    routeIds: [routeA.id, routeB.id],
    departureTimes: ['08:00', '18:30'],
  });

  assert.equal(created.status, 201);
  const saved = (await call('/api/buses')).body.find((b) => b.name === 'Multi Route Bus');
  assert.ok(saved);
  assert.equal(saved.routes.length, 2);
  assert.deepEqual(saved.routes.map((r) => `${r.origin} → ${r.destination}`).sort(), ['Mumbai → Pune', 'Pune → Mumbai'].sort());
});

test('admin bus list includes route information', async (t) => {
  const { server, call, db } = await setup(); t.after(() => server.close());
  const bus = db.prepare('SELECT id, name FROM buses ORDER BY id LIMIT 1').get();
  const busList = (await call('/api/buses')).body;
  const found = busList.find((b) => b.id === bus.id);
  assert.ok(found);
  assert.ok(Array.isArray(found.routes));
  assert.ok(found.routes.length > 0);
  assert.ok(found.routes.some((r) => r.origin && r.destination));
});

test('bus routes include departure times for UI rendering', async (t) => {
  const { server, call, db } = await setup(); t.after(() => server.close());
  const bus = db.prepare('SELECT id, name FROM buses ORDER BY id LIMIT 1').get();
  const found = (await call('/api/buses')).body.find((b) => b.id === bus.id);
  assert.ok(found.routes.some((r) => Array.isArray(r.departureTimes) && r.departureTimes.length > 0));
});

test('booking closes 15 minutes before departure', async (t) => {
  const { server, call, trip } = await setup(); t.after(() => server.close());
  const [h, m] = trip.departure_time.split(':').map(Number);
  // set clock to 10 minutes before departure today (IST = UTC+5:30)
  const istMinutes = h * 60 + m - 10;
  nowValue = new Date(Date.UTC(2026, 9, 1, 0, istMinutes - 330));
  t.after(() => { nowValue = new Date('2026-10-01T02:30:00Z'); });
  const r = await call('/api/bookings', { scheduleId: trip.id, date: '2026-10-01', seats: ['3A'], name: 'Late Rider', phone: '9876543210' });
  assert.equal(r.body.error.code, 'BOOKING_CLOSED');
  const list = await call('/api/trips?from=Mumbai&to=Pune&date=2026-10-01');
  assert.equal(list.body.find((x) => x.scheduleId === trip.id).bookingOpen, false);
});

test('bus seat configuration is per-bus and enforced', async (t) => {
  const db = openDb(':memory:');
  seed(db);
  const routeId = db.prepare('INSERT INTO routes (origin, destination, duration_minutes) VALUES (?, ?, ?)')
    .run('Nashik', 'Nagpur', 420).lastInsertRowid;
  const busId = db.prepare(`INSERT INTO buses (name, operator, bus_type, seat_rows, seat_columns, seat_layout)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('Nashik Flex', 'Nashik Lines', 'Sleeper', 2, 3, 'A,B,C').lastInsertRowid;
  const scheduleId = db.prepare('INSERT INTO schedules (route_id, bus_id, departure_time) VALUES (?, ?, ?)')
    .run(routeId, busId, '11:15').lastInsertRowid;
  const server = createApp({ db, now: () => new Date('2026-10-01T02:30:00Z') }).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const res = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: res.status, body: await res.json() };
  };

  const seats = await call(`/api/trips/${scheduleId}/2026-10-02/seats`);
  assert.deepEqual(seats.body.layout, [['1A', '1B', '1C'], ['2A', '2B', '2C']]);
  assert.equal((await call('/api/bookings', { scheduleId, date: '2026-10-02', seats: ['2C'], name: 'Seat Config', phone: '9090909090' })).status, 201);
  assert.equal((await call('/api/bookings', { scheduleId, date: '2026-10-02', seats: ['2D'], name: 'Bad Seat', phone: '9090909091' })).body.error.code, 'INVALID_SEAT');
});
