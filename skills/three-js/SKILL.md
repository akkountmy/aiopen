---
name: 3D-сцена three.js
description: Как собрать интерактивную 3D-страницу на three.js (r186, локальный бандл /vendor/three.global.js) — процедурная сцена, свет, тонмаппинг, OrbitControls, проверка запуска.
---

# 3D-сцена на three.js

## Когда открывать
«3D», «three.js», «трёхмерная сцена», «вращающаяся модель», «визуализация в объёме»,
«план помещения в 3D», «WebGL-страница». Не для плоских диаграмм — там хватает SVG/HTML.

## Как подключать
Бандл уже лежит в сервисе: `/vendor/three.global.js` — классический скрипт,
отдаёт глобальный `window.THREE` (версия r186) и `window.lil`.
Никаких CDN, `import`, `type="module"` и сборщиков.

Порядок работы:
1. `use_skill("three-js")` — эта инструкция (если открыл её не через инструмент).
2. `write_file` с HTML-страницей сцены (одним файлом, до 8 КБ; больше — `append_file`).
3. Скажи пользователю имя файла: он откроется в новой вкладке браузера.

Каркас страницы:

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>3D-сцена</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#0b0d12;color:#e8eaf0;font:14px/1.4 system-ui,sans-serif}
  canvas{display:block}
  #hud{position:fixed;left:16px;bottom:14px;opacity:.7;pointer-events:none}
  #err{position:fixed;left:16px;top:16px;right:16px;padding:10px 12px;background:#7a1f1f;border-radius:8px;display:none;white-space:pre-wrap}
</style>
</head>
<body>
<div id="hud">ЛКМ — вращать, колесо — масштаб, ПКМ — сдвиг</div>
<div id="err"></div>
<script>
  window.addEventListener('error', (e) => {
    const box = document.getElementById('err');
    box.style.display = 'block';
    box.textContent = 'Ошибка сцены: ' + (e.message || e.error);
  });
</script>
<script src="/vendor/three.global.js"></script>
<script>
  const THREE = window.THREE;
  /* … сцена … */
</script>
</body>
</html>
```

## Каркас сцены (проверенный набор настроек)

```js
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);
scene.fog = new THREE.Fog(0x0b0d12, 18, 60);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
camera.position.set(6, 5, 9);

scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x1b2230, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(8, 14, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6ea8ff, 0.8);
rim.position.set(-9, 6, -8);
scene.add(rim);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 3;
controls.maxDistance = 40;
controls.maxPolarAngle = Math.PI * 0.495;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
```

## Что доступно в бандле
`Scene, PerspectiveCamera, WebGLRenderer, Mesh, Group, Object3D, BufferGeometry,
BoxGeometry, SphereGeometry, CylinderGeometry, PlaneGeometry, TorusGeometry,
ExtrudeGeometry, LatheGeometry, Shape, Path, Curve, TubeGeometry, InstancedMesh,
MeshStandardMaterial, MeshPhysicalMaterial, MeshBasicMaterial, LineBasicMaterial,
Line, LineSegments, Points, PointsMaterial, Color, Vector2/3, Quaternion, Euler,
Matrix4, Raycaster, Clock, Sphere, Box3, DirectionalLight, AmbientLight,
HemisphereLight, PointLight, SpotLight, RectAreaLight, Fog, FogExp2,
CanvasTexture, TextureLoader, GridHelper, AxesHelper, ArrowHelper, PCFSoftShadowMap,
ACESFilmicToneMapping, SRGBColorSpace, MathUtils, ShapeUtils, BufferGeometryUtils`
+ `OrbitControls`, `GLTFLoader`, `DRACOLoader`, `KTX2Loader`, `RGBELoader`,
`EffectComposer`, `RenderPass`, `UnrealBloomPass`, `OutputPass`, `CSS2DRenderer`.

## Правила, которые спасают сцену
- **Только процедурная геометрия.** Загрузка `.glb`/`.hdr` из внешней сети запрещена:
  файлов в проекте нет, CORS и офлайн всё сломают.
- Тени включаются вместе: `renderer.shadowMap.enabled = true` **и** `mesh.castShadow/receiveShadow`.
- Плоский «пол» без `receiveShadow` выглядит как наклейка — добавь плоскость и `GridHelper`.
- Материалы — `MeshStandardMaterial` с `roughness` 0,3–0,9; `metalness` выше 0,6 без окружения выглядит чёрным.
- Камеру ставь по диагонали, а не строго спереди; `controls.target` — на центр композиции.
- DPR выше 2 не поднимай: ноутбук с 3D умирает от перерисовки.
- Сцену собирай из функций-помощников (`makeBox`, `makePipe`) и `InstancedMesh`, когда деталей больше 100.
- Анимацию вешай на `renderer.setAnimationLoop`, не на `requestAnimationFrame` в цикле.

## Проверка перед сдачей
1. Файл создан через `write_file` с расширением `.html` (не `.js`).
2. В нём есть `<script src="/vendor/three.global.js">` до кода сцены.
3. Есть обработчик `window.onerror` — если пользователь увидит красную плашку, он пришлёт текст ошибки, и это быстрый путь к починке.
4. Нет внешних ссылок (`https://`, `unpkg`, `cdn`, `jsdelivr`) и нет `type="module"`.
5. Открой для себя список деталей сцены и назови пользователю: имя файла, управление, что видно.

## Частые причины чёрного экрана
| Симптом | Причина |
|---|---|
| чёрный/пустой экран | `<script src>` стоит после кода сцены или путь не `/vendor/three.global.js` |
| «THREE is not defined» | использован `type="module"` с импортом вместо глобального бандла |
| сцена есть, но объектов нет | объекты добавлены не в `scene`, а в локальную переменную |
| всё чёрное при `metalness: 1` | нет окружения (`scene.environment`); поставь `metalness ≤ 0,5` |
| нет теней | забыт `castShadow` у света или `receiveShadow` у плоскости |
| дёргается | DPR не ограничен, либо тени 4096 без нужды |

## Имя файла
`3D-сцена.html`, `Макет офиса 3D.html`. Коротко, по-русски, с расширением.
