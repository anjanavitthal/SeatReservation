# SeatSure — Bus Seat Booking

Reserve bus seats in advance — **no payment**, bookings allowed from **today up to 3 days ahead**.

Node.js + Express + SQLite backend, dependency-free vanilla JS frontend.

## Run

```bash
npm install
npm start          # http://localhost:3000  (seeds demo routes/buses on first run)
npm test           # API tests (node:test)
```

## Features

- Search by origin, destination and date (only the 4 bookable dates are offered)
- Visual 2+2 seat map with live availability; pick up to 6 seats
- Book with name + phone → get a reference like `BS7JTXGPZP`
- "My booking": look up by reference + phone, cancel to release seats
- Booking/cancellation closes 15 min before departure

## Business rules (enforced server-side)

| Rule | Where |
|---|---|
| Date must be today … today + 3 (in `TZ_NAME`) | `assertDateInWindow` |
| No booking within cutoff of departure | `isClosed` |
| A seat can't be double-booked | partial unique index `ux_active_seat` on `(schedule_id, travel_date, seat_no) WHERE active = 1` — atomic, race-safe |
| Booking is all-or-nothing | seats inserted in one transaction |
| Cancelled seats become available again | `active = 0` drops them out of the unique index |
| Look-up needs reference **and** phone; wrong phone ⇒ same 404 as unknown ref | `findOwnedBooking` |
| Phone is masked in all API responses | `maskPhone` |

## Configuration (env vars)

| Var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DB_FILE` | `data/bus.db` | `:memory:` for throwaway |
| `TZ_NAME` | `Asia/Kolkata` | defines "today" and departure times |
| `BOOKING_WINDOW_DAYS` | `3` | days ahead beyond today |
| `BOOKING_CUTOFF_MINUTES` | `15` | |
| `MAX_SEATS_PER_BOOKING` | `6` | |

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` | bookable dates, limits |
| GET | `/api/cities` | |
| GET | `/api/trips?from=&to=&date=` | trips with `availableSeats`, `bookingOpen` |
| GET | `/api/trips/:scheduleId/:date/seats` | layout + booked seats |
| POST | `/api/bookings` | `{scheduleId, date, seats[], name, phone}` → `201`; `409 SEAT_TAKEN` with `seats` |
| GET | `/api/bookings/:ref?phone=` | |
| POST | `/api/bookings/:ref/cancel` | `{phone}` |

Errors: `{ "error": { "code": "DATE_TOO_FAR", "message": "..." } }`.

## Data model

`routes` → `schedules` (bus + daily departure time) ← `buses`; `bookings` (one per passenger/contact) → `booking_seats`.
A *trip* is a `(schedule_id, travel_date)` pair, so no per-day rows need generating.

## Next steps (not built)

- Admin UI for routes/buses/schedules (currently seeded in `src/db.js`)
- Rate limiting on booking + lookup endpoints; OTP phone verification
- SMS/email confirmation; per-passenger names for multi-seat bookings
- Postgres for multi-instance deployment (same partial-unique-index approach works)
