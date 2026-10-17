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
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#151517');
})();
