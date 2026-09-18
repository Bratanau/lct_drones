# Geoscan Planner

Локальный планировщик полетных миссий для геосъемки. Проект включает браузерный интерфейс на Leaflet, детерминированный геометрический планировщик и SQLite API без отдельного backend-сервиса.

## Возможности

- создание и сохранение миссий в SQLite;
- режимы `survey`, `inspection`, `corridor` и `lidar`;
- `Polygon`, `MultiPolygon`, отверстия и `LineString` для коридорных миссий;
- оптимизация направления сетки по нескольким углам;
- проверка сегментов маршрута внутри рабочей области;
- оценка времени, дальности, аккумуляторов и числа вылетов;
- платформенные ограничения по высоте, скорости и дальности;
- история версий миссии;
- дублирование миссий;
- экспорт GeoJSON, KML, CSV и нейтрального waypoint JSON;
- локальная работа без облачной БД и внешнего API.

## Требования

- Node.js 20 или новее;
- npm 10 или новее;
- Python 3.11 или новее для геометрического ядра;
- зависимости Python из `requirements.txt`.

## Запуск

```powershell
npm install
npm start
```

После запуска откройте <http://127.0.0.1:4173/>.

По умолчанию SQLite-файл создается в `data/geoscan.db`. Другой путь можно указать через `GEOSCAN_DB`:

```powershell
$env:GEOSCAN_DB = "$PWD\data\local.db"
npm start
```

```powershell
python -m pip install -r requirements.txt
python -m src.geometry.geometry_processor
```

Node отвечает только за HTTP, SQLite и экспорт. Все расчеты геометрии, проекции, нарезка галсов, длины маршрутов и разбиение на вылеты выполняются Python-планировщиком.

Остановить фоновый процесс Node.js в PowerShell:

```powershell
Get-Process -Name node | Stop-Process -Force
```

## Проверка

```powershell
npm test
npm run format:check
```

```powershell
python -m unittest discover -s test -p "test_*.py"
```

Форматирование исходников:

```powershell
npm run format
```

## Архитектура

```text
src/
  server.js             HTTP-сервер и REST API
  database.js           SQLite-схема и начальные пресеты
  geometry/
    __init__.py           пакет геометрического ядра
    models.py             Pydantic-модели и ошибки
    projection.py         WGS84/UTM и трансформации
    track_slicer.py       отдельная логика нарезки галсов
    geometry_processor.py выбор направления и форматирование галсов
    service.py            JSON subprocess-контракт для Node API
  public/
    index.html            интерфейс
    app.js                клиентская логика Leaflet/API
    styles.css            стили интерфейса
test/
  api.test.js             CRUD, Python-планировщик, версии и экспорт
  test_geometry_processor.py Python-валидация и геометрическое ядро
```

Сервер намеренно оставлен тонким: Node обрабатывает HTTP, SQLite и экспорт, а единственный источник сложной геометрической логики — Python-пакет `src.geometry`. Node запускает его через JSON stdin/stdout, поэтому этот же пакет можно напрямую подключить к FastAPI.

## API

### Миссии

- `GET /api/missions` — список миссий;
- `POST /api/missions` — создать миссию и построить план;
- `GET /api/missions/:id` — получить миссию;
- `PUT /api/missions/:id` — пересчитать и обновить миссию;
- `DELETE /api/missions/:id` — удалить миссию;
- `GET /api/missions/:id/versions` — история версий;
- `POST /api/missions/:id/duplicate` — создать копию со статусом `draft`;
- `GET /api/missions/:id/export?format=geojson|kml|csv|waypoints` — экспорт.

### Справочники

- `GET /api/platforms` — доступные платформы;
- `GET /api/sensor-presets` — пресеты сенсоров.

Пример тела миссии:

```json
{
  "title": "Полевой участок",
  "mode": "survey",
  "platformId": "generic-quad",
  "boundary": [
    [55.75, 37.61],
    [55.75, 37.63],
    [55.76, 37.63]
  ],
  "settings": {
    "sensor": "rgb",
    "altitude": 120,
    "speed": 8,
    "frontOverlap": 75,
    "sideOverlap": 70
  }
}
```

Для GeoJSON можно передать `geometry` вместо `boundary`. Поддерживаются `Polygon`, `MultiPolygon` и `LineString`.

## Ограничения и ответственность

Планировщик использует локальную метрическую аппроксимацию и не подключен к реальному DEM, NOTAM, базам аэродромов или актуальным геозонам. При отсутствии DEM сервер выдает предупреждение. Перед реальным полетом необходимо проверить маршрут по официальным данным, ограничениям платформы и требованиям оператора.

LLM в расчете траектории не используется: маршрут строится детерминированно, чтобы его можно было воспроизвести и проверить тестами.
