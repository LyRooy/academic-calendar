# Plan studenta — JavaScript + Cloudflare Worker + R2

Prosta aplikacja bez kont użytkowników i bez SQL. Frontend: HTML, CSS i JavaScript.
Backend: JavaScript uruchamiany jako Cloudflare Worker. Jeden prywatny obiekt `plan.json` w R2.

## Funkcje

- Responsywny widok tygodnia: kolumny na komputerze, lista dni na telefonie.
- Przedmiot ma nazwę i kolor. Dowolna liczba typów zajęć w jego ramach.
- Osobne godziny, sala, prowadzący i notatka każdego spotkania.
- Dodawanie jednorazowe, co tydzień, co dwa tygodnie albo wskazane daty.
- Edycja/usunięcie jednego spotkania lub tego i kolejnych z tej samej serii.
- Wszystkie terminy są konkretnymi datami. Przerwy można uzyskać przez wskazanie dat lub usunięcie pojedynczych spotkań.
- Przy zmianie daty całej pozostałej serii każde spotkanie przesuwa się o ten sam odstęp.
- Ostrzeżenie o nakładających się zajęciach.
- Lokalny zapis w localStorage, import/eksport własnego formatu JSON.
- Ręczna synchronizacja przyciskami „Pobierz z chmury” / „Zapisz w chmurze”.
- Warunkowy zapis R2 (ETag) chroni przed nadpisaniem planu przez starszą kopię z innego urządzenia.
- Blokada zapisu po wykryciu zmiany danych w drugiej karcie tej samej przeglądarki.

To wersja startowa. Nie zawiera importu USOS, automatycznego scalania konfliktów,
przypomnień ani PWA/service workera. Otwarta strona działa bez sieci na lokalnych
danych; ponowne otwarcie strony offline nie jest gwarantowane. Dane mają godziny
lokalne uczelni, bez przeliczania stref czasowych.

## Uruchomienie lokalne

Zainstaluj Node.js 22 LTS lub nowszy. Otwórz terminal w katalogu projektu:

```sh
npm ci
```

Skopiuj `.dev.vars.example` jako `.dev.vars` (możesz zrobić to w edytorze).
Wygeneruj losowy klucz:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Wstaw go do `.dev.vars`:

```text
PLAN_TOKEN="tutaj-twoj-wygenerowany-klucz"
```

Następnie:

```sh
npm run dev
```

Otwórz adres pokazany przez Wrangler (zwykle http://localhost:8787).
Lokalny R2 jest emulowany przez Wrangler i nie zmienia danych w chmurze.
Nie otwieraj `index.html` przez `file://`: moduły JS i API wymagają serwera HTTP.

## Wdrożenie na Cloudflare

Potrzebujesz własnego konta Cloudflare oraz aktywnego R2. Aplikacja sama nie wymaga
kont użytkowników. Projekt korzysta z Workers Static Assets, więc osobny projekt
Pages nie jest potrzebny. Przed wdrożeniem sprawdź aktualne limity i rozliczenia konta.

```sh
npx wrangler login
npx wrangler r2 bucket create student-calendar-plans
```

Jeśli wybierzesz inną nazwę magazynu, zmień `bucket_name` w `wrangler.jsonc`.
Nie włączaj publicznego dostępu do R2. Dostęp odbywa się wyłącznie przez Worker.

```sh
npm run deploy
npx wrangler secret put PLAN_TOKEN
```

Przy ostatnim poleceniu wklej swój wygenerowany klucz (32–200 znaków).
Sekret jest zapisywany po stronie Cloudflare, nie w publicznych plikach.
Do ustawienia sekretu API odmawia dostępu; frontend może już się wyświetlać.
Nie dodawaj klucza do `public/`, repozytorium ani `wrangler.jsonc`.
`.dev.vars` jest tylko do lokalnego uruchamiania — nie zastępuje produkcyjnego sekretu.

Otwórz adres `workers.dev` pokazany przy wdrożeniu. Wybierz „Klucz dostępu”,
wpisz klucz i zapisz ustawienie. Klucz jest przechowywany w localStorage tej
przeglądarki — korzystaj z tej opcji na własnych urządzeniach.

## Pierwszy plan i drugie urządzenie

1. W „Przedmioty” dodaj przedmiot, np. „Metody sztucznej inteligencji”.
2. „Dodaj zajęcia”: wybierz przedmiot, typ, datę, godziny i powtarzanie.
3. Dla wykładu, laboratorium i projektu wybieraj ten sam przedmiot i różne typy.
4. Kliknij „Zapisz w chmurze”. Pierwszy zapis tworzy `plan.json`.
5. Na telefonie otwórz ten sam adres, ustaw klucz i kliknij „Pobierz z chmury”.
6. Po edycji zapisuj zmiany do chmury. Na drugim urządzeniu pobierz plan przed edycją.

Jeśli masz zajęcia w tym tygodniu i dopiero za sześć tygodni, wybierz „Wskazane daty”
i wpisz np. `2026-10-14, 2026-11-25`. Lista dat zastępuje datę główną formularza.

## Konflikty i kopie zapasowe

Nie ma automatycznego nadpisywania przy konflikcie. Wyeksportuj lokalną kopię,
pobierz nowszy plan, a następnie ponownie wprowadź potrzebne zmiany. Import JSON
zastępuje cały lokalny plan (po potwierdzeniu), nie scala go z istniejącym.
Eksport nie zawiera klucza dostępu ani wersji serwera.

localStorage nie jest trwałą kopią zapasową: czyszczenie danych przeglądarki usuwa
lokalny plan i klucz. Eksportuj JSON również niezależnie od R2. Przy zmianie adresu
aplikacji/domeny dane przeglądarki nie przenoszą się automatycznie.

Jeśli przeglądarka blokuje localStorage lub dane są uszkodzone, aplikacja blokuje
zapis zamiast cicho nadpisywać dane. Przy uszkodzonym wpisie zachowaj surową wartość
`student-calendar-v1` z narzędzi przeglądarki przed jej usunięciem. Eksport z ekranu
nie odzyska uszkodzonego wpisu.

## Pliki i format

- `public/index.html` — interfejs.
- `public/style.css` — wygląd i układ na telefonie.
- `public/app.js` — interakcje, lokalny zapis, synchronizacja.
- `public/model.js` — daty, generowanie terminów i wspólna walidacja.
- `worker.js` — API GET/PUT, klucz dostępu i atomowe warunki zapisu R2.
- `wrangler.jsonc` — konfiguracja Cloudflare.
- `test/plan.test.js` — testy modelu i API (z atrapą R2).

JSON zawiera `schemaVersion: 1`, `subjects` i `events`. Każdy termin ma `id`,
`seriesId`, `subjectId`, `type`, `date`, `start`, `end`, `room`, `teacher`, `notes`.
Limity wersji startowej: 500 przedmiotów, 10 000 terminów, 500 terminów w jednej
operacji powtarzania oraz 2 MB importowanego/zapisywanego pliku.

## Weryfikacja

```sh
npm test        # 9 testów modelu i API (z atrapą R2)
npm run check   # testy + próbne zbudowanie Workera (wrangler deploy --dry-run)
```

Testy obejmują powtarzanie, poprawność dat, autoryzację, niepoprawny JSON oraz
konflikt równoległych zapisów. `npm run dev` uruchamia lokalny Worker z emulowanym R2.

Dokumentacja wykorzystanych API:
- https://developers.cloudflare.com/workers/static-assets/binding/
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
