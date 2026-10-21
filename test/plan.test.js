import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { emptyPlan, validatePlan, datesFor, monday, reconcileWithAcademicYear } from '../public/model.js';
import worker from '../worker.js';

// --- Dane i atrapy -------------------------------------------------------------

const TOKEN = 'x'.repeat(48);

function samplePlan() {
  return {
    schemaVersion: 1,
    subjects: [{ id: 'math', name: 'Matematyka', color: '#397d70' }],
    events: [
      {
        id: 'event',
        seriesId: 'series',
        subjectId: 'math',
        type: 'Wykład',
        date: '2026-10-14',
        start: '08:00',
        end: '09:30',
        room: '1',
        teacher: '',
        notes: '',
      },
    ],
  };
}

/** Atrapa bucketu R2 z obsługą wielu kluczy oraz warunków If-Match / If-None-Match. */
function createEnv() {
  const store = new Map();

  const PLANS = {
    async get(key) {
      const current = store.get(key);
      if (!current) return null;
      return { etag: current.etag, json: async () => JSON.parse(current.body) };
    },

    async put(key, body, options) {
      const current = store.get(key);
      const ifMatch = options.onlyIf.get('If-Match');
      const ifNoneMatch = options.onlyIf.get('If-None-Match');

      if (ifNoneMatch === '*' && current) return null;
      if (ifMatch && ifMatch !== `"${current?.etag}"`) return null;

      const saved = { body, etag: createHash('md5').update(body).digest('hex') };
      store.set(key, saved);
      return { etag: saved.etag };
    },
  };

  return { PLAN_TOKEN: TOKEN, PLANS };
}

function request(method = 'GET', body, extraHeaders = {}, token = TOKEN, planId = '') {
  const query = planId ? `?id=${encodeURIComponent(planId)}` : '';
  return new Request(`https://plan.example/api/plan${query}`, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const call = (req, env) => worker.fetch(req, env);

// --- Model ---------------------------------------------------------------------

test('co dwa tygodnie i zmiana czasu', () => {
  assert.deepEqual(datesFor('2026-10-14', '2026-11-30', 'biweekly'), [
    '2026-10-14',
    '2026-10-28',
    '2026-11-11',
    '2026-11-25',
  ]);
});

test('ręczne terminy i przerwa', () => {
  assert.deepEqual(
    datesFor('2026-10-14', '', 'manual', '2026-11-25,2026-10-14,2026-11-25'),
    ['2026-10-14', '2026-11-25'],
  );
});

test('początek tygodnia', () => {
  assert.equal(monday('2026-10-18'), '2026-10-12');
});

test('walidacja dat, godzin i relacji', () => {
  const brokenVariants = [
    (p) => (p.events[0].date = '2026-02-31'),
    (p) => (p.events[0].end = '07:00'),
    (p) => (p.events[0].subjectId = 'missing'),
    (p) => p.events.push({ ...p.events[0] }), // zduplikowane id
  ];

  for (const breakPlan of brokenVariants) {
    const plan = samplePlan();
    breakPlan(plan);
    assert.throws(() => validatePlan(plan));
  }

  assert.throws(() => datesFor('2026-10-14', '2026-09-01', 'weekly'));
});

test('walidacja struktury roku akademickiego', () => {
  const plan = samplePlan();
  plan.academicYear = {
    specialDays: [
      { date: '2026-11-01', type: 'holiday', label: 'Wszystkich Świętych' },
      { date: '2026-11-10', type: 'swap', label: 'Środa z piątku', targetDay: 'fri' },
    ],
  };
  assert.equal(validatePlan(plan).academicYear.specialDays.length, 2);

  // Duplikat daty w strukturze roku
  const duplicateDate = samplePlan();
  duplicateDate.academicYear = {
    specialDays: [
      { date: '2026-11-01', type: 'holiday', label: 'Dzień 1' },
      { date: '2026-11-01', type: 'holiday', label: 'Dzień 2' },
    ],
  };
  assert.throws(() => validatePlan(duplicateDate));

  // Swap bez prawidłowego targetDay
  const badSwap = samplePlan();
  badSwap.academicYear = {
    specialDays: [{ date: '2026-11-10', type: 'swap', label: 'Błędny swap', targetDay: 'invalid' }],
  };
  assert.throws(() => validatePlan(badSwap));
});

test('datesFor respektuje święta, przerwy i dni z zamianą planu', () => {
  // 2026-10-14 to środa
  // 2026-10-21 (środa) - wolne (święto/przerwa)
  // 2026-10-27 (wtorek) - zamiana: plan ze środy!
  // 2026-10-28 (środa) - zamiana: plan z piątku (zajęcia środowe tu NIE wypadają!)
  const academicYear = {
    specialDays: [
      { date: '2026-10-21', type: 'holiday', label: 'Przerwa' },
      { date: '2026-10-27', type: 'swap', label: 'Środa we wtorek', targetDay: 'wed' },
      { date: '2026-10-28', type: 'swap', label: 'Piątek w środę', targetDay: 'fri' },
    ],
  };

  const dates = datesFor('2026-10-14', '2026-10-30', 'weekly', '', academicYear, true);
  // Powinny być: 14 (środa) i 27 (wtorek realizujący środę). 21 (wolne) i 28 (środa realizująca piątek) pominięte!
  assert.deepEqual(dates, ['2026-10-14', '2026-10-27']);

  // Blokada dodania pojedynczych zajęć przedmiotu w dniu wolnym oraz w weekend (2026-10-17 to sobota)
  assert.throws(() => datesFor('2026-10-21', '', 'once', '', academicYear, true, false), /dzień wolny/);
  assert.throws(() => datesFor('2026-10-17', '', 'once', '', academicYear, true, false), /dzień wolny/);

  // Wydarzenie własne (isCustom = true) można dodać w weekend oraz w dzień wolny
  assert.deepEqual(datesFor('2026-10-17', '', 'once', '', academicYear, true, true), ['2026-10-17']);
  assert.deepEqual(datesFor('2026-10-21', '', 'once', '', academicYear, true, true), ['2026-10-21']);
});

test('reconcileWithAcademicYear dopasowuje istniejące serie i przedmioty obsługują opis details oraz remote', () => {
  const plan = samplePlan();
  plan.subjects[0].details = 'ECTS: 5, Prowadzący: dr Kowalski';
  plan.events = [
    { ...plan.events[0], id: 'e1', date: '2026-10-14', remote: true },
    { ...plan.events[0], id: 'e2', date: '2026-10-21', remote: true },
    { ...plan.events[0], id: 'e3', date: '2026-10-28', remote: true },
  ];
  plan.academicYear = {
    specialDays: [
      { date: '2026-10-21', type: 'holiday', label: 'Dzień rektorski' },
      { date: '2026-10-27', type: 'swap', label: 'Plan ze środy', targetDay: 'wed' },
    ],
  };

  validatePlan(plan);
  let seq = 0;
  const reconciled = reconcileWithAcademicYear(plan, () => `new_${++seq}`);
  assert.equal(reconciled.removed, 1);
  assert.equal(reconciled.added, 1);
  assert.deepEqual(
    reconciled.events.map((e) => e.date).sort(),
    ['2026-10-14', '2026-10-27', '2026-10-28'],
  );
  assert.equal(reconciled.events.every((e) => e.remote === true), true);

  // Nieprawidłowy typ pola remote odrzucany przez walidację
  const badRemote = samplePlan();
  badRemote.events[0].remote = 'yes';
  assert.throws(() => validatePlan(badRemote));

  // Wydarzenie własne / poza przedmiotem (off-top) bez subjectId
  const withCustomEvent = samplePlan();
  withCustomEvent.events.push({
    id: 'custom_1',
    seriesId: 'custom_series',
    subjectId: null,
    customTitle: 'Spotkanie z promotorem',
    customColor: '#b87d3b',
    type: 'Spotkanie',
    date: '2026-10-15',
    start: '12:00',
    end: '13:00',
    room: 'A-101',
    teacher: 'prof. Nowak',
    notes: 'Omówienie rozdziału 2',
  });
  assert.equal(validatePlan(withCustomEvent).events.length, 2);

  // Wydarzenie bez subjectId i bez customTitle jest odrzucane
  const missingCustomTitle = samplePlan();
  missingCustomTitle.events.push({
    ...withCustomEvent.events[1],
    id: 'custom_bad',
    customTitle: '',
  });
  assert.throws(() => validatePlan(missingCustomTitle));

  // Godziny / dzień rektorski (nakładka na plan — nie usuwa zajęć z tego dnia)
  const rectorPlan = samplePlan();
  rectorPlan.events = [
    { ...rectorPlan.events[0], id: 'r1', date: '2026-10-14' },
    { ...rectorPlan.events[0], id: 'r2', date: '2026-10-21' },
  ];
  rectorPlan.academicYear = {
    specialDays: [
      { date: '2026-10-14', type: 'rector', label: 'Juwenalia', start: '10:00', end: '14:00' },
      { date: '2026-10-21', type: 'rector', label: 'Dzień rektorski' },
    ],
  };
  validatePlan(rectorPlan);
  const reconciledRector = reconcileWithAcademicYear(rectorPlan, () => 'unused');
  assert.equal(reconciledRector.removed, 0);
  assert.equal(reconciledRector.events.length, 2);

  // Nieprawidłowe godziny rektorskie (end <= start) są odrzucane
  const badRector = samplePlan();
  badRector.academicYear = {
    specialDays: [{ date: '2026-10-14', type: 'rector', label: 'Błąd', start: '14:00', end: '10:00' }],
  };
  assert.throws(() => validatePlan(badRector));
});

// --- API -----------------------------------------------------------------------

test('klucz i brak konfiguracji', async () => {
  const env = createEnv();

  for (const method of ['GET', 'PUT']) {
    const body = method === 'PUT' ? samplePlan() : undefined;
    const response = await call(request(method, body, {}, 'bad'), env);
    assert.equal(response.status, 401);
  }

  const response = await call(request(), { ...env, PLAN_TOKEN: '' });
  assert.equal(response.status, 503);
});

test('pierwszy zapis, odczyt i aktualizacja', async () => {
  const env = createEnv();

  const initial = await (await call(request(), env)).json();
  assert.deepEqual(initial.plan, emptyPlan());

  const first = await call(request('PUT', samplePlan(), { 'If-None-Match': '*' }), env);
  assert.equal(first.status, 200);
  const { etag } = await first.json();

  const next = samplePlan();
  next.events[0].room = '2';
  const update = await call(request('PUT', next, { 'If-Match': `"${etag}"` }), env);
  assert.equal(update.status, 200);

  const saved = await (await call(request(), env)).json();
  assert.equal(saved.plan.events[0].room, '2');

  // Osobny plan w chmurze dla drugiej osoby po podaniu nazwy/ID (?id=ania)
  const aniaPlan = samplePlan();
  aniaPlan.events[0].room = 'Sala-Ania';
  const aniaSave = await call(request('PUT', aniaPlan, { 'If-None-Match': '*' }, TOKEN, 'ania'), env);
  assert.equal(aniaSave.status, 200);

  const aniaRead = await (await call(request('GET', undefined, {}, TOKEN, 'ania'), env)).json();
  assert.equal(aniaRead.plan.events[0].room, 'Sala-Ania');

  // Domyślny plan pozostaje nienaruszony
  const defaultRead = await (await call(request(), env)).json();
  assert.equal(defaultRead.plan.events[0].room, '2');

  // Nieprawidłowe znaki w ID planu są odrzucane (400)
  const badId = await call(request('GET', undefined, {}, TOKEN, '../bad id!'), env);
  assert.equal(badId.status, 400);
});

test('dwa urządzenia: jeden zapis starej wersji przechodzi', async () => {
  const env = createEnv();

  const first = await call(request('PUT', samplePlan(), { 'If-None-Match': '*' }), env);
  const { etag } = await first.json();

  const a = samplePlan();
  const b = samplePlan();
  a.events[0].room = 'A';
  b.events[0].room = 'B';

  const results = await Promise.all(
    [a, b].map((plan) => call(request('PUT', plan, { 'If-Match': `"${etag}"` }), env)),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);

  const recreate = await call(request('PUT', samplePlan(), { 'If-None-Match': '*' }), env);
  assert.equal(recreate.status, 409);
});

test('API odrzuca brak wersji, zły plan i obce źródło', async () => {
  const env = createEnv();

  assert.equal((await call(request('PUT', {}), env)).status, 428);
  assert.equal((await call(request('PUT', {}, { 'If-None-Match': '*' }), env)).status, 400);

  const foreign = request('PUT', samplePlan(), {
    'If-None-Match': '*',
    Origin: 'https://evil.example',
  });
  assert.equal((await call(foreign, env)).status, 403);
});

test('API odrzuca niepoprawny JSON i nieznaną ścieżkę', async () => {
  const env = createEnv();

  const badJson = new Request('https://plan.example/api/plan', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
      'If-None-Match': '*',
    },
    body: '{nie-json',
  });
  assert.equal((await call(badJson, env)).status, 400);

  const unknown = new Request('https://plan.example/api/other');
  assert.equal((await call(unknown, env)).status, 404);
});
