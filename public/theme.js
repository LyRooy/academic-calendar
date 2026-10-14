// Motyw kolorystyczny: auto (jak w systemie) / jasny / ciemny.
// Zwykły (nie-modułowy) skrypt ładowany w <head>, żeby ustawić motyw przed narysowaniem
// strony — dzięki temu nie ma błysku jasnego tła przy trybie ciemnym.

(function () {
  const STORAGE_KEY = 'student-calendar-theme';
  const MODES = ['auto', 'light', 'dark'];
  const LABELS = {
    auto: '<i class="ph ph-circle-half"></i> Auto',
    light: '<i class="ph ph-sun"></i> Jasny',
    dark: '<i class="ph ph-moon"></i> Ciemny',
  };
  const THEME_COLORS = { light: '#163d36', dark: '#0f1715' };

  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  function readMode() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return MODES.includes(saved) ? saved : 'auto';
    } catch {
      return 'auto';
    }
  }

  function saveMode(mode) {
    try {
      if (mode === 'auto') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Brak dostępu do localStorage — motyw działa do odświeżenia strony.
    }
  }

  let mode = readMode();

  function apply() {
    const theme = mode === 'auto' ? (systemDark.matches ? 'dark' : 'light') : mode;
    document.documentElement.dataset.theme = theme;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = THEME_COLORS[theme];

    const button = document.getElementById('themeToggle');
    if (button) {
      button.innerHTML = LABELS[mode];
      button.title = 'Motyw: kliknij, aby zmienić (auto → jasny → ciemny)';
    }
  }

  function cycle() {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    saveMode(mode);
    apply();
  }

  // W trybie auto reagujemy na zmianę motywu systemu na żywo.
  systemDark.addEventListener('change', () => {
    if (mode === 'auto') apply();
  });

  apply();

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('themeToggle').addEventListener('click', cycle);
    apply();
  });
})();

