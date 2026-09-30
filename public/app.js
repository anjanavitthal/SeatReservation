'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error?.message || 'Request failed'); e.data = data.error; throw e; }
    return data;
  }

  const fmtDate = (iso, opts) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, opts);
  const fmtDur = (m) => `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;

  const state = { config: null, date: null, trip: null, booked: new Set(), selected: new Set() };

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${t.dataset.view}`));
  }));

  // ---------- init ----------
  async function init() {
    const [config, cities] = await Promise.all([api('/api/config'), api('/api/cities')]);
    state.config = config;
    const form = $('#search');
    for (const sel of [form.from, form.to]) sel.innerHTML = cities.map((c) => `<option>${esc(c)}</option>`).join('');
    form.from.value = cities.includes('Mumbai') ? 'Mumbai' : cities[0];
    form.to.value = cities.includes('Pune') ? 'Pune' : cities[1];

    const chips = $('#date-chips');
    chips.innerHTML = config.bookableDates.map((d, i) => `
      <button type="button" class="chip${i === 0 ? ' active' : ''}" data-date="${d}">
        <b>${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmtDate(d, { weekday: 'short' })}</b>
        <span>${fmtDate(d, { day: 'numeric', month: 'short' })}</span>
      </button>`).join('');
    state.date = config.bookableDates[0];
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
      state.date = b.dataset.date;
    });
    $('#window-hint').textContent =
      `Book up to ${config.windowDays} days ahead · up to ${config.maxSeatsPerBooking} seats per booking · booking closes ${config.cutoffMinutes} min before departure.`;
  }

  $('#swap').addEventListener('click', () => {
    const f = $('#search'); [f.from.value, f.to.value] = [f.to.value, f.from.value];
  });

  // ---------- search ----------
  $('#search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    closeSeats();
    const out = $('#results');
    if (f.from.value === f.to.value) { out.innerHTML = '<div class="card empty">Origin and destination must differ.</div>'; return; }
    out.innerHTML = '<div class="card empty">Searching…</div>';
    try {
      const qs = new URLSearchParams({ from: f.from.value, to: f.to.value, date: state.date });
      renderTrips(await api(`/api/trips?${qs}`));
    } catch (err) { out.innerHTML = `<div class="card empty">${esc(err.message)}</div>`; }
  });

  function renderTrips(trips) {
    const out = $('#results');
    if (!trips.length) { out.innerHTML = '<div class="card empty">No buses on this route. Try another city pair.</div>'; return; }
    out.innerHTML = trips.map((t) => {
      const cls = t.availableSeats === 0 ? 'none' : t.availableSeats <= 5 ? 'low' : '';
      const action = !t.bookingOpen ? '<span class="muted">Booking closed</span>'
        : t.availableSeats === 0 ? '<span class="muted">Sold out</span>'
        : `<button class="primary" data-trip="${t.scheduleId}">Select seats</button>`;
      return `<div class="card trip">
        <div><h3>${esc(t.bus.name)}</h3><p class="muted">${esc(t.bus.operator)} · ${esc(t.bus.type)}</p></div>
        <div>
          <div class="times">${t.departureTime} → ${t.arrivalTime}${t.arrivalDayOffset ? ` <small>+${t.arrivalDayOffset}d</small>` : ''}</div>
          <p class="muted">${fmtDur(t.durationMinutes)} · <span class="avail ${cls}">${t.availableSeats}/${t.totalSeats} seats left</span></p>
        </div>
        <div>${action}</div>
      </div>`;
    }).join('');
  }

  $('#results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-trip]');
    if (b) openSeats(Number(b.dataset.trip), state.date);
  });

  // ---------- seats ----------
  async function openSeats(scheduleId, date) {
    const data = await api(`/api/trips/${scheduleId}/${date}/seats`);
    state.trip = data.trip;
    state.booked = new Set(data.booked);
    state.selected = new Set();
    $('#seat-title').textContent = `${data.trip.origin} → ${data.trip.destination}`;
    $('#seat-sub').textContent = `${data.trip.bus.name} · ${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })} · departs ${data.trip.departureTime}`;
    $('#seat-grid').innerHTML = data.layout.map((row) => `<div class="row">
      ${row.map((s, i) => `${i === 2 ? '<span></span>' : ''}<button type="button" class="seat ${state.booked.has(s) ? 'booked' : 'free'}"
        data-seat="${s}" ${state.booked.has(s) ? 'disabled aria-label="Seat ' + s + ' booked"' : 'aria-pressed="false"'}>${s}</button>`).join('')}
    </div>`).join('');
    $('#book-error').textContent = '';
    updateSummary();
    $('#seat-panel').classList.remove('hidden');
    $('#seat-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeSeats() { $('#seat-panel').classList.add('hidden'); state.trip = null; }
  $('#close-seats').addEventListener('click', closeSeats);

  $('#seat-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.seat'); if (!b || b.disabled) return;
    const s = b.dataset.seat;
    if (state.selected.has(s)) state.selected.delete(s);
    else {
      if (state.selected.size >= state.config.maxSeatsPerBooking) {
        $('#book-error').textContent = `You can select up to ${state.config.maxSeatsPerBooking} seats.`; return;
      }
      state.selected.add(s);
    }
    $('#book-error').textContent = '';
    b.classList.toggle('selected', state.selected.has(s));
    b.classList.toggle('free', !state.selected.has(s));
    b.setAttribute('aria-pressed', state.selected.has(s));
    updateSummary();
  });

  function updateSummary() {
    const seats = [...state.selected];
    $('#selected-summary').textContent = seats.length ? `Seats: ${seats.join(', ')}` : 'No seats selected';
    $('#book-btn').disabled = seats.length === 0;
  }

  $('#passenger').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const btn = $('#book-btn');
    btn.disabled = true; $('#book-error').textContent = '';
    try {
      const booking = await api('/api/bookings', {
        method: 'POST',
        body: { scheduleId: state.trip.scheduleId, date: state.trip.date, seats: [...state.selected], name: f.name.value, phone: f.phone.value },
      });
      f.reset();
      showConfirmation(booking);
      $('#search').requestSubmit(); // refresh availability counts (closes the seat panel)
    } catch (err) {
      $('#book-error').textContent = err.message;
      if (err.data?.code === 'SEAT_TAKEN') await openSeats(state.trip.scheduleId, state.trip.date);
      btn.disabled = state.selected.size === 0;
    }
  });

  // ---------- confirmation / tickets ----------
  function ticketHtml(b, withCancel) {
    const t = b.trip;
    return `<div class="ticket">
      <div><span class="badge ${b.status}">${b.status}</span></div>
      <div class="ref">${esc(b.reference)}</div>
      <dl class="kv">
        <dt>Route</dt><dd>${esc(t.origin)} → ${esc(t.destination)}</dd>
        <dt>Date</dt><dd>${fmtDate(t.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</dd>
        <dt>Departure</dt><dd>${t.departureTime} (arrives ${t.arrivalTime}${t.arrivalDayOffset ? ' next day' : ''})</dd>
        <dt>Bus</dt><dd>${esc(t.bus.name)} · ${esc(t.bus.type)}</dd>
        <dt>Seats</dt><dd>${b.seats.map(esc).join(', ')}</dd>
        <dt>Passenger</dt><dd>${esc(b.passengerName)} · ${esc(b.phone)}</dd>
      </dl>
      ${withCancel && b.status === 'CONFIRMED' && t.bookingOpen ? '<button class="danger" id="cancel-btn">Cancel booking</button>' : ''}
    </div>`;
  }

  function showConfirmation(b) {
    $('#confirm-body').innerHTML = `<h2 style="margin-top:0">Seats reserved!</h2>
      <p class="muted">Save your booking reference — you'll need it with your phone number to view or cancel.</p>${ticketHtml(b, false)}`;
    $('#confirm-dialog').showModal();
  }

  // ---------- manage ----------
  let lookupPhone = '';
  $('#lookup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; $('#lookup-error').textContent = ''; $('#booking-detail').innerHTML = '';
    try {
      lookupPhone = f.phone.value;
      const b = await api(`/api/bookings/${encodeURIComponent(f.reference.value.trim())}?${new URLSearchParams({ phone: lookupPhone })}`);
      renderManaged(b);
    } catch (err) { $('#lookup-error').textContent = err.message; }
  });

  function renderManaged(b) {
    $('#booking-detail').innerHTML = `<div class="card">${ticketHtml(b, true)}<p class="error" id="cancel-error"></p></div>`;
    const c = $('#cancel-btn');
    if (c) c.addEventListener('click', async () => {
      if (!confirm(`Cancel booking ${b.reference}? Your seats will be released.`)) return;
      try { renderManaged(await api(`/api/bookings/${b.reference}/cancel`, { method: 'POST', body: { phone: lookupPhone } })); }
      catch (err) { $('#cancel-error').textContent = err.message; }
    });
  }

  init().catch((e) => { $('#results').innerHTML = `<div class="card empty">Could not load: ${esc(e.message)}</div>`; });
})();
