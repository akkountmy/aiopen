/* Applied before first paint so the chosen theme never flashes. */
(function () {
  var theme = 'dark';
  try {
    var saved = window.localStorage && window.localStorage.getItem('dshow-theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch (error) {
    /* storage may be blocked — fall back to dark */
  }
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  /* Тот же цвет сразу уходит в theme-color (полоса приложения-ярлыка) и в фон
     html (Safari 26 берёт из него цвет полосы до загрузки стилей). */
  var bg = theme === 'light' ? '#ffffff' : '#151517';
  root.style.backgroundColor = bg;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
})();
