/* global L */
const STORAGE_KEY = 'geoscan-planner-mission-v1';
const map = L.map('map', { zoomControl: false }).setView([55.751, 37.618], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '&copy; OpenStreetMap' }).addTo(map);

const drawnItems = new L.FeatureGroup().addTo(map);
let boundary = null;
let routeLayer = null;
let routeSegments = [];
let missionId = localStorage.getItem('geoscan-planner-server-id');
let toastTimer;

map.addControl(new L.Control.Draw({
  position: 'topleft',
  draw: { polyline: false, rectangle: false, circle: false, circlemarker: false, marker: false, polygon: { allowIntersection: false, shapeOptions: { color: '#007d76', fillColor: '#19a092', fillOpacity: .18 } } },
  edit: { featureGroup: drawnItems, edit: true, remove: true }
}));
map.on(L.Draw.Event.CREATED, event => setBoundary(event.layer));
map.on(L.Draw.Event.EDITED, event => { const layers = event.layers.getLayers(); if (layers.length) setBoundary(layers[0], false); });
map.on(L.Draw.Event.DELETED, () => clearMission());
map.on('locationerror', () => showToast('Не удалось определить местоположение'));

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-mode]').forEach(item => item.classList.remove('selected'));
  button.classList.add('selected');
  document.getElementById('planBtn').textContent = button.dataset.mode === 'inspection' ? 'Построить точки осмотра' : 'Построить маршрут';
  saveMission();
}));
document.getElementById('fileInput').addEventListener('change', importFile);
document.getElementById('demoArea').addEventListener('click', loadDemoArea);
document.getElementById('clearArea').addEventListener('click', clearMission);
document.getElementById('planBtn').addEventListener('click', () => boundary ? planRoute() : showToast('Сначала задайте контур работ'));
document.getElementById('exportBtn').addEventListener('click', exportMission);
document.getElementById('fitBtn').addEventListener('click', () => boundary ? map.fitBounds(boundary.getBounds(), { padding: [40, 40] }) : showToast('Контур работ ещё не задан'));
document.getElementById('locateBtn').addEventListener('click', () => map.locate({ setView: true, maxZoom: 16 }));
['altitude', 'speed', 'frontOverlap', 'sideOverlap', 'sensor'].forEach(id => document.getElementById(id).addEventListener('change', () => { if (boundary) planRoute(); saveMission(); }));
document.querySelector('.mission-title input').addEventListener('change', saveMission);
loadMission();

function setBoundary(layer, fit = true) {
  drawnItems.clearLayers();
  boundary = layer;
  drawnItems.addLayer(layer);
  if (fit) map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  document.getElementById('emptyState').hidden = true;
  updateArea();
  planRoute();
  saveMission();
}

function clearMission() {
  drawnItems.clearLayers();
  boundary = null;
  routeSegments = [];
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = null;
  document.getElementById('emptyState').hidden = false;
  document.getElementById('areaLabel').textContent = '0 га';
  ['summaryArea', 'routeLength', 'flightTime', 'lineCount'].forEach(id => document.getElementById(id).textContent = '--');
  document.getElementById('routeStatus').textContent = 'Нет контура';
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem('geoscan-planner-server-id');
  missionId = null;
  setSaved('Миссия очищена');
}

function updateArea() {
  const area = geodesicArea(boundary.getLatLngs()[0]);
  document.getElementById('areaLabel').textContent = formatArea(area);
  document.getElementById('summaryArea').textContent = formatArea(area);
}

async function planRoute() {
  const payload = missionPayload();
  setSaved('Расчёт на сервере...');
  try {
    const response = await fetch(missionId ? `/api/missions/${missionId}` : '/api/missions', { method: missionId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.errors?.join(' ') || result.error);
    missionId = result.id;
    localStorage.setItem('geoscan-planner-server-id', missionId);
    renderServerPlan(result.plan);
    setSaved('Сохранено на сервере');
  } catch (error) {
    setSaved('Локальный расчёт');
    showToast(`Сервер недоступен: ${error.message}`);
    renderLocalPlan();
  }
}

function renderServerPlan(plan) {
  routeSegments = plan.segments;
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.polyline(routeSegments, { color: '#115f9e', weight: 2.5, opacity: .9, lineJoin: 'round' }).addTo(map);
  document.getElementById('areaLabel').textContent = formatArea(plan.areaM2);
  document.getElementById('summaryArea').textContent = formatArea(plan.areaM2);
  document.getElementById('routeLength').textContent = plan.totalDistanceM >= 1000 ? `${(plan.totalDistanceM / 1000).toFixed(2)} км` : `${Math.round(plan.totalDistanceM)} м`;
  document.getElementById('flightTime').textContent = formatTime(plan.durationSeconds);
  document.getElementById('lineCount').textContent = `${routeSegments.length} шт.`;
  document.getElementById('routeStatus').textContent = plan.battery.flights > 1 ? `${plan.battery.flights} вылета` : 'Маршрут готов';
  if (plan.recommendations?.length) showToast(plan.recommendations[0]);
}

function renderLocalPlan() {
  const points = boundary.getLatLngs()[0];
  const altitude = +document.getElementById('altitude').value || 120;
  const speed = +document.getElementById('speed').value || 8;
  const sideOverlap = +document.getElementById('sideOverlap').value || 70;
  const factor = { rgb: .68, multispectral: .47, thermal: .52, lidar: 1.1 }[document.getElementById('sensor').value];
  routeSegments = makeLawnmower(points, Math.max(9, altitude * factor * (1 - sideOverlap / 100)));
  if (routeLayer) map.removeLayer(routeLayer);
  if (!routeSegments.length) return showToast('Не удалось построить маршрут для этого контура');
  routeLayer = L.polyline(routeSegments, { color: '#115f9e', weight: 2.5, opacity: .9, lineJoin: 'round' }).addTo(map);
  const distance = routeSegments.reduce((total, segment) => total + polylineLength(segment), 0);
  document.getElementById('routeLength').textContent = distance >= 1000 ? `${(distance / 1000).toFixed(2)} км` : `${Math.round(distance)} м`;
  document.getElementById('flightTime').textContent = formatTime(distance / speed);
  document.getElementById('lineCount').textContent = `${routeSegments.length} шт.`;
  document.getElementById('routeStatus').textContent = 'Локальный план';
}

// A local meter grid provides stable line spacing. Every line is clipped to the polygon as a separate segment.
function makeLawnmower(latlngs, spacing) {
  const center = boundary.getBounds().getCenter();
  const scaleY = 111320;
  const scaleX = scaleY * Math.cos(center.lat * Math.PI / 180);
  const polygon = latlngs.map(p => [(p.lng - center.lng) * scaleX, (p.lat - center.lat) * scaleY]);
  const ys = polygon.map(p => p[1]);
  const output = [];
  let reverse = false;
  for (let y = Math.min(...ys) + spacing / 2; y < Math.max(...ys); y += spacing) {
    const hits = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) hits.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    hits.sort((a, b) => a - b);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const segment = [[hits[i], y], [hits[i + 1], y]];
      if (reverse) segment.reverse();
      output.push(segment.map(p => [p[1] / scaleY + center.lat, p[0] / scaleX + center.lng]));
      reverse = !reverse;
    }
  }
  return output;
}

async function importFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const coordinates = /\.kml$/i.test(file.name) ? parseKml(text) : parseGeoJson(JSON.parse(text));
    if (!coordinates || coordinates.length < 3) throw new Error('polygon');
    setBoundary(L.polygon(coordinates, { color: '#007d76', fillColor: '#19a092', fillOpacity: .18 }));
    showToast(`Контур «${file.name}» импортирован`);
  } catch (_) { showToast('Файл должен содержать полигон GeoJSON или KML'); }
  event.target.value = '';
}
function parseGeoJson(data) {
  const feature = data.type === 'FeatureCollection' ? data.features.find(item => /Polygon/.test(item.geometry?.type)) : data.type === 'Feature' ? data : { geometry: data };
  const geometry = feature?.geometry;
  if (!geometry || !/Polygon/.test(geometry.type)) return null;
  const ring = geometry.type === 'MultiPolygon' ? geometry.coordinates[0][0] : geometry.coordinates[0];
  return ring.map(([lng, lat]) => [lat, lng]);
}
function parseKml(text) {
  const node = new DOMParser().parseFromString(text, 'application/xml').querySelector('Polygon coordinates, LinearRing coordinates');
  return node ? node.textContent.trim().split(/\s+/).map(item => { const [lng, lat] = item.split(',').map(Number); return [lat, lng]; }) : null;
}
function loadDemoArea() {
  const demo = [[55.7805, 37.599], [55.7837, 37.617], [55.7786, 37.628], [55.7732, 37.624], [55.7718, 37.609], [55.7761, 37.602]];
  document.querySelector('.mission-title input').value = 'Демо: Мнёвниковская пойма';
  setBoundary(L.polygon(demo, { color: '#007d76', fillColor: '#19a092', fillOpacity: .18 }));
  showToast('Демонстрационный участок загружен');
}
function missionPayload() {
  const settings = ['sensor', 'altitude', 'speed', 'frontOverlap', 'sideOverlap'].reduce((result, id) => ({ ...result, [id]: document.getElementById(id).value }), {});
  return { title: document.querySelector('.mission-title input').value, mode: document.querySelector('[data-mode].selected').dataset.mode, settings, boundary: boundary.getLatLngs()[0].map(point => [point.lat, point.lng]) };
}

function saveMission() {
  const settings = ['sensor', 'altitude', 'speed', 'frontOverlap', 'sideOverlap'].reduce((result, id) => ({ ...result, [id]: document.getElementById(id).value }), {});
  const data = { title: document.querySelector('.mission-title input').value, settings, boundary: boundary?.getLatLngs()[0].map(point => [point.lat, point.lng]) ?? null };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  setSaved('Локально сохранено');
}
function loadMission() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!data) return;
    document.querySelector('.mission-title input').value = data.title || 'Новая миссия';
    Object.entries(data.settings || {}).forEach(([id, value]) => { const input = document.getElementById(id); if (input) input.value = value; });
    if (Array.isArray(data.boundary) && data.boundary.length >= 3) setBoundary(L.polygon(data.boundary, { color: '#007d76', fillColor: '#19a092', fillOpacity: .18 }));
  } catch (_) { localStorage.removeItem(STORAGE_KEY); }
}
function geodesicArea(points) { let sum = 0; for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; sum += (b.lng - a.lng) * Math.PI / 180 * (2 + Math.sin(a.lat * Math.PI / 180) + Math.sin(b.lat * Math.PI / 180)); } return Math.abs(sum * 6378137 ** 2 / 2); }
function polylineLength(points) { return points.slice(1).reduce((sum, point, index) => sum + L.latLng(points[index]).distanceTo(point), 0); }
function formatArea(area) { return area > 9999 ? `${(area / 10000).toFixed(2)} га` : `${Math.round(area)} м²`; }
function formatTime(seconds) { const minutes = Math.max(1, Math.round(seconds / 60)); return minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes} мин`; }
function exportMission() {
  if (missionId) return window.open(`/api/missions/${missionId}/export`, '_blank', 'noopener');
  if (!boundary || !routeSegments.length) return showToast('Постройте маршрут перед экспортом');
  const data = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'Контур работ', mission: document.querySelector('.mission-title input').value }, geometry: { type: 'Polygon', coordinates: [boundary.getLatLngs()[0].map(point => [point.lng, point.lat])] } },
    { type: 'Feature', properties: { name: 'Маршрут съёмки', altitude_m: +document.getElementById('altitude').value, speed_ms: +document.getElementById('speed').value, sensor: document.getElementById('sensor').value }, geometry: { type: 'MultiLineString', coordinates: routeSegments.map(segment => segment.map(([lat, lng]) => [lng, lat])) } }
  ] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'geoscan-mission.geojson'; link.click(); URL.revokeObjectURL(url); showToast('Маршрут экспортирован');
}
function setSaved(text) { document.getElementById('saveState').textContent = text; }
function showToast(text) { const toast = document.getElementById('toast'); toast.textContent = text; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600); }
