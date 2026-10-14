// Wspólny model danych planu — używany zarówno w przeglądarce (app.js),
// jak i w Workerze (worker.js), dzięki czemu walidacja jest identyczna po obu stronach.

export const SCHEMA_VERSION = 1;

export const LIMITS = {
  subjects: 500,
  events: 10_000,
  eventsPerSeries: 500,
  subjectName: 120,
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

/**
 * Generuje listę dat spotkań.
 * @param {string} start  pierwsza data (RRRR-MM-DD)
 * @param {string} until  ostatnia możliwa data serii (dla weekly/biweekly)
 * @param {'once'|'weekly'|'biweekly'|'manual'} mode  tryb powtarzania
 * @param {string} manual lista dat oddzielonych przecinkami/spacjami (dla trybu manual)
 */
export function datesFor(start, until, mode, manual = '') {
  if (!validDate(start)) throw Error('Wybierz prawidłową datę.');

  if (mode === 'once') return [start];

  if (mode === 'manual') {
    const dates = [...new Set(manual.split(/[\s,;]+/).filter(Boolean))].sort();
    if (!dates.length || dates.length > LIMITS.eventsPerSeries || !dates.every(validDate)) {
      throw Error('Podaj daty w formacie RRRR-MM-DD, oddzielone przecinkami.');
    }
    return dates;
  }

  if (!['weekly', 'biweekly'].includes(mode) || !validDate(until) || until < start) {
    throw Error('Podaj datę końca serii nie wcześniejszą niż początek.');
  }

  const step = mode === 'weekly' ? 7 : 14;
  const result = [];
  for (let date = start; date <= until; date = addDays(date, step)) {
    if (result.length >= LIMITS.eventsPerSeries) {
      throw Error(`Maksymalnie ${LIMITS.eventsPerSeries} spotkań w jednej serii.`);
    }
    result.push(date);
  }
  return result;
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
    COLOR_PATTERN.test(subject.color)
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
