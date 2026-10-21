// Wspólny model danych planu — używany zarówno w przeglądarce (app.js),
// jak i w Workerze (worker.js), dzięki czemu walidacja jest identyczna po obu stronach.

export const SCHEMA_VERSION = 1;

export const LIMITS = {
  subjects: 500,
  events: 10_000,
  eventsPerSeries: 500,
  subjectName: 120,
  subjectDetails: 2000,
  type: 60,
  room: 120,
  teacher: 120,
  notes: 2000,
  specialDays: 500,
  dayLabel: 120,
};

const MIN_DATE = '2000-01-01';
const MAX_DATE = '2100-12-31';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const DAY_OF_WEEK_PATTERN = /^(mon|tue|wed|thu|fri|sat|sun)$/;

export const emptyPlan = () => ({
  schemaVersion: SCHEMA_VERSION,
  subjects: [],
  events: [],
  academicYear: {
    specialDays: [], // { date: 'YYYY-MM-DD', type: 'holiday'|'swap', label: '...', targetDay?: 'mon'|'tue'|... }
  },
});

/** Sprawdza, czy tekst to istniejąca data w formacie RRRR-MM-DD (np. odrzuca 2026-02-31). */
export function validDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  if (value < MIN_DATE || value > MAX_DATE) return false;

  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Dodaje `days` dni do daty RRRR-MM-DD. Liczy w południe UTC, więc zmiana czasu nie przesuwa dnia. */
export function addDays(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Zwraca poniedziałek tygodnia, do którego należy podana data. */
export function monday(date) {
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay(); // 0 = niedziela
  const daysSinceMonday = (weekday + 6) % 7;
  return addDays(date, -daysSinceMonday);
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_MS = 86_400_000;

/** Zwraca klucz dnia tygodnia ('mon'..'sun') dla podanej daty. */
export function getDayOfWeekKey(date) {
  return WEEKDAY_KEYS[new Date(date + 'T12:00:00Z').getUTCDay()];
}

/** Liczba pełnych tygodni między tygodniami, do których należą daty `a` i `b`. */
function weeksBetween(a, b) {
  return Math.round((Date.parse(monday(b)) - Date.parse(monday(a))) / (7 * DAY_MS));
}

/** Mapa data → wpis dnia specjalnego ze struktury roku. */
function specialDayMap(academicYear) {
  return new Map((academicYear?.specialDays || []).map((sd) => [sd.date, sd]));
}

/**
 * Który dzień planu obowiązuje w danej dacie według struktury roku:
 *  - null       → dzień wolny (święto, przerwa),
 *  - targetDay  → dzień z zamianą planu (np. wtorek realizowany wg planu ze środy → 'wed'),
 *  - inaczej    → zwykły dzień tygodnia tej daty.
 */
export function effectiveDayKey(date, academicYear, map = specialDayMap(academicYear)) {
  const special = map.get(date);
  if (special?.type === 'holiday') return null;
  if (special?.type === 'swap') return special.targetDay;
  return getDayOfWeekKey(date);
}

/** Zwraca wpis dnia wolnego dla daty albo null. */
export function holidayFor(date, academicYear) {
  const special = specialDayMap(academicYear).get(date);
  return special?.type === 'holiday' ? special : null;
}

function holidayError(date, holiday) {
  const reason = holiday.label ? ` (${holiday.label})` : '';
  return Error(
    `${date} to dzień wolny${reason}. Wybierz inną datę albo odznacz „Dopasuj do struktury roku”.`,
  );
}

/**
 * Generuje listę dat spotkań.
 *
 * Gdy `applyAcademicYear` jest włączone:
 *  - dni wolne (święta, przerwy) są pomijane, a pojedynczego terminu nie da się w nich dodać,
 *  - w dniu z zamianą planu (np. środa wg planu z piątku) zajęcia środowe nie odbywają się,
 *  - zajęcia „przeskakują” na dzień, który realizuje plan ich dnia tygodnia
 *    (np. wtorek wg planu ze środy dostaje zajęcia środowe) — także przy powtarzaniu co 2 tygodnie.
 *
 * @param {string} start  pierwsza data (RRRR-MM-DD) — wyznacza dzień tygodnia serii
 * @param {string} until  ostatnia możliwa data serii (dla weekly/biweekly)
 * @param {'once'|'weekly'|'biweekly'|'manual'} mode  tryb powtarzania
 * @param {string} manual lista dat oddzielonych przecinkami/spacjami (dla trybu manual)
 * @param {object} [academicYear] struktura roku z tablicą specialDays
 * @param {boolean} [applyAcademicYear=true] czy stosować reguły dni wolnych i zamian
 */
export function datesFor(start, until, mode, manual = '', academicYear = null, applyAcademicYear = true) {
  if (!validDate(start)) throw Error('Wybierz prawidłową datę.');

  const year = applyAcademicYear ? academicYear : null;
  const map = specialDayMap(year);

  if (mode === 'once') {
    const special = map.get(start);
    if (special?.type === 'holiday') throw holidayError(start, special);
    return [start];
  }

  if (mode === 'manual') {
    const dates = [...new Set(manual.split(/[\s,;]+/).filter(Boolean))].sort();
    if (!dates.length || dates.length > LIMITS.eventsPerSeries || !dates.every(validDate)) {
      throw Error('Podaj daty w formacie RRRR-MM-DD, oddzielone przecinkami.');
    }
    const allowed = dates.filter((d) => map.get(d)?.type !== 'holiday');
    if (!allowed.length) throw Error('Wszystkie wskazane daty przypadają na dni wolne.');
    return allowed;
  }

  if (!['weekly', 'biweekly'].includes(mode) || !validDate(until) || until < start) {
    throw Error('Podaj datę końca serii nie wcześniejszą niż początek.');
  }

  const seriesDay = getDayOfWeekKey(start);
  const everyWeeks = mode === 'weekly' ? 1 : 2;
  const result = [];

  // Sprawdzamy każdy dzień zakresu: zajęcia odbywają się tam, gdzie obowiązuje plan dnia serii.
  for (let date = start; date <= until; date = addDays(date, 1)) {
    if (effectiveDayKey(date, year, map) !== seriesDay) continue;
    if (weeksBetween(start, date) % everyWeeks !== 0) continue;

    if (result.length >= LIMITS.eventsPerSeries) {
      throw Error(`Maksymalnie ${LIMITS.eventsPerSeries} spotkań w jednej serii.`);
    }
    result.push(date);
  }

  if (!result.length) {
    throw Error('W wybranym okresie nie ma żadnego terminu — wszystkie przypadają na dni wolne.');
  }
  return result;
}

/**
 * Dopasowuje już istniejące zajęcia do struktury roku (np. gdy dni wolne dodano po utworzeniu planu).
 * Dotyczy tylko serii powtarzalnych (min. 2 spotkania) — pojedyncze terminy pozostają bez zmian.
 *  - usuwa spotkania serii z dni wolnych i z dni realizujących plan innego dnia tygodnia,
 *  - dodaje spotkania w dniach, które realizują plan dnia tygodnia danej serii.
 *
 * @returns {{ events: object[], removed: number, added: number }} nowa lista zajęć i liczba zmian
 */
export function reconcileWithAcademicYear(plan, makeId) {
  const map = specialDayMap(plan.academicYear);
  const series = new Map();
  for (const e of plan.events) {
    if (!series.has(e.seriesId)) series.set(e.seriesId, []);
    series.get(e.seriesId).push(e);
  }

  const removeIds = new Set();
  const additions = [];

  for (const events of series.values()) {
    if (events.length < 2) continue;
    events.sort((a, b) => a.date.localeCompare(b.date));

    // Dzień tygodnia serii = najczęstszy dzień wśród spotkań poza dniami specjalnymi.
    const regular = events.filter((e) => !map.has(e.date));
    if (!regular.length) continue;
    const counts = {};
    for (const e of regular) {
      const key = getDayOfWeekKey(e.date);
      counts[key] = (counts[key] || 0) + 1;
    }
    const seriesDay = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const sameDay = regular.filter((e) => getDayOfWeekKey(e.date) === seriesDay);
    const anchor = sameDay[0].date;
    const everyWeeks = sameDay.every((e) => weeksBetween(anchor, e.date) % 2 === 0) && sameDay.length > 1 ? 2 : 1;

    // 1. Usuń spotkania z dni wolnych / dni z planem innego dnia.
    for (const e of events) {
      if (map.has(e.date) && effectiveDayKey(e.date, null, map) !== seriesDay) removeIds.add(e.id);
    }

    // 2. Dodaj spotkania w dniach realizujących plan dnia tej serii.
    const first = events[0].date;
    const last = events[events.length - 1].date;
    const taken = new Set(events.map((e) => e.date));
    for (const [date, sd] of map) {
      if (sd.type !== 'swap' || sd.targetDay !== seriesDay) continue;
      if (date < first || date > last || taken.has(date)) continue;
      if (weeksBetween(anchor, date) % everyWeeks !== 0) continue;

      // Wzorzec: najbliższe w czasie zwykłe spotkanie tej serii (godziny, sala, prowadzący).
      const template = sameDay.reduce((best, e) =>
        Math.abs(Date.parse(e.date) - Date.parse(date)) < Math.abs(Date.parse(best.date) - Date.parse(date)) ? e : best,
      );
      additions.push({ ...template, id: makeId(), date });
    }
  }

  return {
    events: [...plan.events.filter((e) => !removeIds.has(e.id)), ...additions],
    removed: removeIds.size,
    added: additions.length,
  };
}

// --- Walidacja całego planu ---------------------------------------------------

const isText = (value, maxLength) => typeof value === 'string' && value.length <= maxLength;
const isNonEmptyText = (value, maxLength) => isText(value, maxLength) && value.trim() !== '';
const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
const isTime = (value) => typeof value === 'string' && TIME_PATTERN.test(value);

function isValidSubject(subject, knownIds) {
  return (
    !!subject &&
    isId(subject.id) &&
    !knownIds.has(subject.id) &&
    isNonEmptyText(subject.name, LIMITS.subjectName) &&
    typeof subject.color === 'string' &&
    COLOR_PATTERN.test(subject.color) &&
    (subject.details === undefined || isText(subject.details, LIMITS.subjectDetails))
  );
}

function isValidEvent(event, knownIds, subjectIds) {
  return (
    !!event &&
    isId(event.id) &&
    !knownIds.has(event.id) &&
    isId(event.seriesId) &&
    subjectIds.has(event.subjectId) &&
    isNonEmptyText(event.type, LIMITS.type) &&
    validDate(event.date) &&
    isTime(event.start) &&
    isTime(event.end) &&
    event.end > event.start &&
    isText(event.room, LIMITS.room) &&
    isText(event.teacher, LIMITS.teacher) &&
    isText(event.notes, LIMITS.notes)
  );
}

function isValidSpecialDay(sd, knownDates) {
  if (!sd || !validDate(sd.date) || knownDates.has(sd.date)) return false;
  if (!['holiday', 'swap'].includes(sd.type)) return false;
  if (!isText(sd.label, LIMITS.dayLabel)) return false;
  if (sd.type === 'swap') {
    if (!sd.targetDay || !DAY_OF_WEEK_PATTERN.test(sd.targetDay)) return false;
  }
  return true;
}

/** Rzuca błąd, jeśli plan ma nieprawidłową strukturę. Zwraca ten sam obiekt. */
export function validatePlan(plan) {
  if (
    !plan ||
    plan.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(plan.subjects) ||
    !Array.isArray(plan.events) ||
    plan.subjects.length > LIMITS.subjects ||
    plan.events.length > LIMITS.events
  ) {
    throw Error(`Nieprawidłowy format planu (schemaVersion: ${SCHEMA_VERSION}).`);
  }

  // Sprawdzenie academicYear (opcjonalne wstecznie dla starszych planów, inicjalizowane jeśli brak)
  if (plan.academicYear !== undefined) {
    if (typeof plan.academicYear !== 'object' || plan.academicYear === null || !Array.isArray(plan.academicYear.specialDays)) {
      throw Error('Nieprawidłowy format struktury roku akademickiego.');
    }
    if (plan.academicYear.specialDays.length > LIMITS.specialDays) {
      throw Error(`Zbyt wiele dni specjalnych w strukturze roku (maks. ${LIMITS.specialDays}).`);
    }
    const specialDates = new Set();
    for (const sd of plan.academicYear.specialDays) {
      if (!isValidSpecialDay(sd, specialDates)) {
        throw Error('Nieprawidłowy wpis dnia specjalnego w strukturze roku.');
      }
      specialDates.add(sd.date);
    }
  } else {
    plan.academicYear = { specialDays: [] };
  }

  const subjectIds = new Set();
  for (const subject of plan.subjects) {
    if (!isValidSubject(subject, subjectIds)) throw Error('Nieprawidłowy przedmiot.');
    subjectIds.add(subject.id);
  }

  const eventIds = new Set();
  for (const event of plan.events) {
    if (!isValidEvent(event, eventIds, subjectIds)) {
      throw Error('Nieprawidłowy termin zajęć lub brak przedmiotu.');
    }
    eventIds.add(event.id);
  }

  return plan;
}
