import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { emptyPlan, validatePlan, datesFor, monday } from '../public/model.js';
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

/** Atrapa bucketu R2 z obsługą warunków If-Match / If-None-Match. */
function createEnv() {
  let current = null;

  const PLANS = {
    async get() {
      if (!current) return null;
      return { etag: current.etag, json: async () => JSON.parse(current.body) };
    },

    async put(key, body, options) {
      const ifMatch = options.onlyIf.get('If-Match');
      const ifNoneMatch = options.onlyIf.get('If-None-Match');

      if (ifNoneMatch === '*' && current) return null;
      if (ifMatch && ifMatch !== `"${current?.etag}"`) return null;

      current = { body, etag: createHash('md5').update(body).digest('hex') };
      return { etag: current.etag };
    },
  };

  return { PLAN_TOKEN: TOKEN, PLANS };
}

function request(method = 'GET', body, extraHeaders = {}, token = TOKEN) {
  return new Request('https://plan.example/api/plan', {
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
