(() => {
  // The application uses one visual scheme. Keep this small API for chart
  // consumers while preventing stale local preferences from re-enabling light mode.
  const DARK = 'dark';

  const current = () => DARK;

  function set(_theme = DARK, persist = false) {
    document.documentElement.dataset.theme = DARK;
    document.documentElement.style.colorScheme = DARK;
    if (persist) {
      try { localStorage.removeItem('wg-color-theme'); } catch {}
    }
    window.dispatchEvent(new CustomEvent('wg-theme-change', { detail: { theme: DARK } }));
    return DARK;
  }

  function chartOptions() {
    return {
      layout: { background: { type: 'solid', color: '#0b0f0e' }, textColor: '#91a19b' },
      grid: { vertLines: { color: '#19211f' }, horzLines: { color: '#19211f' } },
      rightPriceScale: { borderColor: '#202a27' },
      timeScale: { borderColor: '#202a27' },
    };
  }

  window.WGTheme = { current, set, chartOptions };
  // Clear any legacy light-mode preference while initializing the fixed theme.
  set(DARK, true);
})();
