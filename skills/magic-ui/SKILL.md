---
name: magic-ui
description: 'Эффекты Magic UI (MIT) для страницы проекта — бегущая строка, луч по рамке, метеоры, докручивающиеся числа, карточка с подсветкой за курсором, градиентный заголовок, блик рамки. Чистый CSS и один script, без CDN и сборки. Use when «сделай красиво», «добавь анимацию», «бегущая строка», «метеоры», «карточки с подсветкой», «градиентный заголовок».'
when: 'лендинг или отчёт просят оживить: бегущая строка, метеоры в фоне, блик по рамке, градиентный заголовок, числа, которые докручиваются, карточки с подсветкой за курсором'
---

# Эффекты Magic UI без сборки и без CDN

Оригинал Magic UI — React + Tailwind + motion, ставить его незачем: страница в
этом сервисе собирается одним HTML-файлом и открывается прямо в просмотре
проекта. Ниже — те же эффекты, переписанные в чистый CSS-классы `mui-*` и
один обычный `<script>`. Ни сети, ни сборки, ни зависимостей.

## Как работать

1. Собери страницу по навыку `web-page` (один файл, понятная структура).
2. Возьми из этой инструкции **только нужные** блоки: не тащи все эффекты в
   одну страницу — два-три по делу выглядят дороже, чем восемь подряд.
3. Классы `mui-*` начинай с префикса и не переименовывай: правила завязаны на
   них. Значения (цвета, скорости, размеры) меняй через CSS-переменные
   `--mui-*`, а не правкой правил.
4. Проверь страницу инструментом `check_page`: он открывает её в браузере и
   показывает ошибки консоли и горизонтальную прокрутку.

## Общие переменные

Правила ниже опираются на `--mui-bg`, `--mui-border`, `--mui-radius`. Задай их
один раз на `:root` под свою палитру (они же нужны для тёмной темы):

```css
:root {
  --mui-bg: #0b0b0f;
  --mui-border: #ffffff1a;
  --mui-radius: 14px;
}
```

## 1. Бегущая строка

```html
<div class="mui-marquee mui-marquee--fade mui-marquee--pause" style="--mui-duration:32s">
  <div class="mui-marquee__group"><span>Карточка 1</span><span>Карточка 2</span></div>
  <div class="mui-marquee__group" aria-hidden="true"><span>Карточка 1</span><span>Карточка 2</span></div>
</div>
```

Второй `__group` — копия содержимого (без неё на стыке будет дырка); добавь
`aria-hidden="true"`, чтобы экранный диктор не читал дубль. Модификаторы:
`--vertical`, `--reverse`, `--pause` (пауза при наведении), `--fade`.

```css
.mui-marquee {
  --mui-duration: 40s;
  --mui-gap: 1rem;
  display: flex;
  gap: var(--mui-gap);
  overflow: hidden;
  padding: 0.5rem;
}
.mui-marquee--vertical { flex-direction: column; }

.mui-marquee__group {
  display: flex;
  flex-shrink: 0;
  justify-content: space-around;
  gap: var(--mui-gap);
  min-width: 100%;
  animation: mui-marquee var(--mui-duration) linear infinite;
}
.mui-marquee--vertical .mui-marquee__group {
  flex-direction: column;
  min-width: 0;
  animation-name: mui-marquee-vertical;
}
.mui-marquee--reverse .mui-marquee__group { animation-direction: reverse; }
.mui-marquee--pause:hover .mui-marquee__group { animation-play-state: paused; }

.mui-marquee--fade {
  -webkit-mask-image: linear-gradient(to right, transparent, #000 12%, #000 88%, transparent);
  mask-image: linear-gradient(to right, transparent, #000 12%, #000 88%, transparent);
}

@keyframes mui-marquee {
  from { transform: translateX(0); }
  to   { transform: translateX(calc(-100% - var(--mui-gap))); }
}
@keyframes mui-marquee-vertical {
  from { transform: translateY(0); }
  to   { transform: translateY(calc(-100% - var(--mui-gap))); }
}
```

## 2. Луч, обегающий рамку карточки

```html
<div class="card" style="position:relative">
  <span class="mui-beam" style="--mui-beam-duration:6s"></span>
  …содержимое карточки…
</div>
```

Рамка у карточки должна быть прозрачной (`border-radius` наследуется), луч
рисуется маской поверх.

```css
.mui-beam {
  --mui-beam-size: 50px;
  position: absolute;
  inset: 0;
  border: var(--mui-beam-width, 1px) solid transparent;
  border-radius: inherit;
  pointer-events: none;
  -webkit-mask-image: linear-gradient(transparent, transparent), linear-gradient(#000, #000);
          mask-image: linear-gradient(transparent, transparent), linear-gradient(#000, #000);
  -webkit-mask-clip: padding-box, border-box;
          mask-clip: padding-box, border-box;
  -webkit-mask-composite: xor;
          mask-composite: exclude;
}
.mui-beam__spark {
  position: absolute;
  width: var(--mui-beam-size);
  aspect-ratio: 1;
  background: linear-gradient(
    to left,
    var(--mui-beam-from, #ffaa40),
    var(--mui-beam-to, #9c40ff),
    transparent
  );
  offset-path: rect(0 auto auto 0 round var(--mui-beam-size));
  offset-distance: 0%;
  animation: mui-beam var(--mui-beam-duration, 6s) linear infinite;
}
@keyframes mui-beam {
  to { offset-distance: 100%; }
}
```

## 3. Метеоры в фоне

```html
<section style="position:relative;overflow:hidden">
  <div class="mui-meteors" data-mui-meteors data-count="18"></div>
  …контент секции…
</section>
```

Класс `.mui-meteors` — слой `position:absolute; inset:0`; контент держи выше
(`position:relative; z-index:1`).

```css
.mui-meteors {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.mui-meteor {
  position: absolute;
  top: -5%;
  width: 2px;
  height: 2px;
  border-radius: 9999px;
  background: var(--mui-meteor-color, #71717a);
  box-shadow: 0 0 0 1px #ffffff10;
  pointer-events: none;
  animation: mui-meteor 5s linear infinite;
}
.mui-meteor::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: -1;
  height: 1px;
  width: 50px;
  transform: translateY(-50%);
  background: linear-gradient(to right, var(--mui-meteor-color, #71717a), transparent);
}
@keyframes mui-meteor {
  0%   { transform: rotate(var(--mui-meteor-angle, -215deg)) translateX(0); opacity: 1; }
  70%  { opacity: 1; }
  100% { transform: rotate(var(--mui-meteor-angle, -215deg)) translateX(-500px); opacity: 0; }
}
```

## 4. Числа, которые докручиваются

```html
<span class="mui-ticker" data-mui-ticker data-value="1284">0</span> клиентов
```

Анимация запускается, когда число попало в вид (JS ниже).

```css
.mui-ticker {
  display: inline-block;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
```

## 5. Карточка с пятном света за курсором

```html
<div class="mui-card" data-mui-card>
  <div class="mui-card__inner"></div>
  <div class="mui-card__glow"></div>
  <div class="mui-card__content">…содержимое…</div>
</div>
```

`.mui-card__inner` — фон под содержимым (иначе сквозь карточку видно страницу),
`.mui-card__glow` — пятно, оно следует за курсором.

```css
.mui-card {
  --mui-card-size: 200px;
  --mui-card-from: #9e7aff;
  --mui-card-to: #fe8bbb;
  --mui-card-glow: #262626;
  --mui-card-bg: var(--mui-bg);
  --mui-card-border: var(--mui-border);
  --mui-mx: -200px;
  --mui-my: -200px;

  position: relative;
  isolation: isolate;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: var(--mui-radius);
  background:
    linear-gradient(var(--mui-card-bg) 0 0) padding-box,
    radial-gradient(
      var(--mui-card-size) circle at var(--mui-mx) var(--mui-my),
      var(--mui-card-from),
      var(--mui-card-to),
      var(--mui-card-border) 100%
    ) border-box;
}
.mui-card__inner {
  position: absolute;
  inset: 1px;
  z-index: 20;
  border-radius: inherit;
  background: var(--mui-card-bg);
}
.mui-card__glow {
  position: absolute;
  inset: 1px;
  z-index: 30;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s;
  background: radial-gradient(
    var(--mui-card-size) circle at var(--mui-mx) var(--mui-my),
    var(--mui-card-glow),
    transparent 100%
  );
}
.mui-card:hover .mui-card__glow { opacity: var(--mui-card-glow-opacity, 0.8); }
.mui-card__content { position: relative; z-index: 40; }
```

## 6. Градиентный заголовок

```html
<h1 class="mui-gradient-text" style="--mui-gt-from:#ffaa40;--mui-gt-to:#9c40ff">Заголовок</h1>
```

```css
.mui-gradient-text {
  --mui-gt-from: #ffaa40;
  --mui-gt-to: #9c40ff;
  --mui-gt-size: 300%;
  display: inline;
  background-image: linear-gradient(
    to right,
    var(--mui-gt-from),
    var(--mui-gt-to),
    var(--mui-gt-from)
  );
  background-size: var(--mui-gt-size) 100%;
  background-position: 0 0;
  -webkit-background-clip: text;
          background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  animation: mui-gradient 8s linear infinite;
}
@keyframes mui-gradient {
  to { background-position: var(--mui-gt-size) 0; }
}
```

## 7. Блик, бегущий по рамке

```html
<div class="card" style="position:relative">
  <span class="mui-shine" style="--mui-shine-color:#38bdf8"></span>
  …содержимое…
</div>
```

```css
.mui-shine {
  --mui-shine-width: 1px;
  --mui-shine-color: #000000;
  --mui-shine-duration: 14s;

  position: absolute;
  inset: 0;
  z-index: 5;
  width: 100%;
  height: 100%;
  padding: var(--mui-shine-width);
  border-radius: inherit;
  pointer-events: none;
  will-change: background-position;
  background-image: radial-gradient(
    transparent,
    transparent,
    var(--mui-shine-color),
    transparent,
    transparent
  );
  background-size: 300% 300%;

  -webkit-mask-image: linear-gradient(#fff 0 0), linear-gradient(#fff 0 0);
          mask-image: linear-gradient(#fff 0 0), linear-gradient(#fff 0 0);
  -webkit-mask-clip: content-box, border-box;
          mask-clip: content-box, border-box;
  -webkit-mask-origin: content-box, border-box;
          mask-origin: content-box, border-box;
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  animation: mui-shine var(--mui-shine-duration) infinite linear;
}
@keyframes mui-shine {
  0%   { background-position: 0% 0%; }
  50%  { background-position: 100% 100%; }
  100% { background-position: 0% 0%; }
}
```

## Оживление одним script

Вставь перед `</body>` — этого хватает для метеоров, чисел и подсветки
карточки. Без JS страница остаётся рабочей: эффектов просто нет.

```html
<script>
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Метеоры: положение и задержка вразброс, как в оригинале. */
  document.querySelectorAll('[data-mui-meteors]').forEach((host) => {
    if (reduce) return;
    const count = Math.min(40, Number(host.dataset.count || 20));
    for (let i = 0; i < count; i += 1) {
      const meteor = document.createElement('span');
      meteor.className = 'mui-meteor';
      meteor.style.left = `${Math.random() * 100}%`;
      meteor.style.animationDelay = `${Math.random() * 5}s`;
      meteor.style.animationDuration = `${4 + Math.random() * 4}s`;
      host.appendChild(meteor);
    }
  });

  /* Числа: докручиваем до значения пружиной при первом появлении. */
  const tickers = document.querySelectorAll('[data-mui-ticker]');
  if (tickers.length && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const node = entry.target;
        io.unobserve(node);
        const target = Number(node.dataset.value || 0);
        if (reduce) { node.textContent = target.toLocaleString('ru-RU'); continue; }
        const duration = Number(node.dataset.duration || 1400);
        const start = performance.now();
        const frame = (now) => {
          const p = Math.min(1, (now - start) / duration);
          const eased = 1 - Math.pow(1 - p, 3);
          node.textContent = Math.round(target * eased).toLocaleString('ru-RU');
          if (p < 1) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }
    }, { threshold: 0.4 });
    tickers.forEach((node) => io.observe(node));
  }

  /* Пятно света за курсором — свои координаты у каждой карточки. */
  document.querySelectorAll('[data-mui-card]').forEach((card) => {
    if (reduce) return;
    card.addEventListener('pointermove', (event) => {
      const box = card.getBoundingClientRect();
      card.style.setProperty('--mui-mx', `${event.clientX - box.left}px`);
      card.style.setProperty('--mui-my', `${event.clientY - box.top}px`);
    });
    card.addEventListener('pointerleave', () => {
      card.style.setProperty('--mui-mx', '-200px');
      card.style.setProperty('--mui-my', '-200px');
    });
  });
})();
</script>
```

## Что проверить перед сдачей

- На 390 px нет горизонтальной прокрутки: у `.mui-marquee` ширина не должна
  распирать страницу (он `overflow:hidden`, но проверь).
- С `prefers-reduced-motion` страница не мигает и не пустует.
- Тексты на карточках с `.mui-card__inner` читаемы: фон не прозрачный.
- Ни одного внешнего запроса: ни шрифтов, ни CDN. Только этот файл.

## Источник и лицензия

Magic UI — MIT, https://magicui.design. Кейфреймы и значения взяты из реестра
компонентов и переписаны в CSS-классы; React-обёрток в переносе нет. Полный
код кита лежит в харнессе: `~/.dsh/vendor/magic-ui/dist/` (magicui.css,
magicui.js, BUILD.txt, демо и снимки проверки).
