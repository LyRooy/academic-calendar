// Logika interfejsu: renderowanie tygodnia, tryb przeglądania i edycji,
// formularze, zapis lokalny (localStorage) oraz synchronizacja z Workerem Cloudflare (/api/plan).

import {
  emptyPlan,
  validatePlan,
  datesFor,
  addDays,
  monday,
  holidayFor,
  reconcileWithAcademicYear,
  resolvePlanKey,
} from './model.js';

// --- Stałe i stan ------------------------------------------------------------

const STORAGE_KEY = 'student-calendar-v1';
const TOKEN_KEY = 'student-calendar-token';
const PLAN_ID_KEY = 'student-calendar-plan-id';
const API_URL = '/api/plan'; // ten sam adres co frontend — Worker obsługuje oba
const API_TIMEOUT_MS = 20_000;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;
const DAY_NAMES = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Ndz'];
const MOBILE_DAY_CODES = ['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SB', 'ND'];

function weekdayIndex(date) {
  return (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7;
}

/** state.plan – dane planu, state.etag – wersja z chmury, state.dirty – niezsynchronizowane zmiany */
let state = { plan: emptyPlan(), etag: null, dirty: false };
let lastStored = null;       // ostatnia wartość zapisana przez tę kartę (wykrywanie innych kart)
let storageBlocked = false;  // localStorage niedostępny lub zmieniony przez inną kartę
let busy = false;            // trwa synchronizacja
let editMode = false;        // false = normalny tryb przeglądania, true = tryb edycji
let editingId = null;        // id edytowanych zajęć (null = nowe)
let detailsEventId = null;   // id zajęć aktualnie wyświetlanych w oknie szczegółów
let week = monday(today());  // poniedziałek wyświetlanego tygodnia
let selectedDayIndex = weekdayIndex(today()); // 0..6 — aktywny dzień w widoku mobilnym (jak w USOS)

// --- Narzędzia ---------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

/** Dzisiejsza data lokalna w formacie RRRR-MM-DD. */
function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

const uid = () => crypto.randomUUID();
const clone = (value) => structuredClone(value);

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

const dayMonthFormat = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long' });
const fullDateFormat = new Intl.DateTimeFormat('pl-PL', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const formatDate = (date) => dayMonthFormat.format(new Date(date + 'T12:00:00Z'));
const formatFullDate = (date) => fullDateFormat.format(new Date(date + 'T12:00:00Z'));

const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// --- Komunikaty --------------------------------------------------------------

function setStatus(message) {
  $('status').textContent = message;
}

function reportState() {
  if (storageBlocked) {
    setStatus('Nie można bezpiecznie zapisać danych lokalnych. Wyeksportuj plan i sprawdź pamięć przeglądarki.');
  } else if (state.dirty) {
    setStatus('Masz lokalne zmiany · Kliknij „Zapisz w chmurze”, aby nadpisać plan w chmurze i udostępnić go na innych urządzeniach.');
  } else {
    setStatus('Plan zapisany lokalnie · Pobierz z chmury, aby sprawdzić aktualną wersję.');
  }
}

// --- Tryb przeglądania vs. Tryb edycji ---------------------------------------

function setEditMode(enabled) {
  editMode = !!enabled;
  const toggle = $('editModeToggle');
  toggle.setAttribute('aria-pressed', String(editMode));
  toggle.innerHTML = editMode
    ? '<i class="ph ph-pencil-simple-line"></i> <span class="btn-label">Tryb edycji: Wł.</span>'
    : '<i class="ph ph-pencil-simple"></i> <span class="btn-label">Tryb edycji: Wył.</span>';

  $('addEvent').hidden = !editMode;
  $('calendarHint').textContent = editMode
    ? 'Tryb edycji aktywny: kliknij nagłówek dnia lub pusty dzień (poza dniami wolnymi), aby dodać zajęcia. Kliknij istniejące zajęcia, aby je edytować lub usunąć.'
    : 'Kliknij zajęcia, aby zobaczyć szczegóły przedmiotu i spotkania. Włącz „Tryb edycji” u góry, aby dodawać lub zmieniać zajęcia w kalendarzu.';

  render();
}

function setMobileMenuOpen(open) {
  const panel = $('navPanel');
  const btn = $('menuToggle');
  const isOpen = !!open;
  panel.classList.toggle('open', isOpen);
  btn.setAttribute('aria-expanded', String(isOpen));
  btn.innerHTML = isOpen
    ? '<i class="ph ph-x"></i><span>Zamknij</span>'
    : '<i class="ph ph-list"></i><span>Menu</span>';
}

// --- Zapis lokalny -----------------------------------------------------------

function loadFromStorage() {
  try {
    lastStored = localStorage.getItem(STORAGE_KEY);
    if (lastStored) {
      const saved = JSON.parse(lastStored);
      validatePlan(saved.plan);
      state = { plan: saved.plan, etag: saved.etag ?? null, dirty: !!saved.dirty };
    }
  } catch {
    // Brak dostępu do localStorage lub uszkodzony wpis — blokujemy zapis, żeby niczego nie nadpisać.
    storageBlocked = true;
  }
}

function persist(next) {
  if (storageBlocked) {
    throw Error('Zapis lokalny jest zablokowany. Wyeksportuj plan przed przeładowaniem strony.');
  }
  if (localStorage.getItem(STORAGE_KEY) !== lastStored) {
    throw Error('Inna karta zmieniła plan. Wyeksportuj swoją kopię i odśwież stronę.');
  }

  const encoded = JSON.stringify(next);
  localStorage.setItem(STORAGE_KEY, encoded);
  lastStored = encoded;
  state = next;
}

/** Wykonuje zmianę na kopii planu, waliduje ją, zapisuje lokalnie i odświeża widok. */
function mutate(change) {
  if (busy) throw Error('Poczekaj na zakończenie synchronizacji.');

  const next = clone(state);
  change(next.plan);
  validatePlan(next.plan);
  next.dirty = true;

  persist(next);
  render();
  reportState();
}

// Mapowanie dni tygodnia na klucze
const DAY_KEY_NAMES = {
  mon: 'poniedziałku',
  tue: 'wtorku',
  wed: 'środy',
  thu: 'czwartku',
  fri: 'piątku',
  sat: 'soboty',
  sun: 'niedzieli',
};

// --- Widok tygodnia (oś godzin co 5 min, zajęcia proporcjonalne i okienka) ---

const SLOT_MINUTES = 5;
const SLOT_HEIGHT_PX = 15; // 5 min = 15px → 15 min = 45px, 45 min = 135px, 60 min = 180px
const DEFAULT_START_MIN = 8 * 60; // 08:00
const DEFAULT_END_MIN = 16 * 60;  // 16:00

function fromMinutes(total) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  const h = String(Math.floor(clamped / 60)).padStart(2, '0');
  const m = String(clamped % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h} godz. ${m} min`;
  if (h > 0) return `${h} godz.`;
  return `${m} min`;
}

/** Wyznacza zakres godzin siatki tygodnia (zaokrąglony do pełnych godzin). */
function getGridBounds(weekEvents, specialDaysInWeek = []) {
  let startMin = DEFAULT_START_MIN;
  let endMin = DEFAULT_END_MIN;

  for (const e of weekEvents) {
    const s = toMinutes(e.start);
    const end = toMinutes(e.end);
    if (s < startMin) startMin = Math.floor(s / 60) * 60;
    if (end > endMin) endMin = Math.ceil(end / 60) * 60;
  }

  for (const sd of specialDaysInWeek) {
    if (sd?.type === 'rector' && sd.start && sd.end) {
      const s = toMinutes(sd.start);
      const end = toMinutes(sd.end);
      if (s < startMin) startMin = Math.floor(s / 60) * 60;
      if (end > endMin) endMin = Math.ceil(end / 60) * 60;
    }
  }

  return { startMin, endMin };
}

/** Sprawdza, czy dane zajęcia wypadają w trakcie godzin/dnia rektorskiego. */
function isEventCancelledByRector(event, specialDay) {
  if (specialDay?.type !== 'rector') return false;
  if (!event.subjectId) return false; // Wydarzenia własne (np. dentysta) nie przepadają
  if (!specialDay.start || !specialDay.end) return true;
  return (
    toMinutes(event.start) < toMinutes(specialDay.end) &&
    toMinutes(event.end) > toMinutes(specialDay.start)
  );
}

/** Oblicza wpływ godzin/dnia rektorskiego na plan dnia oraz ile czasu jest wolnego. */
function describeRectorImpact(dayEvents, specialDay) {
  const isFullDayRector = !specialDay.start || !specialDay.end;
  const classEvents = dayEvents.filter((e) => Boolean(e.subjectId));
  const cancelled = classEvents.filter((e) => isEventCancelledByRector(e, specialDay));
  const active = classEvents.filter((e) => !isEventCancelledByRector(e, specialDay));

  if (isFullDayRector) {
    return {
      fullDayFree: true,
      cancelledCount: cancelled.length,
      title: 'Wolny dzień · Dzień rektorski',
      hoursLabel: 'Cały dzień',
      freeSummary: cancelled.length
        ? `Wszystkie zajęcia (${cancelled.length}) odwołane — cały dzień wolny`
        : 'Cały dzień wolny od zajęć',
    };
  }

  const rStart = toMinutes(specialDay.start);
  const rEnd = toMinutes(specialDay.end);
  const hoursLabel = `${specialDay.start} – ${specialDay.end} (${formatDuration(rEnd - rStart)})`;

  if (classEvents.length > 0 && active.length === 0) {
    return {
      fullDayFree: true,
      cancelledCount: cancelled.length,
      title: 'Wolny dzień · Godziny rektorskie',
      hoursLabel,
      freeSummary: `Wszystkie zajęcia w tym dniu (${cancelled.length}) przepadają — wolny dzień`,
    };
  }

  const before = active.filter((e) => toMinutes(e.end) <= rStart);
  const after = active.filter((e) => toMinutes(e.start) >= rEnd);

  let freeSummary = '';
  if (before.length > 0 && after.length > 0) {
    const freeFrom = Math.max(...before.map((e) => toMinutes(e.end)));
    const freeUntil = Math.min(...after.map((e) => toMinutes(e.start)));
    const freeMin = Math.max(0, freeUntil - freeFrom);
    freeSummary = `Wolne między zajęciami: ${formatDuration(freeMin)} (${fromMinutes(freeFrom)} – ${fromMinutes(freeUntil)})`;
  } else if (before.length > 0 && after.length === 0) {
    const freeFrom = Math.max(...before.map((e) => toMinutes(e.end)));
    freeSummary = cancelled.length
      ? `Końcowe zajęcia przepadają — wolne od ${fromMinutes(freeFrom)} do końca dnia`
      : `Wolne od ${fromMinutes(freeFrom)} do końca dnia`;
  } else if (before.length === 0 && after.length > 0) {
    const freeUntil = Math.min(...after.map((e) => toMinutes(e.start)));
    freeSummary = cancelled.length
      ? `Poranne zajęcia przepadają — wolne do ${fromMinutes(freeUntil)}`
      : `Wolny poranek — zajęcia od ${fromMinutes(freeUntil)}`;
  } else {
    freeSummary = `Wolne: ${formatDuration(rEnd - rStart)} (${specialDay.start} – ${specialDay.end})`;
  }

  return {
    fullDayFree: false,
    cancelledCount: cancelled.length,
    title: 'Godziny rektorskie',
    hoursLabel,
    freeSummary,
  };
}

/** Wylicza okienka (wolne przerwy) pomiędzy zajęciami w danym dniu. */
function computeGaps(dayEvents) {
  if (dayEvents.length < 2) return [];

  const intervals = dayEvents
    .map((e) => ({ start: toMinutes(e.start), end: toMinutes(e.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = intervals[i];
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }

  const gaps = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const gapStart = merged[i].end;
    const gapEnd = merged[i + 1].start;
    const durationMin = gapEnd - gapStart;
    if (durationMin > 0) {
      gaps.push({ startMin: gapStart, endMin: gapEnd, durationMin });
    }
  }
  return gaps;
}

/** Rozkłada nakładające się zajęcia w kolumny obok siebie. */
function layoutDayEvents(dayEvents) {
  const sorted = [...dayEvents].sort(
    (a, b) => toMinutes(a.start) - toMinutes(b.start) || toMinutes(b.end) - toMinutes(a.end),
  );
  const clusters = [];
  let currentCluster = [];
  let clusterEnd = -1;

  for (const ev of sorted) {
    const s = toMinutes(ev.start);
    const e = toMinutes(ev.end);
    if (currentCluster.length && s >= clusterEnd) {
      clusters.push(currentCluster);
      currentCluster = [];
      clusterEnd = -1;
    }
    currentCluster.push(ev);
    clusterEnd = Math.max(clusterEnd, e);
  }
  if (currentCluster.length) clusters.push(currentCluster);

  const result = new Map();
  for (const cluster of clusters) {
    const colEnds = [];
    const placement = [];
    for (const ev of cluster) {
      const s = toMinutes(ev.start);
      const e = toMinutes(ev.end);
      let col = colEnds.findIndex((end) => end <= s);
      if (col < 0) {
        col = colEnds.length;
        colEnds.push(e);
      } else {
        colEnds[col] = e;
      }
      placement.push({ ev, col });
    }
    const totalCols = colEnds.length;
    for (const { ev, col } of placement) {
      result.set(ev.id, { col, totalCols, overlaps: totalCols > 1 });
    }
  }
  return result;
}

function renderTimeColumn(gridStartMin, gridEndMin) {
  const col = node('aside', 'time-col');
  col.setAttribute('aria-hidden', 'true');

  const head = node('div', 'time-head');
  head.innerHTML = '<i class="ph ph-clock"></i><span>Godz.</span>';
  col.append(head);

  const totalSlots = (gridEndMin - gridStartMin) / SLOT_MINUTES;
  const slots = node('div', 'time-slots');
  slots.style.height = `${totalSlots * SLOT_HEIGHT_PX}px`;

  let slotIndex = 0;
  for (let m = gridStartMin; m < gridEndMin; m += SLOT_MINUTES, slotIndex++) {
    const isFullHour = m % 60 === 0;
    const isQuarter = m % 15 === 0;
    const label = isFullHour ? fromMinutes(m) : `:${String(m % 60).padStart(2, '0')}`;
    const slotClass = isFullHour
      ? 'time-slot hour'
      : isQuarter
        ? 'time-slot quarter'
        : 'time-slot five';
    const slotEl = node('div', slotClass, label);
    slotEl.style.top = `${slotIndex * SLOT_HEIGHT_PX}px`;
    slotEl.style.height = `${SLOT_HEIGHT_PX}px`;
    slots.append(slotEl);
  }

  col.append(slots);
  return col;
}

/**
 * Buduje szablon linii 5-minutowych dla kolumny dnia oparty na rzeczywistych
 * obramowaniach CSS (border-top) i identycznych współrzędnych top jak kolumna
 * godzin — dzięki temu przy skalowaniu przeglądarki (np. 90%, 80%, 110%) linie
 * nigdy nie znikają ani nie rozjeżdżają się względem osi godzin i bloków zajęć.
 */
function buildTimelineGridTemplate(gridStartMin, gridEndMin) {
  const grid = node('div', 'timeline-grid');
  grid.setAttribute('aria-hidden', 'true');

  let slotIndex = 0;
  for (let m = gridStartMin; m < gridEndMin; m += SLOT_MINUTES, slotIndex++) {
    const isFullHour = m % 60 === 0;
    const isQuarter = m % 15 === 0;
    const slotClass = isFullHour
      ? 'timeline-slot hour'
      : isQuarter
        ? 'timeline-slot quarter'
        : 'timeline-slot five';
    const row = node('div', slotClass);
    row.style.top = `${slotIndex * SLOT_HEIGHT_PX}px`;
    row.style.height = `${SLOT_HEIGHT_PX}px`;
    grid.append(row);
  }

  return grid;
}

function renderMobileDayTabs(weekEvents, specialDayMap) {
  const nav = $('mobileDayTabs');
  nav.replaceChildren();

  for (let i = 0; i < 7; i++) {
    const date = addDays(week, i);
    const dayEvs = weekEvents.filter((e) => e.date === date);
    const effectiveSpecial = specialDayMap.get(date) || holidayFor(date, state.plan.academicYear);
    const isHoliday = effectiveSpecial?.type === 'holiday';

    let cls = 'mobile-day-tab';
    if (i === selectedDayIndex) cls += ' active';
    if (date === today()) cls += ' is-today';
    if (isHoliday) cls += ' is-holiday';

    const btn = node('button', cls);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(i === selectedDayIndex));

    const code = node('span', 'tab-code', MOBILE_DAY_CODES[i]);
    const num = node('span', 'tab-num', date.slice(8));
    const dot = node('span', dayEvs.length ? 'tab-dot has-events' : 'tab-dot');
    btn.append(code, num, dot);

    btn.onclick = () => {
      selectedDayIndex = i;
      render();
    };
    nav.append(btn);
  }
}

function render() {
  const weekEnd = addDays(week, 6);
  $('weekTitle').textContent = `${formatDate(week)} – ${formatDate(weekEnd)} ${week.slice(0, 4)}`;
  $('jump').value = addDays(week, selectedDayIndex);

  const events = state.plan.events.filter((e) => e.date >= week && e.date <= weekEnd);
  const minutes = events.reduce((sum, e) => sum + toMinutes(e.end) - toMinutes(e.start), 0);

  const specialDays = state.plan.academicYear?.specialDays || [];
  const specialDayMap = new Map(specialDays.map((sd) => [sd.date, sd]));

  let weekHasSpecialDay = false;
  let totalGapCount = 0;
  let totalGapMinutes = 0;
  const weekSpecialDays = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(week, i);
    const eff = specialDayMap.get(d) || holidayFor(d, state.plan.academicYear);
    if (eff) {
      weekHasSpecialDay = true;
      weekSpecialDays.push(eff);
    }
    const dayEvs = events.filter((e) => e.date === d);
    for (const g of computeGaps(dayEvs)) {
      totalGapCount++;
      totalGapMinutes += g.durationMin;
    }
  }

  const gapSummary =
    totalGapCount > 0 ? ` · Okienka: ${totalGapCount} (${formatDuration(totalGapMinutes)})` : '';
  $('summary').textContent =
    `Liczba spotkań: ${events.length} · Łącznie zajęć: ${formatDuration(minutes)}${gapSummary}`;

  renderMobileDayTabs(events, specialDayMap);

  const { startMin, endMin } = getGridBounds(events, weekSpecialDays);
  const gridTemplate = buildTimelineGridTemplate(startMin, endMin);

  const calendar = $('calendar');
  calendar.classList.toggle('has-special-days', weekHasSpecialDay);
  calendar.replaceChildren();
  calendar.append(renderTimeColumn(startMin, endMin));

  for (let i = 0; i < 7; i++) {
    const date = addDays(week, i);
    const effectiveSpecial = specialDayMap.get(date) || holidayFor(date, state.plan.academicYear);
    const dayEl = renderDay(date, DAY_NAMES[i], events, effectiveSpecial, startMin, endMin, gridTemplate);
    if (i === selectedDayIndex) dayEl.classList.add('mobile-active');
    calendar.append(dayEl);
  }
}

function renderDay(date, dayName, weekEvents, specialDay, gridStartMin, gridEndMin, gridTemplate) {
  const isHoliday = specialDay?.type === 'holiday';
  const isSwap = specialDay?.type === 'swap';
  const isRector = specialDay?.type === 'rector';
  const canAddInDay = editMode;

  let dayClass = 'day';
  if (date === today()) dayClass += ' today';
  if (isHoliday) dayClass += ' holiday';
  if (isRector) dayClass += ' rector-day';

  const day = node('section', dayClass);

  const topWrap = node('div', 'day-top');
  const head = node('div', canAddInDay ? 'dayhead editable' : 'dayhead');
  const headInfo = node('div', 'dayhead-info');
  headInfo.append(node('span', '', dayName), node('strong', '', date.slice(8)));
  head.append(headInfo);

  if (canAddInDay) {
    head.title = isHoliday
      ? `Dzień wolny (${date}) — kliknij, aby dodać wydarzenie własne (poza przedmiotem)`
      : `Kliknij, aby dodać zajęcia w dniu ${date} (${dayName})`;
    head.onclick = () => openEventDialog(null, date);

    const addHint = node('span', 'dayhead-add');
    addHint.innerHTML = '<i class="ph ph-plus"></i>';
    addHint.title = isHoliday ? 'Dodaj wydarzenie własne' : 'Dodaj zajęcia w tym dniu';
    head.append(addHint);
  }

  topWrap.append(head);

  // Oznaczenie dnia specjalnego (święto, weekend, godziny rektorskie lub plan z innego dnia)
  if (specialDay) {
    const badge = node('div', `special-day-badge ${specialDay.type}`);
    if (isHoliday) {
      badge.innerHTML = `<i class="ph ph-sun-horizon"></i> `;
      badge.append(document.createTextNode(specialDay.label || 'Dzień wolny'));
    } else if (isSwap) {
      const targetName = DAY_KEY_NAMES[specialDay.targetDay] || specialDay.targetDay;
      const labelSuffix = specialDay.label ? ` · ${specialDay.label}` : '';
      badge.innerHTML = `<i class="ph ph-arrows-clockwise"></i> `;
      badge.append(document.createTextNode(`Plan z ${targetName}${labelSuffix}`));
    } else if (isRector) {
      const hoursPart =
        specialDay.start && specialDay.end
          ? `Rektorskie ${specialDay.start}–${specialDay.end}`
          : 'Dzień rektorski';
      const labelSuffix = specialDay.label ? ` · ${specialDay.label}` : '';
      badge.innerHTML = `<i class="ph ph-graduation-cap"></i> `;
      badge.append(document.createTextNode(`${hoursPart}${labelSuffix}`));
    }
    badge.onclick = () => openAcademicYearDialog();
    badge.title = 'Kliknij, aby zarządzać strukturą roku';
    topWrap.append(badge);
  }

  day.append(topWrap);

  const dayEvents = weekEvents
    .filter((e) => e.date === date)
    .sort((a, b) => a.start.localeCompare(b.start));

  const rectorImpact = isRector ? describeRectorImpact(dayEvents, specialDay) : null;

  const totalSlots = (gridEndMin - gridStartMin) / SLOT_MINUTES;
  let timelineClass = canAddInDay ? 'day-timeline editable' : 'day-timeline';
  if (rectorImpact?.fullDayFree) timelineClass += ' rector-full-free';
  const timeline = node('div', timelineClass);
  timeline.style.height = `${totalSlots * SLOT_HEIGHT_PX}px`;
  if (gridTemplate) {
    timeline.append(gridTemplate.cloneNode(true));
  }

  if (canAddInDay) {
    timeline.title = isHoliday
      ? 'Kliknij w wiersz godziny, aby dodać wydarzenie własne o tej porze'
      : 'Kliknij w wiersz godziny, aby dodać zajęcia o tej porze';
    timeline.onclick = (e) => {
      if (e.target !== timeline) return;
      const slotIndex = Math.max(0, Math.min(totalSlots - 2, Math.floor(e.offsetY / SLOT_HEIGHT_PX)));
      const clickedMin = gridStartMin + slotIndex * SLOT_MINUTES;
      openEventDialog(null, date, fromMinutes(clickedMin));
    };
  }

  // Renderowanie okienek między zajęciami (z odstępem od sąsiadujących bloków zajęć)
  const GAP_INSET_PX = 3;
  for (const gap of computeGaps(dayEvents)) {
    const topPx = ((gap.startMin - gridStartMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX + GAP_INSET_PX;
    const heightPx = Math.max(
      SLOT_HEIGHT_PX - GAP_INSET_PX * 2,
      (gap.durationMin / SLOT_MINUTES) * SLOT_HEIGHT_PX - GAP_INSET_PX * 2,
    );
    let gapClass = 'gap-block';
    if (
      isRector &&
      (rectorImpact?.fullDayFree ||
        (specialDay.start &&
          specialDay.end &&
          gap.startMin < toMinutes(specialDay.end) &&
          gap.endMin > toMinutes(specialDay.start)))
    ) {
      gapClass += ' cancelled-by-rector';
    }
    const gapEl = node('div', gapClass);
    gapEl.style.top = `${topPx}px`;
    gapEl.style.height = `${heightPx}px`;

    const title = node('span', 'gap-title');
    title.innerHTML = '<i class="ph ph-hourglass-low"></i> ';
    title.append(document.createTextNode(`Okienko · ${formatDuration(gap.durationMin)}`));
    gapEl.append(title);

    if (gap.durationMin >= 10) {
      gapEl.append(node('span', 'gap-time', `${fromMinutes(gap.startMin)} – ${fromMinutes(gap.endMin)}`));
    }
    timeline.append(gapEl);
  }

  const layoutMap = layoutDayEvents(dayEvents);
  for (const event of dayEvents) {
    timeline.append(renderEvent(event, layoutMap.get(event.id), gridStartMin, specialDay));
  }

  // Nakładka godzin / dnia rektorskiego
  if (isRector && rectorImpact) {
    const overlay = node(
      'div',
      rectorImpact.fullDayFree ? 'rector-overlay full-day' : 'rector-overlay partial-day',
    );
    if (!rectorImpact.fullDayFree && specialDay.start && specialDay.end) {
      const rStart = Math.max(gridStartMin, toMinutes(specialDay.start));
      const rEnd = Math.min(gridEndMin, toMinutes(specialDay.end));
      const topPx = ((rStart - gridStartMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX;
      const heightPx = Math.max(SLOT_HEIGHT_PX * 2, ((rEnd - rStart) / SLOT_MINUTES) * SLOT_HEIGHT_PX);
      overlay.style.top = `${topPx}px`;
      overlay.style.height = `${heightPx}px`;
    }

    const card = node('div', 'rector-overlay-card');
    const titleEl = node('div', 'rector-overlay-title');
    titleEl.innerHTML = '<i class="ph ph-graduation-cap"></i> ';
    titleEl.append(document.createTextNode(rectorImpact.title));
    card.append(titleEl);

    const metaText = specialDay.label
      ? `${rectorImpact.hoursLabel} · ${specialDay.label}`
      : rectorImpact.hoursLabel;
    card.append(node('div', 'rector-overlay-meta', metaText));
    card.append(node('div', 'rector-overlay-free', rectorImpact.freeSummary));

    overlay.append(card);
    timeline.append(overlay);
  }

  if (!dayEvents.length && !isRector) {
    if (editMode) {
      const emptyBtn = node('button', 'day-empty-btn');
      emptyBtn.type = 'button';
      emptyBtn.innerHTML = isHoliday
        ? '<i class="ph ph-plus-circle"></i> Dodaj wydarzenie własne'
        : '<i class="ph ph-plus-circle"></i> Dodaj zajęcia';
      emptyBtn.onclick = () => openEventDialog(null, date);
      timeline.append(emptyBtn);
    } else if (isHoliday) {
      const emptyHoliday = node('div', 'day-empty-overlay');
      emptyHoliday.innerHTML = '<i class="ph ph-sun-horizon"></i> Dzień wolny od zajęć';
      timeline.append(emptyHoliday);
    } else {
      const emptyNormal = node('div', 'day-empty-overlay', 'Brak zajęć');
      timeline.append(emptyNormal);
    }
  }

  day.append(timeline);
  return day;
}

const CUSTOM_SUBJECT_VALUE = '__custom__';
const DEFAULT_CUSTOM_COLOR = '#b87d3b';

function getEventDisplay(event) {
  if (event.subjectId) {
    const subject = state.plan.subjects.find((s) => s.id === event.subjectId);
    return {
      title: subject?.name || 'Przedmiot',
      color: subject?.color || '#397d70',
      isCustom: false,
      subject: subject || null,
    };
  }
  return {
    title: event.customTitle || 'Wydarzenie',
    color: event.customColor || DEFAULT_CUSTOM_COLOR,
    isCustom: true,
    subject: null,
  };
}

function getEventTypeVisual(typeStr, isCustom = false) {
  const t = (typeStr || '').toLowerCase();
  if (t.includes('wykład') || t.includes('wyklad')) {
    return { variant: 'type-lecture', icon: 'ph-chalkboard-teacher' };
  }
  if (t.includes('lab')) {
    return { variant: 'type-lab', icon: 'ph-flask' };
  }
  if (t.includes('projekt')) {
    return { variant: 'type-project', icon: 'ph-kanban' };
  }
  if (t.includes('ćwicz') || t.includes('cwicz') || t.includes('lektorat') || t.includes('wf')) {
    return { variant: 'type-exercise', icon: 'ph-pencil-line' };
  }
  if (t.includes('seminarium')) {
    return { variant: 'type-seminar', icon: 'ph-chats-circle' };
  }
  if (t.includes('egzamin') || t.includes('kolokwium') || t.includes('zaliczenie')) {
    return { variant: 'type-exam', icon: 'ph-warning-octagon' };
  }
  if (t.includes('konsultac') || t.includes('promotor') || t.includes('spotkanie')) {
    return { variant: 'type-consult', icon: 'ph-user-focus' };
  }
  if (t.includes('odrabianie')) {
    return { variant: 'type-makeup', icon: 'ph-clock-clockwise' };
  }
  if (t.includes('lekarz') || t.includes('dentyst') || t.includes('prywatn') || t.includes('badani')) {
    return { variant: 'type-other', icon: 'ph-first-aid-kit' };
  }
  if (t.includes('warsztat') || t.includes('szkoleni') || t.includes('kurs') || t.includes('trening')) {
    return { variant: 'type-exercise', icon: 'ph-wrench' };
  }
  if (t.includes('obrona') || t.includes('dyplom')) {
    return { variant: 'type-lecture', icon: 'ph-graduation-cap' };
  }
  if (t.includes('koło') || t.includes('kolo') || t.includes('zebranie') || t.includes('rada')) {
    return { variant: 'type-consult', icon: 'ph-users-three' };
  }
  return {
    variant: 'type-other',
    icon: isCustom ? 'ph-calendar-star' : 'ph-tag',
  };
}

function renderEvent(event, layout, gridStartMin, specialDay = null) {
  const { title, color, isCustom } = getEventDisplay(event);
  const typeVisual = getEventTypeVisual(event.type, isCustom);
  const startMin = toMinutes(event.start);
  const endMin = toMinutes(event.end);
  const durationMin = Math.max(SLOT_MINUTES, endMin - startMin);
  const cancelledByRector = isEventCancelledByRector(event, specialDay);

  const EVENT_INSET_PX = 1;
  const topPx = ((startMin - gridStartMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX + EVENT_INSET_PX;
  const heightPx = Math.max(
    SLOT_HEIGHT_PX - EVENT_INSET_PX * 2,
    (durationMin / SLOT_MINUTES) * SLOT_HEIGHT_PX - EVENT_INSET_PX * 2,
  );

  let className = `event ${typeVisual.variant}`;
  if (event.remote) className += ' remote';
  if (isCustom) className += ' custom-event';
  if (cancelledByRector) className += ' cancelled-by-rector';
  if (durationMin < 20) className += ' compact';

  const button = node('button', className);
  button.type = 'button';
  button.style.setProperty('--event-color', color);
  button.style.top = `${topPx}px`;
  button.style.height = `${heightPx}px`;

  const { col = 0, totalCols = 1, overlaps = false } = layout || {};
  const widthPct = 100 / totalCols;
  const leftPct = col * widthPct;
  button.style.left = `calc(${leftPct}% + 3px)`;
  button.style.width = `calc(${widthPct}% - 6px)`;

  const topRow = node('div', 'event-top-row');
  topRow.append(node('span', 'time', `${event.start} – ${event.end}`));

  if (cancelledByRector) {
    const rectorTag = node('span', 'rector-tag');
    rectorTag.innerHTML = '<i class="ph ph-graduation-cap"></i><span>Odwołane</span>';
    topRow.append(rectorTag);
  }
  if (isCustom) {
    const customTag = node('span', 'custom-tag');
    customTag.innerHTML = '<i class="ph ph-star-four"></i><span>Własne</span>';
    topRow.append(customTag);
  }
  if (event.remote) {
    const remoteTag = node('span', 'remote-tag');
    remoteTag.innerHTML = '<i class="ph ph-laptop"></i><span>Zdalnie</span>';
    topRow.append(remoteTag);
  }

  const typeTag = node('span', `type-tag ${typeVisual.variant}`);
  typeTag.innerHTML = `<i class="ph ${typeVisual.icon}"></i>`;
  typeTag.append(node('span', '', event.type));

  button.append(topRow, node('span', 'name', title), typeTag);

  if (event.room || event.teacher) {
    button.append(node('span', 'meta', [event.room, event.teacher].filter(Boolean).join(' · ')));
  }

  if (overlaps) button.append(node('span', 'meta', '⚠ Nakładające się godziny'));

  if (event.notes) button.append(node('span', 'meta', event.notes));

  button.onclick = (e) => {
    e.stopPropagation();
    if (editMode) {
      openEventDialog(event.id);
    } else {
      openEventDetailsDialog(event.id);
    }
  };
  return button;
}

// --- Szczegóły zajęć (w trybie przeglądania) ---------------------------------

function openEventDetailsDialog(id) {
  const event = state.plan.events.find((e) => e.id === id);
  if (!event) return;
  const { title, color, isCustom, subject } = getEventDisplay(event);
  const typeVisual = getEventTypeVisual(event.type, isCustom);

  detailsEventId = event.id;

  $('detailsColorDot').style.background = color;
  $('detailsSubjectName').textContent = title;
  $('detailsType').innerHTML = `<i class="ph ${typeVisual.icon}"></i> `;
  $('detailsType').append(document.createTextNode(event.type));
  $('detailsCustom').hidden = !isCustom;
  $('detailsRemote').hidden = !event.remote;
  $('detailsDate').textContent = formatFullDate(event.date);
  $('detailsTime').textContent = `${event.start} – ${event.end} (${formatDuration(toMinutes(event.end) - toMinutes(event.start))})`;

  $('detailsRoom').textContent = event.room || 'Nie podano';
  $('detailsTeacher').textContent = event.teacher || 'Nie podano';
  $('detailsRoomRow').hidden = isCustom && !event.room;
  $('detailsTeacherRow').hidden = isCustom && !event.teacher;

  const hasNotes = !!event.notes?.trim();
  $('detailsNotesSection').hidden = !hasNotes;
  $('detailsNotes').textContent = event.notes || '';

  if (isCustom || !subject) {
    $('detailsSubjectSection').hidden = true;
    $('detailsEditSubjectBtn').hidden = true;
  } else {
    $('detailsEditSubjectBtn').hidden = false;
    $('detailsSubjectSection').hidden = !setSubjectDetailsContent(subject.details);
  }

  $('eventDetailsDialog').showModal();
}

function setSubjectDetailsContent(details) {
  const text = (details || '').trim();
  $('detailsSubjectInfo').textContent = text || 'Brak opisu przedmiotu. Możesz go dodać przyciskiem „Edytuj opis przedmiotu”.';
  return true;
}

// --- Przedmioty --------------------------------------------------------------

function fillSubjectForm(subject) {
  $('subjectId').value = subject.id;
  $('subjectName').value = subject.name;
  $('subjectColor').value = subject.color;
  $('subjectDetails').value = subject.details || '';
  $('subjectError').textContent = '';
}

function renderSubjectList() {
  const list = $('subjectList');
  list.replaceChildren();

  for (const subject of state.plan.subjects) {
    const row = node('div', 'subjectrow');

    const info = node('div', 'subjectrow-info');
    const nameRow = node('div', 'subjectrow-name');
    const dot = node('span', 'color-dot');
    dot.style.background = subject.color;
    nameRow.append(dot, node('span', '', subject.name));
    info.append(nameRow);

    if (subject.details) {
      info.append(node('div', 'subjectrow-details', subject.details));
    }

    const editButton = node('button', '', 'Edytuj');
    editButton.type = 'button';
    const deleteButton = node('button', 'danger', 'Usuń');
    deleteButton.type = 'button';

    editButton.onclick = () => fillSubjectForm(subject);
    deleteButton.onclick = () => deleteSubject(subject);

    row.append(info, editButton, deleteButton);
    list.append(row);
  }
}

function openSubjectDialog(message = '', subjectToEdit = null) {
  renderSubjectList();
  resetSubjectForm();
  if (subjectToEdit) fillSubjectForm(subjectToEdit);
  $('subjectError').textContent = message;
  $('subjectDialog').showModal();
}

function resetSubjectForm() {
  $('subjectForm').reset();
  $('subjectId').value = '';
  $('subjectDetails').value = '';
}

function deleteSubject(subject) {
  try {
    const subjectEventsCount = state.plan.events.filter((e) => e.subjectId === subject.id).length;
    if (subjectEventsCount > 0) {
      if (
        !confirm(
          `Przedmiot „${subject.name}” ma przypisane zajęcia (${subjectEventsCount} spotkań). Czy usunąć ten przedmiot razem ze wszystkimi jego zajęciami?`,
        )
      ) {
        return;
      }
    } else if (!confirm(`Usunąć przedmiot „${subject.name}”?`)) {
      return;
    }

    mutate((plan) => {
      plan.events = plan.events.filter((e) => e.subjectId !== subject.id);
      plan.subjects = plan.subjects.filter((s) => s.id !== subject.id);
    });
    resetSubjectForm();
    renderSubjectList();
  } catch (err) {
    $('subjectError').textContent = err.message;
  }
}

function saveSubject(event) {
  event.preventDefault();
  try {
    const name = $('subjectName').value.trim();
    const id = $('subjectId').value || uid();
    const color = $('subjectColor').value;
    const details = $('subjectDetails').value.trim();

    mutate((plan) => {
      const duplicate = plan.subjects.find(
        (s) => s.id !== id && s.name.toLocaleLowerCase('pl') === name.toLocaleLowerCase('pl'),
      );
      if (duplicate) throw Error('Taki przedmiot już istnieje. Dodaj do niego inny typ zajęć.');

      const subject = details ? { id, name, color, details } : { id, name, color };
      const index = plan.subjects.findIndex((s) => s.id === id);
      if (index < 0) plan.subjects.push(subject);
      else plan.subjects[index] = subject;
    });

    resetSubjectForm();
    $('subjectError').textContent = '';
    renderSubjectList();
  } catch (err) {
    $('subjectError').textContent = err.message;
  }
}

// --- Zajęcia -----------------------------------------------------------------

const EVENT_FIELDS = ['start', 'end', 'room', 'teacher', 'notes'];
const CUSTOM_TYPE_VALUE = '__custom__';

function setSelectedEventType(typeValue, isCustomEvent = false) {
  const select = $('typeSelect');
  const customInput = $('typeCustom');
  const val = (typeValue || (isCustomEvent ? 'Spotkanie' : 'Laboratorium')).trim();

  const matchingOption = Array.from(select.options).find(
    (opt) => opt.value !== CUSTOM_TYPE_VALUE && opt.value.toLowerCase() === val.toLowerCase(),
  );

  if (matchingOption) {
    select.value = matchingOption.value;
    customInput.value = '';
    customInput.hidden = true;
    customInput.required = false;
  } else {
    select.value = CUSTOM_TYPE_VALUE;
    customInput.value = val;
    customInput.hidden = false;
    customInput.required = true;
  }
}

function getSelectedEventType(isCustomEvent = false) {
  if ($('typeSelect').value === CUSTOM_TYPE_VALUE) {
    return $('typeCustom').value.trim() || (isCustomEvent ? 'Wydarzenie własne' : 'Laboratorium');
  }
  return $('typeSelect').value;
}

function updateTypeSelectFields() {
  const isCustomType = $('typeSelect').value === CUSTOM_TYPE_VALUE;
  const customInput = $('typeCustom');
  customInput.hidden = !isCustomType;
  customInput.required = isCustomType;
  if (isCustomType) {
    customInput.focus();
  }
}

function findDefaultNonHolidayDate(preferredDate) {
  if (!holidayFor(preferredDate, state.plan.academicYear)) return preferredDate;
  for (let i = 0; i < 7; i++) {
    const candidate = addDays(week, i);
    if (!holidayFor(candidate, state.plan.academicYear)) return candidate;
  }
  return preferredDate;
}

function updateSubjectSelectionFields() {
  const isCustom = $('subject').value === CUSTOM_SUBJECT_VALUE;
  $('customEventFields').hidden = !isCustom;
  $('customTitle').required = isCustom;
  $('subjectHint').textContent = isCustom
    ? 'Wydarzenie poza przedmiotem (np. spotkanie z promotorem, wizyta u lekarza). Sala, osoba i czas zakończenia są opcjonalne (domyślny czas trwania: 1 godzina).'
    : 'Nowy przedmiot oraz jego opis dodasz w przycisku „Przedmioty”.';

  $('startLabelText').textContent = isCustom ? 'Od (domyślnie 12:00)' : 'Od';
  $('endLabelText').textContent = isCustom ? 'Do (opcjonalnie, domyślnie +1 godz.)' : 'Do';
  $('roomLabelText').textContent = isCustom ? 'Miejsce / Sala (opcjonalnie)' : 'Sala (opcjonalnie)';
  $('teacherLabelText').textContent = isCustom ? 'Osoba / Prowadzący (opcjonalnie)' : 'Prowadzący (opcjonalnie)';

  if (!editingId) {
    if (isCustom && $('typeSelect').value === 'Laboratorium') {
      setSelectedEventType('Spotkanie', true);
    } else if (!isCustom && $('typeSelect').value === 'Spotkanie') {
      setSelectedEventType('Laboratorium', false);
    }
    if (isCustom && $('start').value === '08:00' && $('end').value === '09:30') {
      $('end').value = '09:00';
    }
  }
}

function openEventDialog(id, initialDate = null, initialStart = null) {
  if (busy) return;

  editingId = id || null;
  const event = state.plan.events.find((e) => e.id === id);

  $('eventForm').reset();
  $('eventError').textContent = '';

  const select = $('subject');
  select.replaceChildren();
  for (const subject of state.plan.subjects) {
    const option = node('option', '', subject.name);
    option.value = subject.id;
    select.append(option);
  }
  const customOption = node(
    'option',
    '',
    '★ Wydarzenie własne / poza przedmiotem (np. promotor, dentysta)',
  );
  customOption.value = CUSTOM_SUBJECT_VALUE;
  select.append(customOption);

  $('eventTitle').textContent = event ? 'Edytuj zajęcia / wydarzenie' : 'Dodaj zajęcia lub wydarzenie';
  $('repeatFields').hidden = !!event;
  $('scopeLabel').hidden = !event;
  $('deleteEvent').hidden = !event;
  $('untilLabel').hidden = true;
  $('manualLabel').hidden = true;
  $('applyAcademicYearLabel').hidden = true;
  $('until').required = false;

  const t = today();
  const todayInWeek = t >= week && t <= addDays(week, 6);
  const fallbackDate = findDefaultNonHolidayDate(todayInWeek ? t : week);
  const targetDate = event?.date || initialDate || fallbackDate;
  $('date').value = targetDate;

  if (event) {
    for (const field of EVENT_FIELDS) $(field).value = event[field];
    setSelectedEventType(event.type, !event.subjectId);
    $('remote').checked = !!event.remote;
    if (event.subjectId) {
      select.value = event.subjectId;
      $('customTitle').value = '';
      $('customColor').value = DEFAULT_CUSTOM_COLOR;
    } else {
      select.value = CUSTOM_SUBJECT_VALUE;
      $('customTitle').value = event.customTitle || '';
      $('customColor').value = event.customColor || DEFAULT_CUSTOM_COLOR;
    }
    $('scope').value = 'one';
  } else {
    $('remote').checked = false;
    $('customTitle').value = '';
    $('customColor').value = DEFAULT_CUSTOM_COLOR;
    const isTargetHoliday = !!holidayFor(targetDate, state.plan.academicYear);
    const defaultToCustom = !state.plan.subjects.length || isTargetHoliday;
    if (defaultToCustom) {
      select.value = CUSTOM_SUBJECT_VALUE;
    }
    setSelectedEventType(defaultToCustom ? 'Spotkanie' : 'Laboratorium', defaultToCustom);
    const startVal = initialStart || (defaultToCustom ? '12:00' : '08:00');
    const defaultDurationMin = defaultToCustom ? 60 : 90;
    $('start').value = startVal;
    $('end').value = fromMinutes(Math.min(23 * 60 + 55, toMinutes(startVal) + defaultDurationMin));
  }

  updateSubjectSelectionFields();
  $('eventDialog').showModal();
}

function updateRepeatFields() {
  const mode = $('repeat').value;
  const repeating = mode === 'weekly' || mode === 'biweekly';
  $('untilLabel').hidden = !repeating;
  $('until').required = repeating;
  $('manualLabel').hidden = mode !== 'manual';
  $('applyAcademicYearLabel').hidden = !repeating;
}

function readEventForm() {
  const isCustom = $('subject').value === CUSTOM_SUBJECT_VALUE;
  const start = $('start').value.trim() || (isCustom ? '12:00' : '08:00');
  const defaultDuration = isCustom ? 60 : 90;
  const end =
    $('end').value.trim() ||
    fromMinutes(Math.min(23 * 60 + 55, toMinutes(start) + defaultDuration));

  const base = {
    subjectId: isCustom ? null : $('subject').value,
    type: getSelectedEventType(isCustom),
    date: $('date').value,
    start,
    end,
    room: $('room').value.trim(),
    teacher: $('teacher').value.trim(),
    notes: $('notes').value.trim(),
    remote: $('remote').checked,
  };
  if (isCustom) {
    base.customTitle = $('customTitle').value.trim();
    base.customColor = $('customColor').value;
  }
  return base;
}

/**
 * Czy zajęcia `e` należą do wybranego zakresu edycji/usuwania:
 *  - 'one'    → tylko to jedno spotkanie,
 *  - 'future' → to i wszystkie kolejne spotkania z tej samej serii,
 *  - 'all'    → cała seria (wszystkie tygodnie oraz dni przeniesione).
 */
function inScope(e, original, scope) {
  if (e.id === original.id) return true;
  if (scope === 'all') return e.seriesId === original.seriesId;
  if (scope === 'future') return e.seriesId === original.seriesId && e.date >= original.date;
  return false;
}

function saveEvent(submitEvent) {
  submitEvent.preventDefault();
  try {
    const values = readEventForm();
    if (values.end <= values.start) {
      throw Error('Godzina zakończenia musi być późniejsza niż rozpoczęcia.');
    }

    const applyAcademicYear = $('applyAcademicYear').checked;
    const isCustom = !values.subjectId;

    mutate((plan) => {
      if (editingId) {
        const original = plan.events.find((e) => e.id === editingId);
        const scope = $('scope').value;
        const shiftDays = Math.round((Date.parse(values.date) - Date.parse(original.date)) / 86_400_000);

        if (!isCustom && shiftDays !== 0) {
          const targetHoliday = holidayFor(values.date, plan.academicYear);
          if (targetHoliday) {
            const reason = targetHoliday.label ? ` (${targetHoliday.label})` : '';
            throw Error(
              `${values.date} to dzień wolny${reason}. W weekendy i dni wolne można dodawać wyłącznie wydarzenia własne (poza przedmiotem).`,
            );
          }
        }

        plan.events = plan.events.map((e) => {
          if (!inScope(e, original, scope)) return e;
          const nextDate = addDays(e.date, shiftDays);
          // Jeśli przesuwamy serię zajęć przedmiotu i któryś z docelowych dni jest dniem wolnym, pomijamy go
          if (!isCustom && shiftDays !== 0 && holidayFor(nextDate, plan.academicYear)) {
            return null;
          }
          const updated = { ...e, ...values, date: nextDate };
          if (values.subjectId) {
            delete updated.customTitle;
            delete updated.customColor;
          }
          return updated;
        }).filter(Boolean);
      } else {
        const repeatMode = $('repeat').value;
        // Blokada rozpoczęcia powtarzania lub pojedynczych zajęć przedmiotu w dniu wolnym lub w weekend
        if (!isCustom && applyAcademicYear) {
          const startHoliday = holidayFor(values.date, plan.academicYear);
          if (startHoliday) {
            const reason = startHoliday.label ? ` (${startHoliday.label})` : '';
            throw Error(
              `Wybrany dzień (${values.date}) jest ustawiony jako wolny${reason}. W weekendy i dni wolne można dodawać wyłącznie wydarzenia własne (poza przedmiotem).`,
            );
          }
        }

        const seriesId = uid();
        const dates = datesFor(
          values.date,
          $('until').value,
          repeatMode,
          $('manual').value,
          plan.academicYear,
          applyAcademicYear,
          isCustom,
        );
        for (const date of dates) {
          plan.events.push({ ...values, date, id: uid(), seriesId });
        }
      }
    });

    $('eventDialog').close();
  } catch (err) {
    $('eventError').textContent = err.message;
  }
}

function deleteEvent() {
  const scope = $('scope').value;
  let confirmMsg = 'Czy na pewno usunąć tylko to jedno spotkanie z planu?';
  if (scope === 'future') {
    confirmMsg = 'Czy na pewno usunąć to i wszystkie kolejne spotkania tej serii?';
  } else if (scope === 'all') {
    confirmMsg = 'Czy na pewno usunąć CAŁĄ serię zajęć (ze wszystkich tygodni oraz przeniesionych dni)?';
  }

  if (!confirm(confirmMsg)) return;

  try {
    mutate((plan) => {
      const original = plan.events.find((e) => e.id === editingId);
      plan.events = plan.events.filter((e) => !inScope(e, original, scope));
    });
    $('eventDialog').close();
  } catch (err) {
    $('eventError').textContent = err.message;
  }
}

// --- Masowe usuwanie serii i czyszczenie kalendarza --------------------------

function renderSeriesList() {
  const container = $('seriesList');
  container.replaceChildren();

  if (!state.plan.events.length) {
    container.append(node('p', 'hint', 'Kalendarz nie zawiera obecnie żadnych zajęć.'));
    return;
  }

  const groups = new Map();
  for (const e of state.plan.events) {
    if (!groups.has(e.seriesId)) groups.set(e.seriesId, []);
    groups.get(e.seriesId).push(e);
  }

  const subjectMap = new Map(state.plan.subjects.map((s) => [s.id, s]));

  for (const [seriesId, events] of groups) {
    events.sort((a, b) => a.date.localeCompare(b.date));
    const first = events[0];
    const last = events[events.length - 1];
    const { title: subjectName } = getEventDisplay(first);

    const row = node('div', 'seriesrow');
    const info = node('div', 'seriesrow-info');
    info.append(
      node('div', 'seriesrow-title', `${subjectName} · ${first.type} (${first.start}–${first.end})`),
      node(
        'div',
        'seriesrow-meta',
        events.length > 1
          ? `Spotkań: ${events.length} · Zakres: ${first.date} → ${last.date}`
          : `Pojedyncze spotkanie: ${first.date}`,
      ),
    );

    const delBtn = node('button', 'danger', events.length > 1 ? `Usuń serię (${events.length})` : 'Usuń');
    delBtn.type = 'button';
    delBtn.onclick = () => {
      if (
        !confirm(
          `Usunąć wszystkie spotkania z serii „${subjectName} (${first.type})” (${events.length} terminów, w tym przeniesione dni)?`,
        )
      ) {
        return;
      }
      mutate((plan) => {
        plan.events = plan.events.filter((e) => e.seriesId !== seriesId);
      });
      renderSeriesList();
    };

    row.append(info, delBtn);
    container.append(row);
  }
}

function openBulkDialog() {
  renderSeriesList();
  $('bulkDialog').showModal();
}

function runReconcile() {
  try {
    let summary = { removed: 0, added: 0 };
    mutate((plan) => {
      const res = reconcileWithAcademicYear(plan, uid);
      plan.events = res.events;
      summary = { removed: res.removed, added: res.added };
    });
    renderSeriesList();
    setStatus(
      `Przeliczono serie wg struktury roku: usunięto ${summary.removed} z dni wolnych/zamienionych, dodano ${summary.added} w dniach z zamianą planu.`,
    );
  } catch (err) {
    setStatus(err.message);
  }
}

function clearAllEvents() {
  if (!state.plan.events.length) {
    setStatus('Brak zajęć do usunięcia.');
    return;
  }
  if (
    !confirm(
      `Czy na pewno usunąć WSZYSTKIE zajęcia (${state.plan.events.length} spotkań) z kalendarza? Przedmioty oraz struktura roku zostaną zachowane.`,
    )
  ) {
    return;
  }

  mutate((plan) => {
    plan.events = [];
  });
  renderSeriesList();
  $('bulkDialog').close();
  setStatus('Usunięto wszystkie zajęcia. Kliknij „Zapisz w chmurze”, jeśli chcesz nadpisać również plan w chmurze.');
}

function clearEntireCalendar() {
  if (
    !confirm(
      'Czy na pewno wyczyścić CAŁY kalendarz do zera (wszystkie zajęcia, przedmioty oraz strukturę roku)? Tej operacji nie można cofnąć lokalnie bez kopii JSON.',
    )
  ) {
    return;
  }

  mutate((plan) => {
    Object.assign(plan, emptyPlan());
  });
  renderSeriesList();
  $('bulkDialog').close();
  setStatus('Kalendarz został całkowicie wyczyszczony do zera. Kliknij „Zapisz w chmurze”, aby nadpisać dane w chmurze.');
}

// --- Struktura roku akademickiego ------------------------------------------

function groupSpecialDays(specialDays) {
  const sorted = [...specialDays].sort((a, b) => a.date.localeCompare(b.date));
  const groups = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];

    if (current.type === 'holiday') {
      let j = i;
      while (
        j + 1 < sorted.length &&
        sorted[j + 1].type === 'holiday' &&
        (sorted[j + 1].label || '') === (current.label || '') &&
        sorted[j + 1].date === addDays(sorted[j].date, 1)
      ) {
        j++;
      }

      if (j > i) {
        groups.push({
          type: 'holiday',
          label: current.label,
          startDate: current.date,
          endDate: sorted[j].date,
          count: j - i + 1,
          dates: sorted.slice(i, j + 1).map((x) => x.date),
        });
        i = j;
        continue;
      }
    }

    groups.push({
      type: current.type,
      label: current.label,
      targetDay: current.targetDay,
      start: current.start,
      end: current.end,
      startDate: current.date,
      endDate: current.date,
      count: 1,
      dates: [current.date],
    });
  }

  return groups;
}

function renderSpecialDaysList() {
  const container = $('specialDayList');
  container.replaceChildren();

  const specialDays = state.plan.academicYear?.specialDays || [];

  if (!specialDays.length) {
    container.append(
      node('p', 'hint', 'Brak zdefiniowanych dni wolnych, przerw i godzin rektorskich. Dodaj je poniżej.'),
    );
    return;
  }

  const groups = groupSpecialDays(specialDays);

  for (const group of groups) {
    const row = node('div', 'specialdayrow');
    const info = node('div', 'specialdayrow-info');

    const dateLine = node('div', 'specialdayrow-date');
    const isRange = group.count > 1;
    let badgeText = 'Zamiana';
    if (group.type === 'holiday') {
      badgeText = isRange ? `Przerwa (${group.count} dni)` : 'Wolne';
    } else if (group.type === 'rector') {
      badgeText = group.start && group.end ? `Rektorskie ${group.start}–${group.end}` : 'Dzień rektorski';
    }
    const badge = node('span', `badge ${group.type}`, badgeText);

    const dateRangeStr = isRange ? `${group.startDate} → ${group.endDate}` : group.startDate;
    dateLine.append(node('span', '', dateRangeStr), badge);

    let descText = group.label || (group.type === 'holiday' ? (isRange ? 'Przerwa świąteczna / wolna' : 'Dzień wolny') : '');
    if (group.type === 'swap') {
      const targetName = DAY_KEY_NAMES[group.targetDay] || group.targetDay;
      const swapDesc = `Zajęcia według planu z ${targetName}`;
      descText = descText ? `${swapDesc} (${descText})` : swapDesc;
    } else if (group.type === 'rector') {
      const rectorDesc =
        group.start && group.end
          ? `Godziny rektorskie ${group.start} – ${group.end} (nakładka na plan)`
          : 'Dzień rektorski — cały dzień (nakładka na plan)';
      descText = group.label ? `${rectorDesc} · ${group.label}` : rectorDesc;
    }
    const desc = node('div', 'specialdayrow-desc', descText);

    info.append(dateLine, desc);

    const deleteBtn = node('button', 'danger', 'Usuń');
    deleteBtn.type = 'button';
    deleteBtn.onclick = () => deleteSpecialDays(group.dates);

    row.append(info, deleteBtn);
    container.append(row);
  }
}

function openAcademicYearDialog() {
  renderSpecialDaysList();
  $('academicYearError').textContent = '';
  $('specialDayDate').value = today();
  $('specialDayDateEnd').value = addDays(today(), 7);
  $('specialDayLabel').value = '';
  $('specialDayType').value = 'holiday_range';
  $('rectorFullDay').checked = false;
  $('rectorStart').value = '10:00';
  $('rectorEnd').value = '14:00';
  updateSpecialDayTypeFields();
  $('academicYearDialog').showModal();
}

function updateSpecialDayTypeFields() {
  const type = $('specialDayType').value;
  const isSwap = type === 'swap';
  const isRange = type === 'holiday_range';
  const isRector = type === 'rector';
  const fullDayRector = $('rectorFullDay').checked;

  $('swapTargetContainer').hidden = !isSwap;
  $('dateEndContainer').hidden = !isRange;
  $('specialDayDateEnd').required = isRange;
  $('rectorHoursContainer').hidden = !isRector;
  $('rectorTimePair').hidden = !isRector || fullDayRector;
  $('rectorStart').required = isRector && !fullDayRector;
  $('rectorEnd').required = isRector && !fullDayRector;

  const dateLabel = $('specialDayDateLabel');
  if (isRange) {
    dateLabel.childNodes[0].textContent = 'Data od: ';
  } else {
    dateLabel.childNodes[0].textContent = 'Data: ';
  }
}

function deleteSpecialDays(datesToDelete) {
  try {
    const toRemove = new Set(datesToDelete);
    mutate((plan) => {
      if (!plan.academicYear) plan.academicYear = { specialDays: [] };
      plan.academicYear.specialDays = plan.academicYear.specialDays.filter((sd) => !toRemove.has(sd.date));
    });
    renderSpecialDaysList();
  } catch (err) {
    $('academicYearError').textContent = err.message;
  }
}

function saveSpecialDay(event) {
  event.preventDefault();
  try {
    const type = $('specialDayType').value;
    const startDate = $('specialDayDate').value;
    const endDate = $('specialDayDateEnd').value;
    const label = $('specialDayLabel').value.trim();
    const targetDay = type === 'swap' ? $('specialDayTargetDay').value : undefined;
    const rectorFullDay = $('rectorFullDay').checked;
    const rectorStart = $('rectorStart').value;
    const rectorEnd = $('rectorEnd').value;

    if (type === 'rector' && !rectorFullDay) {
      if (!rectorStart || !rectorEnd || rectorEnd <= rectorStart) {
        throw Error('Godzina zakończenia godzin rektorskich musi być późniejsza niż godzina rozpoczęcia.');
      }
    }

    const datesToAdd = [];

    if (type === 'holiday_range') {
      if (!endDate || endDate < startDate) {
        throw Error('Data końcowa przerwy musi być późniejsza lub równa dacie początkowej.');
      }
      for (let cur = startDate; cur <= endDate; cur = addDays(cur, 1)) {
        if (datesToAdd.length >= 366) {
          throw Error('Przerwa nie może trwać dłużej niż 366 dni.');
        }
        datesToAdd.push(cur);
      }
    } else {
      datesToAdd.push(startDate);
    }

    mutate((plan) => {
      if (!plan.academicYear) plan.academicYear = { specialDays: [] };

      // Sprawdź, czy któryś dzień nie jest już zajęty
      const existingMap = new Map(plan.academicYear.specialDays.map((sd) => [sd.date, sd]));
      for (const d of datesToAdd) {
        if (existingMap.has(d)) {
          throw Error(`Dla dnia ${d} już istnieje wpis w strukturze roku. Najpierw go usuń.`);
        }
      }

      for (const d of datesToAdd) {
        if (type === 'rector') {
          const item = { date: d, type: 'rector', label };
          if (!rectorFullDay) {
            item.start = rectorStart;
            item.end = rectorEnd;
          }
          plan.academicYear.specialDays.push(item);
        } else {
          const item = { date: d, type: type === 'swap' ? 'swap' : 'holiday', label };
          if (type === 'swap') item.targetDay = targetDay;
          plan.academicYear.specialDays.push(item);
        }
      }

      // Automatycznie dopasuj istniejące serie cykliczne do zaktualizowanej struktury roku
      const reconciled = reconcileWithAcademicYear(plan, uid);
      plan.events = reconciled.events;
    });

    $('specialDayLabel').value = '';
    $('academicYearError').textContent = '';
    renderSpecialDaysList();
  } catch (err) {
    $('academicYearError').textContent = err.message;
  }
}

// --- Nawigacja po tygodniach -------------------------------------------------

function showWeek(newWeek) {
  week = newWeek;
  render();
}

// --- Import / eksport --------------------------------------------------------

function exportPlan() {
  const json = JSON.stringify(state.plan, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));

  const link = node('a');
  link.href = url;
  link.download = `plan-${today()}.json`;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importPlan() {
  const input = $('import');
  const file = input.files[0];
  try {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) throw Error('Maksymalny rozmiar pliku to 2 MB.');

    const plan = validatePlan(JSON.parse(await file.text()));
    if (!confirm('Zastąpić lokalny plan danymi z pliku? W razie potrzeby najpierw wyeksportuj obecną kopię.')) {
      return;
    }
    mutate((current) => Object.assign(current, plan));
  } catch (err) {
    setStatus(err instanceof SyntaxError ? 'Plik nie jest prawidłowym JSON-em.' : err.message);
  } finally {
    input.value = '';
  }
}

// --- Klucz dostępu i synchronizacja z chmurą ---------------------------------

function getActivePlanId() {
  try {
    return (localStorage.getItem(PLAN_ID_KEY) || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function updateConnectionButtonLabel() {
  const id = getActivePlanId();
  const btn = $('connection');
  btn.innerHTML = '<i class="ph ph-key"></i> ';
  btn.append(document.createTextNode(id ? `Chmura (${id})` : 'Klucz / ID planu'));
}

function openConnectionDialog() {
  try {
    $('planId').value = getActivePlanId();
    $('token').value = localStorage.getItem(TOKEN_KEY) || '';
    $('connectionError').textContent = '';
    $('connectionDialog').showModal();
  } catch (err) {
    setStatus(err.message);
  }
}

function saveConnection(event) {
  event.preventDefault();
  try {
    const rawPlanId = $('planId').value.trim().toLowerCase();
    // Walidacja formatu nazwy/ID planu
    resolvePlanKey(rawPlanId);

    const token = $('token').value.trim();
    if (token && token.length < MIN_TOKEN_LENGTH) {
      throw Error(`Klucz musi mieć minimum ${MIN_TOKEN_LENGTH} znaki.`);
    }

    const prevPlanId = getActivePlanId();
    if (rawPlanId) localStorage.setItem(PLAN_ID_KEY, rawPlanId);
    else localStorage.removeItem(PLAN_ID_KEY);

    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);

    if (rawPlanId !== prevPlanId) {
      const next = clone(state);
      next.etag = null;
      persist(next);
    }

    updateConnectionButtonLabel();
    $('connectionError').textContent = '';
    $('connectionDialog').close();
    const label = rawPlanId || 'domyślny';
    setStatus(`Zapisano ustawienia chmury (plan: ${label}). Możesz teraz pobrać lub zapisać plan w chmurze.`);
  } catch (err) {
    $('connectionError').textContent = err.message;
  }
}

function setButtonsDisabled(disabled) {
  for (const button of document.querySelectorAll('button')) button.disabled = disabled;
}

/** Wysyła żądanie do Workera. direction: 'pull' (GET) lub 'push' (PUT). */
async function callApi(direction, token, planId, overrideEtag = undefined) {
  const url = planId ? `${API_URL}?id=${encodeURIComponent(planId)}` : API_URL;
  const headers = { Authorization: 'Bearer ' + token };
  const options = { method: 'GET', headers, cache: 'no-store', signal: AbortSignal.timeout(API_TIMEOUT_MS) };

  if (direction === 'push') {
    options.method = 'PUT';
    options.body = JSON.stringify(state.plan);
    headers['Content-Type'] = 'application/json';
    const etagToUse = overrideEtag !== undefined ? overrideEtag : state.etag;
    if (etagToUse) headers['If-Match'] = `"${etagToUse}"`;
    else headers['If-None-Match'] = '*';
  }

  const response = await fetch(url, options);

  let data;
  try {
    data = await response.json();
  } catch {
    throw Error('API nie jest dostępne. Uruchom projekt przez npm run dev albo wdróż Worker.');
  }

  if (direction === 'push' && response.status === 409 && overrideEtag === undefined) {
    const label = planId || 'domyślny';
    if (
      confirm(
        `W chmurze dla planu „${label}” znajduje się już inna zapisana wersja. Czy chcesz ją nadpisać swoim obecnym planem lokalnym?`,
      )
    ) {
      const remote = await callApi('pull', token, planId);
      return callApi('push', token, planId, remote.etag);
    }
  }

  if (!response.ok) throw Error(data.error || 'Błąd połączenia.');
  return data;
}

async function sync(direction) {
  if (busy) return;
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      openConnectionDialog();
      return;
    }
    const planId = getActivePlanId();
    const label = planId || 'domyślny';

    if (
      direction === 'pull' &&
      state.dirty &&
      !confirm('Pobranie zastąpi niezapisane lokalne zmiany. Wyeksportuj je najpierw, jeśli chcesz je zachować. Kontynuować?')
    ) {
      return;
    }

    busy = true;
    setButtonsDisabled(true);
    setStatus(direction === 'pull' ? `Pobieranie planu (${label})…` : `Zapisywanie planu (${label})…`);

    const data = await callApi(direction, token, planId);

    const next = clone(state);
    if (direction === 'pull') next.plan = validatePlan(data.plan);
    next.etag = data.etag;
    next.dirty = false;
    persist(next);

    render();
    setStatus(`Zsynchronizowano plan „${label}” · ${new Date().toLocaleTimeString('pl-PL')}.`);
  } catch (err) {
    if (err.name === 'TimeoutError') {
      setStatus('Przekroczono czas połączenia. Lokalny plan pozostał bez zmian.');
    } else {
      setStatus(err.message + ' Lokalna kopia pozostaje dostępna.');
    }
  } finally {
    busy = false;
    setButtonsDisabled(false);
  }
}

// --- Podpięcie zdarzeń -------------------------------------------------------

function bindEvents() {
  $('menuToggle').onclick = () => {
    const isOpen = $('navPanel').classList.contains('open');
    setMobileMenuOpen(!isOpen);
  };
  $('editModeToggle').onclick = () => setEditMode(!editMode);
  $('addEvent').onclick = () => openEventDialog(null, addDays(week, selectedDayIndex));
  $('subject').onchange = updateSubjectSelectionFields;
  $('typeSelect').onchange = updateTypeSelectFields;
  $('start').onchange = () => {
    const startVal = $('start').value;
    if (!startVal) return;
    const isCustom = $('subject').value === CUSTOM_SUBJECT_VALUE;
    const endVal = $('end').value;
    if (!endVal || endVal <= startVal) {
      const duration = isCustom ? 60 : 90;
      $('end').value = fromMinutes(Math.min(23 * 60 + 55, toMinutes(startVal) + duration));
    }
  };
  $('eventForm').onsubmit = saveEvent;
  $('deleteEvent').onclick = deleteEvent;
  $('repeat').onchange = updateRepeatFields;

  $('detailsEditEventBtn').onclick = () => {
    const id = detailsEventId;
    $('eventDetailsDialog').close();
    if (id) openEventDialog(id);
  };

  $('detailsEditSubjectBtn').onclick = () => {
    const ev = state.plan.events.find((e) => e.id === detailsEventId);
    const subj = state.plan.subjects.find((s) => s.id === ev?.subjectId);
    $('eventDetailsDialog').close();
    openSubjectDialog('', subj || null);
  };

  $('subjects').onclick = () => {
    setMobileMenuOpen(false);
    openSubjectDialog();
  };
  $('subjectForm').onsubmit = saveSubject;
  $('newSubject').onclick = resetSubjectForm;

  $('bulkManageBtn').onclick = () => {
    setMobileMenuOpen(false);
    openBulkDialog();
  };
  $('reconcileBtn').onclick = runReconcile;
  $('clearEventsBtn').onclick = clearAllEvents;
  $('clearAllBtn').onclick = clearEntireCalendar;

  $('academicYearBtn').onclick = () => {
    setMobileMenuOpen(false);
    openAcademicYearDialog();
  };
  $('academicYearForm').onsubmit = saveSpecialDay;
  $('specialDayType').onchange = updateSpecialDayTypeFields;
  $('rectorFullDay').onchange = updateSpecialDayTypeFields;

  for (const button of document.querySelectorAll('[data-close]')) {
    button.onclick = () => button.closest('dialog').close();
  }

  $('prev').onclick = () => showWeek(addDays(week, -7));
  $('next').onclick = () => showWeek(addDays(week, 7));
  $('today').onclick = () => {
    const t = today();
    selectedDayIndex = weekdayIndex(t);
    showWeek(monday(t));
  };
  $('jump').onchange = () => {
    const val = $('jump').value;
    if (val) {
      selectedDayIndex = weekdayIndex(val);
      showWeek(monday(val));
    }
  };

  // Przełączanie dni gestem przesunięcia palcem (swipe lewo/prawo) na telefonie
  let touchStartX = null;
  let touchStartY = null;
  $('calendar').addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    },
    { passive: true },
  );
  $('calendar').addEventListener(
    'touchend',
    (e) => {
      if (touchStartX === null || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartX = null;
      touchStartY = null;

      if (window.innerWidth <= 768 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) {
          // Przesunięcie w lewo → następny dzień
          if (selectedDayIndex < 6) {
            selectedDayIndex++;
            render();
          } else {
            selectedDayIndex = 0;
            showWeek(addDays(week, 7));
          }
        } else {
          // Przesunięcie w prawo → poprzedni dzień
          if (selectedDayIndex > 0) {
            selectedDayIndex--;
            render();
          } else {
            selectedDayIndex = 6;
            showWeek(addDays(week, -7));
          }
        }
      }
    },
    { passive: true },
  );

  $('export').onclick = () => {
    setMobileMenuOpen(false);
    exportPlan();
  };
  $('importButton').onclick = () => {
    setMobileMenuOpen(false);
    $('import').click();
  };
  $('import').onchange = importPlan;

  $('connection').onclick = () => {
    setMobileMenuOpen(false);
    openConnectionDialog();
  };
  $('connectionForm').onsubmit = saveConnection;
  $('pull').onclick = () => sync('pull');
  $('push').onclick = () => sync('push');

  // Inna karta tej samej przeglądarki zmieniła dane — blokujemy edycję, żeby się nie nadpisywać.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY || e.key === null) {
      storageBlocked = true;
      setStatus('Inna karta zmieniła dane. Wyeksportuj swoją kopię i odśwież stronę przed dalszą edycją.');
    }
  });
}

// --- Start -------------------------------------------------------------------

loadFromStorage();
bindEvents();
updateConnectionButtonLabel();
setEditMode(false);
reportState();
