/* global L */

const map = L.map('map', { zoomControl: false }).setView([55.751, 37.618], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '&copy; OpenStreetMap' }).addTo(map);

const drawnItems = new L.FeatureGroup().addTo(map);
let boundary = null;
let routeLayer = null;
let routeCoordinates = [];
let toastTimer;

map.addControl(new L.Control.Draw({
  position: 'topleft',
  draw: { polyline: false, rectangle: false, circle: false, circlemarker: false, marker: false, polygon: { allowIntersection: false, shapeOptions: { color: '#007d76', fillColor: '#19a092', fillOpacity: .18 } } },
  edit: { featureGroup: drawnItems, edit: true, remove: true }
}));

map.on(L.Draw.Event.CREATED, event => setBoundary(event.layer));
map.on(L.Draw.Event.EDITED, event => {
  const layers = event.layers.getLayers();
  if (layers.length) setBoundary(layers[0], false);
});
map.on(L.Draw.Event.DELETED, () => clearMission());

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-mode]').forEach(item => item.classList.remove('selected'));
  button.classList.add('selected');
  document.getElementById('planBtn').textContent = button.dataset.mode === 'inspection' ? 'Построить точки осмотра' : 'Построить маршрут';
}));

document.getElementById('fileInput').addEventListener('change', importFile);
document.getElementById('clearArea').addEventListener('click', clearMission);
document.getElementById('planBtn').addEventListener('click', () => {
  if (!boundary) return showToast('Сначала задайте контур работ');
  planRoute();
});
document.getElementById('exportBtn').addEventListener('click', exportMission);
document.getElementById('fitBtn').addEventListener('click', () => boundary ? map.fitBounds(boundary.getBounds(), { padding: [40, 40] }) : showToast('Контур работ ещё не задан'));
document.getElementById('locateBtn').addEventListener('click', () => map.locate({ setView: true, maxZoom: 16 }));
map.on('locationerror', () => showToast('Не удалось определить местоположение'));
['altitude', 'speed', 'frontOverlap', 'sideOverlap', 'sensor'].forEach(id => document.getElementById(id).addEventListener('change', () => { if (boundary) planRoute(); }));

function setBoundary(layer, fit = true) {
  drawnItems.clearLayers();
  boundary = layer;
  drawnItems.addLayer(layer);
  if (fit) map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  document.getElementById('emptyState').hidden = true;
  updateArea();
  planRoute();
  setSaved('Изменения сохранены');
}

function clearMission() {
  drawnItems.clearLayers();
  boundary = null;
  routeCoordinates = [];
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = null;
  document.getElementById('emptyState').hidden = false;
  document.getElementById('areaLabel').textContent = '0 га';
  ['summaryArea', 'routeLength', 'flightTime', 'lineCount'].forEach(id => document.getElementById(id).textContent = '--');
  document.getElementById('routeStatus').textContent = 'Нет контура';
}

function updateArea() {
  const area = geodesicArea(boundary.getLatLngs()[0]);
  document.getElementById('areaLabel').textContent = formatArea(area);
  document.getElementById('summaryArea').textContent = formatArea(area);
}

function planRoute() {
  const points = boundary.getLatLngs()[0];
  const sensor = document.getElementById('sensor').value;
  const altitude = +document.getElementById('altitude').value || 120;
  const speed = +document.getElementById('speed').value || 8;
  const sideOverlap = +document.getElementById('sideOverlap').value || 70;
  const swathFactor = { rgb: .68, multispectral: .47, thermal: .52, lidar: 1.1 }[sensor];
  const spacing = Math.max(9, altitude * swathFactor * (1 - sideOverlap / 100));
  routeCoordinates = makeLawnmower(points, spacing);
  if (routeLayer) map.removeLayer(routeLayer);
  if (!routeCoordinates.length) return showToast('Не удалось построить маршрут для этого контура');
  routeLayer = L.polyline(routeCoordinates, { color: '#115f9e', weight: 2.5, opacity: .9, lineJoin: 'round' }).addTo(map);
  const distance = polylineLength(routeCoordinates);
  document.getElementById('routeLength').textContent = distance >= 1000 ? `${(distance / 1000).toFixed(2)} км` : `${Math.round(distance)} м`;
  document.getElementById('flightTime').textContent = formatTime(distance / speed);
  document.getElementById('lineCount').textContent = `${Math.ceil(routeCoordinates.length / 2)} шт.`;
  document.getElementById('routeStatus').textContent = 'Маршрут готов';
}

// Uses a local meter coordinate system around the field, then clips every survey line to the polygon.
function makeLawnmower(latlngs, spacing) {
  const center = boundary.getBounds().getCenter();
  const scaleY = 111320;
  const scaleX = scaleY * Math.cos(center.lat * Math.PI / 180);
  const polygon = latlngs.map(p => [(p.lng - center.lng) * scaleX, (p.lat - center.lat) * scaleY]);
  const ys = polygon.map(p => p[1]);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const output = [];
  let reverse = false;
  for (let y = minY + spacing / 2; y < maxY; y += spacing) {
    const hits = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) hits.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    hits.sort((a, b) => a - b);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const segment = [[hits[i], y], [hits[i + 1], y]];
      if (reverse) segment.reverse();
      segment.forEach(p => output.push([p[1] / scaleY + center.lat, p[0] / scaleX + center.lng]));
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
    let coordinates;
    if (/\.kml$/i.test(file.name)) coordinates = parseKml(text);
    else coordinates = parseGeoJson(JSON.parse(text));
    if (!coordinates || coordinates.length < 3) throw new Error('polygon');
    setBoundary(L.polygon(coordinates, { color: '#007d76', fillColor: '#19a092', fillOpacity: .18 }));
    showToast(`Контур «${file.name}» импортирован`);
  } catch (_) { showToast('Файл должен содержать полигон GeoJSON или KML'); }
  event.target.value = '';
}

function parseGeoJson(data) {
  const feature = data.type === 'FeatureCollection' ? data.features.find(f => /Polygon/.test(f.geometry?.type)) : data.type === 'Feature' ? data : { geometry: data };
  const geometry = feature?.geometry;
  if (!geometry || !/Polygon/.test(geometry.type)) return null;
  const ring = geometry.type === 'MultiPolygon' ? geometry.coordinates[0][0] : geometry.coordinates[0];
  return ring.map(([lng, lat]) => [lat, lng]);
}
function parseKml(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const node = xml.querySelector('Polygon coordinates, LinearRing coordinates');
  if (!node) return null;
  return node.textContent.trim().split(/\s+/).map(item => { const [lng, lat] = item.split(',').map(Number); return [lat, lng]; });
}
function geodesicArea(points) { let sum = 0; for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; sum += (b.lng - a.lng) * Math.PI / 180 * (2 + Math.sin(a.lat * Math.PI / 180) + Math.sin(b.lat * Math.PI / 180)); } return Math.abs(sum * 6378137 ** 2 / 2); }
function polylineLength(points) { return points.slice(1).reduce((sum, p, i) => sum + L.latLng(points[i]).distanceTo(p), 0); }
function formatArea(area) { return area > 9999 ? `${(area / 10000).toFixed(2)} га` : `${Math.round(area)} м²`; }
function formatTime(seconds) { const minutes = Math.max(1, Math.round(seconds / 60)); return minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes} мин`; }
function exportMission() {
  if (!boundary || !routeCoordinates.length) return showToast('Постройте маршрут перед экспортом');
  const data = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'Контур работ', mission: document.querySelector('.mission-title input').value }, geometry: { type: 'Polygon', coordinates: [boundary.getLatLngs()[0].map(p => [p.lng, p.lat])] } },
    { type: 'Feature', properties: { name: 'Маршрут съёмки', altitude_m: +document.getElementById('altitude').value, speed_ms: +document.getElementById('speed').value, sensor: document.getElementById('sensor').value }, geometry: { type: 'LineString', coordinates: routeCoordinates.map(([lat, lng]) => [lng, lat]) } }
  ] };
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' })); link.download = 'geoscan-mission.geojson'; link.click(); URL.revokeObjectURL(link.href); showToast('Маршрут экспортирован');
}
function setSaved(text) { document.getElementById('saveState').textContent = text; setTimeout(() => document.getElementById('saveState').textContent = 'Сохранено', 1800); }
function showToast(text) { const toast = document.getElementById('toast'); toast.textContent = text; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600); }
