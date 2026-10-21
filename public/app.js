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
} from './model.js';

// --- Stałe i stan ------------------------------------------------------------

const STORAGE_KEY = 'student-calendar-v1';
const TOKEN_KEY = 'student-calendar-token';
const API_URL = '/api/plan'; // ten sam adres co frontend — Worker obsługuje oba
const API_TIMEOUT_MS = 20_000;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;
const DAY_NAMES = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Ndz'];

/** state.plan – dane planu, state.etag – wersja z chmury, state.dirty – niezsynchronizowane zmiany */
let state = { plan: emptyPlan(), etag: null, dirty: false };
let lastStored = null;       // ostatnia wartość zapisana przez tę kartę (wykrywanie innych kart)
let storageBlocked = false;  // localStorage niedostępny lub zmieniony przez inną kartę
let busy = false;            // trwa synchronizacja
let editMode = false;        // false = normalny tryb przeglądania, true = tryb edycji
let editingId = null;        // id edytowanych zajęć (null = nowe)
let detailsEventId = null;   // id zajęć aktualnie wyświetlanych w oknie szczegółów
let week = monday(today());  // poniedziałek wyświetlanego tygodnia

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
    ? '<i class="ph ph-pencil-simple-line"></i> Tryb edycji: Wł.'
    : '<i class="ph ph-pencil-simple"></i> Tryb edycji: Wył.';

  $('addEvent').hidden = !editMode;
  $('calendarHint').textContent = editMode
    ? 'Tryb edycji aktywny: kliknij nagłówek dnia lub pusty dzień (poza dniami wolnymi), aby dodać zajęcia. Kliknij istniejące zajęcia, aby je edytować lub usunąć.'
    : 'Kliknij zajęcia, aby zobaczyć szczegóły przedmiotu i spotkania. Włącz „Tryb edycji” u góry, aby dodawać lub zmieniać zajęcia w kalendarzu.';

  render();
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

// --- Widok tygodnia ----------------------------------------------------------

function render() {
  const weekEnd = addDays(week, 6);
  $('weekTitle').textContent = `${formatDate(week)} – ${formatDate(weekEnd)} ${week.slice(0, 4)}`;
  $('jump').value = week;

  const events = state.plan.events.filter((e) => e.date >= week && e.date <= weekEnd);
  const minutes = events.reduce((sum, e) => sum + toMinutes(e.end) - toMinutes(e.start), 0);
  $('summary').textContent =
    `Liczba spotkań: ${events.length} · Łącznie: ${Math.floor(minutes / 60)} godz. ${minutes % 60} min`;

  const specialDays = state.plan.academicYear?.specialDays || [];
  const specialDayMap = new Map(specialDays.map((sd) => [sd.date, sd]));

  const calendar = $('calendar');
  calendar.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const date = addDays(week, i);
    calendar.append(renderDay(date, DAY_NAMES[i], events, specialDayMap.get(date)));
  }
}

function renderDay(date, dayName, weekEvents, specialDay) {
  const isHoliday = specialDay?.type === 'holiday';
  const isSwap = specialDay?.type === 'swap';
  const canAddInDay = editMode && !isHoliday;

  let dayClass = 'day';
  if (date === today()) dayClass += ' today';
  if (isHoliday) dayClass += ' holiday';

  const day = node('section', dayClass);

  const head = node('div', canAddInDay ? 'dayhead editable' : 'dayhead');
  const headInfo = node('div', 'dayhead-info');
  headInfo.append(node('span', '', dayName), node('strong', '', date.slice(8)));
  head.append(headInfo);

  if (canAddInDay) {
    head.title = `Kliknij, aby dodać zajęcia w dniu ${date} (${dayName})`;
    head.onclick = () => openEventDialog(null, date);

    const addHint = node('span', 'dayhead-add');
    addHint.innerHTML = '<i class="ph ph-plus"></i>';
    addHint.title = 'Dodaj zajęcia w tym dniu';
    head.append(addHint);
  } else if (editMode && isHoliday) {
    head.title = 'Dzień wolny od zajęć — dodawanie zajęć zablokowane';
  }

  day.append(head);

  // Oznaczenie dnia specjalnego (święto lub plan z innego dnia)
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
    }
    badge.onclick = () => openAcademicYearDialog();
    badge.title = 'Kliknij, aby zarządzać strukturą roku';
    day.append(badge);
  }

  const list = node('div', 'events');
  const dayEvents = weekEvents
    .filter((e) => e.date === date)
    .sort((a, b) => a.start.localeCompare(b.start));

  for (const event of dayEvents) list.append(renderEvent(event, dayEvents));

  if (!dayEvents.length) {
    if (isHoliday) {
      const emptyHoliday = node('div', 'day-empty-state');
      emptyHoliday.innerHTML = '<i class="ph ph-sun-horizon"></i> Dzień wolny od zajęć';
      list.append(emptyHoliday);
    } else if (editMode) {
      const emptyBtn = node('button', 'day-empty-btn');
      emptyBtn.type = 'button';
      emptyBtn.innerHTML = '<i class="ph ph-plus-circle"></i> Dodaj zajęcia';
      emptyBtn.onclick = () => openEventDialog(null, date);
      list.append(emptyBtn);
    } else {
      const emptyNormal = node('div', 'day-empty-state', 'Brak zajęć');
      list.append(emptyNormal);
    }
  }

  day.append(list);
  return day;
}

function renderEvent(event, dayEvents) {
  const subject = state.plan.subjects.find((s) => s.id === event.subjectId);
  const button = node('button', 'event');
  button.type = 'button';
  button.style.setProperty('--event-color', subject.color);

  button.append(
    node('span', 'time', `${event.start} – ${event.end}`),
    node('span', 'name', subject.name),
    node('span', 'type', event.type),
  );

  if (event.room || event.teacher) {
    button.append(node('span', 'meta', [event.room, event.teacher].filter(Boolean).join(' · ')));
  }

  const overlaps = dayEvents.some(
    (other) => other.id !== event.id && other.start < event.end && other.end > event.start,
  );
  if (overlaps) button.append(node('span', 'meta', '⚠ Nakładające się godziny'));

  if (event.notes) button.append(node('span', 'meta', event.notes));

  button.onclick = () => {
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
  const subject = state.plan.subjects.find((s) => s.id === event.subjectId);
  if (!subject) return;

  detailsEventId = event.id;

  $('detailsColorDot').style.background = subject.color;
  $('detailsSubjectName').textContent = subject.name;
  $('detailsType').textContent = event.type;
  $('detailsDate').textContent = formatFullDate(event.date);
  $('detailsTime').textContent = `${event.start} – ${event.end}`;

  $('detailsRoom').textContent = event.room || 'Nie podano';
  $('detailsTeacher').textContent = event.teacher || 'Nie podano';

  const hasNotes = !!event.notes?.trim();
  $('detailsNotesSection').hidden = !hasNotes;
  $('detailsNotes').textContent = event.notes || '';

  const hasSubjectDetails = !!subject.details?.trim();
  $('detailsSubjectSection').hidden = !setSubjectDetailsContent(subject.details);

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

const EVENT_FIELDS = ['type', 'start', 'end', 'room', 'teacher', 'notes'];

function findDefaultNonHolidayDate(preferredDate) {
  if (!holidayFor(preferredDate, state.plan.academicYear)) return preferredDate;
  for (let i = 0; i < 7; i++) {
    const candidate = addDays(week, i);
    if (!holidayFor(candidate, state.plan.academicYear)) return candidate;
  }
  return preferredDate;
}

function openEventDialog(id, initialDate = null) {
  if (busy) return;

  if (!id && initialDate) {
    const holiday = holidayFor(initialDate, state.plan.academicYear);
    if (holiday) {
      const reason = holiday.label ? ` (${holiday.label})` : '';
      setStatus(`Dzień ${initialDate} jest ustawiony jako wolny${reason} — dodawanie zajęć w tym dniu jest zablokowane.`);
      return;
    }
  }

  if (!state.plan.subjects.length) {
    openSubjectDialog('Najpierw dodaj przedmiot, a następnie jego zajęcia.');
    return;
  }

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

  $('eventTitle').textContent = event ? 'Edytuj zajęcia' : 'Dodaj zajęcia';
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
  $('date').value = event?.date || initialDate || fallbackDate;

  if (event) {
    for (const field of EVENT_FIELDS) $(field).value = event[field];
    select.value = event.subjectId;
    $('scope').value = 'one';
  }

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
  return {
    subjectId: $('subject').value,
    type: $('type').value.trim(),
    date: $('date').value,
    start: $('start').value,
    end: $('end').value,
    room: $('room').value.trim(),
    teacher: $('teacher').value.trim(),
    notes: $('notes').value.trim(),
  };
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

    mutate((plan) => {
      if (editingId) {
        const original = plan.events.find((e) => e.id === editingId);
        const scope = $('scope').value;
        const shiftDays = Math.round((Date.parse(values.date) - Date.parse(original.date)) / 86_400_000);

        if (shiftDays !== 0) {
          const targetHoliday = holidayFor(values.date, plan.academicYear);
          if (targetHoliday) {
            const reason = targetHoliday.label ? ` (${targetHoliday.label})` : '';
            throw Error(`${values.date} to dzień wolny${reason}. Nie można przenieść zajęć na dzień wolny.`);
          }
        }

        plan.events = plan.events.map((e) => {
          if (!inScope(e, original, scope)) return e;
          const nextDate = addDays(e.date, shiftDays);
          // Jeśli przesuwamy serię i któryś z docelowych dni jest dniem wolnym, pomijamy przesunięcie na dzień wolny
          if (shiftDays !== 0 && holidayFor(nextDate, plan.academicYear)) {
            return null;
          }
          return { ...e, ...values, date: nextDate };
        }).filter(Boolean);
      } else {
        const repeatMode = $('repeat').value;
        // Blokada rozpoczęcia powtarzania lub pojedynczych zajęć w dniu ustawionym jako wolny
        if (applyAcademicYear) {
          const startHoliday = holidayFor(values.date, plan.academicYear);
          if (startHoliday) {
            const reason = startHoliday.label ? ` (${startHoliday.label})` : '';
            throw Error(
              `Wybrany dzień (${values.date}) jest ustawiony jako wolny${reason}. Wybierz dzień, w którym odbywają się zajęcia.`,
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
    const subject = subjectMap.get(first.subjectId);
    const subjectName = subject ? subject.name : 'Przedmiot';

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
      node('p', 'hint', 'Brak zdefiniowanych dni wolnych i przerw świątecznych. Dodaj je poniżej.'),
    );
    return;
  }

  const groups = groupSpecialDays(specialDays);

  for (const group of groups) {
    const row = node('div', 'specialdayrow');
    const info = node('div', 'specialdayrow-info');

    const dateLine = node('div', 'specialdayrow-date');
    const isRange = group.count > 1;
    const badgeText = group.type === 'holiday' ? (isRange ? `Przerwa (${group.count} dni)` : 'Wolne') : 'Zamiana';
    const badge = node('span', `badge ${group.type}`, badgeText);

    const dateRangeStr = isRange ? `${group.startDate} → ${group.endDate}` : group.startDate;
    dateLine.append(node('span', '', dateRangeStr), badge);

    let descText = group.label || (group.type === 'holiday' ? (isRange ? 'Przerwa świąteczna / wolna' : 'Dzień wolny') : '');
    if (group.type === 'swap') {
      const targetName = DAY_KEY_NAMES[group.targetDay] || group.targetDay;
      const swapDesc = `Zajęcia według planu z ${targetName}`;
      descText = descText ? `${swapDesc} (${descText})` : swapDesc;
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
  updateSpecialDayTypeFields();
  $('academicYearDialog').showModal();
}

function updateSpecialDayTypeFields() {
  const type = $('specialDayType').value;
  const isSwap = type === 'swap';
  const isRange = type === 'holiday_range';

  $('swapTargetContainer').hidden = !isSwap;
  $('dateEndContainer').hidden = !isRange;
  $('specialDayDateEnd').required = isRange;

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
        const item = { date: d, type: type === 'swap' ? 'swap' : 'holiday', label };
        if (type === 'swap') item.targetDay = targetDay;
        plan.academicYear.specialDays.push(item);
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

function openConnectionDialog() {
  try {
    $('token').value = localStorage.getItem(TOKEN_KEY) || '';
    $('connectionDialog').showModal();
  } catch (err) {
    setStatus(err.message);
  }
}

function saveConnection(event) {
  event.preventDefault();
  try {
    const token = $('token').value.trim();
    if (token && token.length < MIN_TOKEN_LENGTH) {
      throw Error(`Klucz musi mieć minimum ${MIN_TOKEN_LENGTH} znaki.`);
    }

    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);

    $('connectionDialog').close();
    setStatus('Ustawienie zapisane. Teraz pobierz plan lub zapisz lokalny plan w chmurze.');
  } catch (err) {
    setStatus(err.message);
  }
}

function setButtonsDisabled(disabled) {
  for (const button of document.querySelectorAll('button')) button.disabled = disabled;
}

/** Wysyła żądanie do Workera. direction: 'pull' (GET) lub 'push' (PUT). */
async function callApi(direction, token) {
  const headers = { Authorization: 'Bearer ' + token };
  const options = { method: 'GET', headers, cache: 'no-store', signal: AbortSignal.timeout(API_TIMEOUT_MS) };

  if (direction === 'push') {
    options.method = 'PUT';
    options.body = JSON.stringify(state.plan);
    headers['Content-Type'] = 'application/json';
    // Zapis warunkowy: nadpisz tylko wersję, którą znamy; przy pierwszym zapisie — tylko gdy pliku nie ma.
    if (state.etag) headers['If-Match'] = `"${state.etag}"`;
    else headers['If-None-Match'] = '*';
  }

  const response = await fetch(API_URL, options);

  let data;
  try {
    data = await response.json();
  } catch {
    throw Error('API nie jest dostępne. Uruchom projekt przez npm run dev albo wdróż Worker.');
  }
  if (!response.ok) throw Error(data.error || 'Błąd połączenia.');
  return data;
}

async function sync(direction) {
  if (busy) return;
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      $('connectionDialog').showModal();
      return;
    }

    if (
      direction === 'pull' &&
      state.dirty &&
      !confirm('Pobranie zastąpi niezapisane lokalne zmiany. Wyeksportuj je najpierw, jeśli chcesz je zachować. Kontynuować?')
    ) {
      return;
    }

    busy = true;
    setButtonsDisabled(true);
    setStatus(direction === 'pull' ? 'Pobieranie planu…' : 'Zapisywanie planu…');

    const data = await callApi(direction, token);

    const next = clone(state);
    if (direction === 'pull') next.plan = validatePlan(data.plan);
    next.etag = data.etag;
    next.dirty = false;
    persist(next);

    render();
    setStatus(`Zsynchronizowano · ${new Date().toLocaleTimeString('pl-PL')}.`);
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
  $('editModeToggle').onclick = () => setEditMode(!editMode);
  $('addEvent').onclick = () => openEventDialog();
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

  $('subjects').onclick = () => openSubjectDialog();
  $('subjectForm').onsubmit = saveSubject;
  $('newSubject').onclick = resetSubjectForm;

  $('bulkManageBtn').onclick = () => openBulkDialog();
  $('reconcileBtn').onclick = runReconcile;
  $('clearEventsBtn').onclick = clearAllEvents;
  $('clearAllBtn').onclick = clearEntireCalendar;

  $('academicYearBtn').onclick = () => openAcademicYearDialog();
  $('academicYearForm').onsubmit = saveSpecialDay;
  $('specialDayType').onchange = updateSpecialDayTypeFields;

  for (const button of document.querySelectorAll('[data-close]')) {
    button.onclick = () => button.closest('dialog').close();
  }

  $('prev').onclick = () => showWeek(addDays(week, -7));
  $('next').onclick = () => showWeek(addDays(week, 7));
  $('today').onclick = () => showWeek(monday(today()));
  $('jump').onchange = () => {
    if ($('jump').value) showWeek(monday($('jump').value));
  };

  $('export').onclick = exportPlan;
  $('importButton').onclick = () => $('import').click();
  $('import').onchange = importPlan;

  $('connection').onclick = openConnectionDialog;
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
setEditMode(false);
reportState();
