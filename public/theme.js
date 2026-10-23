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
  /* Тот же цвет сразу уходит в theme-color (старые версии iOS и Android) и в фон
     html (Safari 26 берёт из него цвет полосы до загрузки стилей). */
  var bg = theme === 'light' ? '#ffffff' : '#151517';
  root.style.backgroundColor = bg;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
  /* Полоса состояния приложения-ярлыка. В «default» её цвет не наш: iOS 26 не
     читает theme-color (WebKit 301756, 325446), а берёт оформление из системной
     темы — при светлом оформлении телефона полоса остаётся белой и в тёмной теме
     приложения. Поэтому у тёмной темы полоса прозрачная (black-translucent):
     страница сама закрашивает верх своим bg (полоска .status-tint + шапка), а
     env(safe-area-inset-top) в этом режиме как раз равен высоте полосы, так что
     раскладка отступает под часы. У светлой темы остаётся default: белая полоса
     с чёрными значками — читаемо и совпадает с темой. Значение ставим до первой
     отрисовки: iOS читает его при загрузке страницы. */
  var bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (bar) bar.setAttribute('content', theme === 'dark' ? 'black-translucent' : 'default');
})();
