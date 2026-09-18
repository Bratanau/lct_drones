/* global L */
const STORAGE_KEY = "geoscan-planner-mission-v1";
const map = L.map("map", { zoomControl: false }).setView([55.751, 37.618], 12);
L.control.zoom({ position: "bottomright" }).addTo(map);
const baseLayer = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap",
    crossOrigin: true,
  },
).addTo(map);
baseLayer.on("tileerror", () => {
  showToast("Базовая карта недоступна: проверьте интернет-соединение");
});

const drawnItems = new L.FeatureGroup().addTo(map);
let boundary = null;
let routeLayer = null;
let routeSegments = [];
let missionId = localStorage.getItem("geoscan-planner-server-id");
let platforms = [];
let toastTimer;

map.addControl(
  new L.Control.Draw({
    position: "topleft",
    draw: {
      polyline: false,
      rectangle: false,
      circle: false,
      circlemarker: false,
      marker: false,
      polygon: {
        allowIntersection: false,
        shapeOptions: {
          color: "#007d76",
          fillColor: "#19a092",
          fillOpacity: 0.18,
        },
      },
    },
    edit: { featureGroup: drawnItems, edit: true, remove: true },
  }),
);
map.on(L.Draw.Event.CREATED, (event) => setBoundary(event.layer));
map.on(L.Draw.Event.EDITED, (event) => {
  const layers = event.layers.getLayers();
  if (layers.length) setBoundary(layers[0], false);
});
map.on(L.Draw.Event.DELETED, () => clearMission());
map.on("locationerror", () =>
  showToast("Не удалось определить местоположение"),
);

document.querySelectorAll("[data-mode]").forEach((button) =>
  button.addEventListener("click", () => {
    document
      .querySelectorAll("[data-mode]")
      .forEach((item) => item.classList.remove("selected"));
    button.classList.add("selected");
    document.getElementById("planBtn").textContent =
      button.dataset.mode === "inspection"
        ? "Построить точки осмотра"
        : button.dataset.mode === "corridor"
          ? "Построить коридорный маршрут"
          : button.dataset.mode === "lidar"
            ? "Построить LiDAR-маршрут"
            : "Построить маршрут";
    saveMission();
  }),
);
document.getElementById("fileInput").addEventListener("change", importFile);
document
  .getElementById("missionSelect")
  .addEventListener("change", (event) =>
    event.target.value ? openMission(event.target.value) : newMission(),
  );
document.getElementById("platformSelect").addEventListener("change", () => {
  updatePlatformInfo();
  if (boundary) planRoute();
});
document
  .getElementById("duplicateBtn")
  .addEventListener("click", duplicateMission);
document.getElementById("demoArea").addEventListener("click", loadDemoArea);
document.getElementById("clearArea").addEventListener("click", clearMission);
document
  .getElementById("planBtn")
  .addEventListener("click", () =>
    boundary ? planRoute() : showToast("Сначала задайте контур работ"),
  );
document.getElementById("exportBtn").addEventListener("click", exportMission);
document
  .getElementById("fitBtn")
  .addEventListener("click", () =>
    boundary
      ? map.fitBounds(boundary.getBounds(), { padding: [40, 40] })
      : showToast("Контур работ ещё не задан"),
  );
document
  .getElementById("locateBtn")
  .addEventListener("click", () => map.locate({ setView: true, maxZoom: 16 }));
["altitude", "speed", "frontOverlap", "sideOverlap", "sensor"].forEach((id) =>
  document.getElementById(id).addEventListener("change", () => {
    if (boundary) planRoute();
    saveMission();
  }),
);
document
  .querySelector(".mission-title input")
  .addEventListener("change", saveMission);
loadMission();
loadServerData();

function setBoundary(layer, fit = true) {
  drawnItems.clearLayers();
  boundary = layer;
  drawnItems.addLayer(layer);
  if (fit) map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  document.getElementById("emptyState").hidden = true;
  document.getElementById("areaLabel").textContent = "--";
  document.getElementById("summaryArea").textContent = "--";
  planRoute();
  saveMission();
}

function clearMission() {
  drawnItems.clearLayers();
  boundary = null;
  routeSegments = [];
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = null;
  document.getElementById("emptyState").hidden = false;
  document.getElementById("areaLabel").textContent = "0 га";
  ["summaryArea", "routeLength", "flightTime", "lineCount"].forEach(
    (id) => (document.getElementById(id).textContent = "--"),
  );
  document.getElementById("routeStatus").textContent = "Нет контура";
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("geoscan-planner-server-id");
  missionId = null;
  setSaved("Миссия очищена");
}

async function planRoute() {
  const payload = missionPayload();
  setSaved("Расчёт на сервере...");
  try {
    const response = await fetch(
      missionId ? `/api/missions/${missionId}` : "/api/missions",
      {
        method: missionId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.errors?.join(" ") || result.error);
    missionId = result.id;
    localStorage.setItem("geoscan-planner-server-id", missionId);
    renderServerPlan(result.plan);
    setSaved("Сохранено на сервере");
  } catch (error) {
    setSaved("Ошибка сервера");
    showToast(`Python-планировщик недоступен: ${error.message}`);
  }
}

function renderServerPlan(plan) {
  routeSegments = plan.segments;
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.featureGroup([
    L.polyline(routeSegments, {
      color: "#115f9e",
      weight: 2.5,
      opacity: 0.9,
      lineJoin: "round",
    }),
    ...(plan.points || []).map((point) =>
      L.circleMarker(point, {
        radius: 4,
        color: "#ec7745",
        fillColor: "#ec7745",
        fillOpacity: 0.9,
      }),
    ),
  ]).addTo(map);
  document.getElementById("areaLabel").textContent = formatArea(plan.areaM2);
  document.getElementById("summaryArea").textContent = formatArea(plan.areaM2);
  document.getElementById("routeLength").textContent =
    plan.totalDistanceM >= 1000
      ? `${(plan.totalDistanceM / 1000).toFixed(2)} км`
      : `${Math.round(plan.totalDistanceM)} м`;
  document.getElementById("flightTime").textContent = formatTime(
    plan.durationSeconds,
  );
  document.getElementById("lineCount").textContent =
    `${routeSegments.length} шт.`;
  document.getElementById("routeStatus").textContent =
    plan.flights.length > 1 ? `${plan.flights.length} вылета` : "Маршрут готов";
  if (plan.recommendations?.length) showToast(plan.recommendations[0]);
}

async function importFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const coordinates = /\.kml$/i.test(file.name)
      ? parseKml(text)
      : parseGeoJson(JSON.parse(text));
    if (!coordinates || coordinates.length < 3) throw new Error("polygon");
    setBoundary(
      L.polygon(coordinates, {
        color: "#007d76",
        fillColor: "#19a092",
        fillOpacity: 0.18,
      }),
    );
    showToast(`Контур «${file.name}» импортирован`);
  } catch (_) {
    showToast("Файл должен содержать полигон GeoJSON или KML");
  }
  event.target.value = "";
}
function parseGeoJson(data) {
  const feature =
    data.type === "FeatureCollection"
      ? data.features.find((item) => /Polygon/.test(item.geometry?.type))
      : data.type === "Feature"
        ? data
        : { geometry: data };
  const geometry = feature?.geometry;
  if (!geometry || !/Polygon/.test(geometry.type)) return null;
  const ring =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates[0][0]
      : geometry.coordinates[0];
  return ring.map(([lng, lat]) => [lat, lng]);
}
function parseKml(text) {
  const node = new DOMParser()
    .parseFromString(text, "application/xml")
    .querySelector("Polygon coordinates, LinearRing coordinates");
  return node
    ? node.textContent
        .trim()
        .split(/\s+/)
        .map((item) => {
          const [lng, lat] = item.split(",").map(Number);
          return [lat, lng];
        })
    : null;
}
function loadDemoArea() {
  const demo = [
    [55.7805, 37.599],
    [55.7837, 37.617],
    [55.7786, 37.628],
    [55.7732, 37.624],
    [55.7718, 37.609],
    [55.7761, 37.602],
  ];
  document.querySelector(".mission-title input").value =
    "Демо: Мнёвниковская пойма";
  setBoundary(
    L.polygon(demo, {
      color: "#007d76",
      fillColor: "#19a092",
      fillOpacity: 0.18,
    }),
  );
  showToast("Демонстрационный участок загружен");
}
function missionPayload() {
  const settings = [
    "sensor",
    "altitude",
    "speed",
    "frontOverlap",
    "sideOverlap",
  ].reduce(
    (result, id) => ({ ...result, [id]: document.getElementById(id).value }),
    {},
  );
  return {
    title: document.querySelector(".mission-title input").value,
    mode: document.querySelector("[data-mode].selected").dataset.mode,
    platformId:
      document.getElementById("platformSelect").value || "generic-quad",
    settings,
    boundary: boundary.getLatLngs()[0].map((point) => [point.lat, point.lng]),
  };
}

function saveMission() {
  const settings = [
    "sensor",
    "altitude",
    "speed",
    "frontOverlap",
    "sideOverlap",
  ].reduce(
    (result, id) => ({ ...result, [id]: document.getElementById(id).value }),
    {},
  );
  const data = {
    title: document.querySelector(".mission-title input").value,
    settings,
    boundary:
      boundary?.getLatLngs()[0].map((point) => [point.lat, point.lng]) ?? null,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  setSaved("Локально сохранено");
}
function loadMission() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!data) return;
    document.querySelector(".mission-title input").value =
      data.title || "Новая миссия";
    Object.entries(data.settings || {}).forEach(([id, value]) => {
      const input = document.getElementById(id);
      if (input) input.value = value;
    });
    if (Array.isArray(data.boundary) && data.boundary.length >= 3)
      setBoundary(
        L.polygon(data.boundary, {
          color: "#007d76",
          fillColor: "#19a092",
          fillOpacity: 0.18,
        }),
      );
  } catch (_) {
    localStorage.removeItem(STORAGE_KEY);
  }
}
function formatArea(area) {
  return area > 9999
    ? `${(area / 10000).toFixed(2)} га`
    : `${Math.round(area)} м²`;
}
function formatTime(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
    : `${minutes} мин`;
}
function exportMission() {
  if (!missionId) return showToast("Сначала постройте и сохраните маршрут");
  return window.open(
    `/api/missions/${missionId}/export?format=${document.getElementById("exportFormat").value}`,
    "_blank",
    "noopener",
  );
}
async function loadServerData() {
  try {
    const [missionsResponse, platformsResponse] = await Promise.all([
      fetch("/api/missions"),
      fetch("/api/platforms"),
    ]);
    if (!missionsResponse.ok || !platformsResponse.ok)
      throw new Error("API недоступен");
    const [missions, platformData] = await Promise.all([
      missionsResponse.json(),
      platformsResponse.json(),
    ]);
    const missionSelect = document.getElementById("missionSelect");
    missionSelect.innerHTML =
      '<option value="">Новая миссия</option>' +
      missions
        .map(
          (mission) =>
            `<option value="${mission.id}">${escapeHtml(mission.title)} (${mission.status})</option>`,
        )
        .join("");
    const platformSelect = document.getElementById("platformSelect");
    platforms = platformData;
    platformSelect.innerHTML = platforms
      .map(
        (platform) =>
          `<option value="${platform.id}">${escapeHtml(platform.name)}</option>`,
      )
      .join("");
    if (platforms.some((platform) => platform.id === "test-quad-mini"))
      platformSelect.value = "test-quad-mini";
    updatePlatformInfo();
    if (missionId && missions.some((mission) => mission.id === missionId)) {
      missionSelect.value = missionId;
      await openMission(missionId);
    } else if (!boundary) {
      loadDemoArea();
    }
  } catch (_) {
    setSaved("Офлайн-черновик");
    showToast("Сервер недоступен. Работает локальный черновик.");
  }
}
function updatePlatformInfo() {
  const selected = platforms.find(
    (platform) =>
      platform.id === document.getElementById("platformSelect").value,
  );
  const info = document.getElementById("platformInfo");
  if (!selected) {
    info.textContent = "Выберите тестовый БВС";
    return;
  }
  info.innerHTML = `<strong>${escapeHtml(selected.category || "БВС")}</strong><span>${escapeHtml(selected.description || "")}</span><small>${selected.maxRangeM / 1000} км · до ${selected.maxSpeedMS} м/с · ${selected.flightMinutes} мин</small>`;
}
async function openMission(id) {
  try {
    const response = await fetch(`/api/missions/${id}`);
    if (!response.ok) throw new Error("Миссия не найдена");
    const mission = await response.json();
    missionId = mission.id;
    localStorage.setItem("geoscan-planner-server-id", missionId);
    document.querySelector(".mission-title input").value = mission.title;
    document.getElementById("platformSelect").value =
      mission.platformId || "generic-quad";
    Object.entries(mission.settings).forEach(([key, value]) => {
      const element = document.getElementById(key);
      if (element) element.value = value;
    });
    document
      .querySelectorAll("[data-mode]")
      .forEach((button) =>
        button.classList.toggle(
          "selected",
          button.dataset.mode === mission.mode,
        ),
      );
    if (mission.boundary)
      setBoundary(
        L.polygon(mission.boundary, {
          color: "#007d76",
          fillColor: "#19a092",
          fillOpacity: 0.18,
        }),
      );
  } catch (error) {
    showToast(error.message);
  }
}
function newMission() {
  clearMission();
  document.querySelector(".mission-title input").value = "Новая миссия";
}
async function duplicateMission() {
  if (!missionId) return showToast("Сначала сохраните миссию");
  try {
    const response = await fetch(`/api/missions/${missionId}/duplicate`, {
      method: "POST",
    });
    const mission = await response.json();
    if (!response.ok)
      throw new Error(mission.error || "Не удалось создать копию");
    missionId = mission.id;
    localStorage.setItem("geoscan-planner-server-id", missionId);
    document.querySelector(".mission-title input").value = mission.title;
    await loadServerData();
    showToast("Создана копия миссии");
  } catch (error) {
    showToast(error.message);
  }
}
function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value;
  return node.innerHTML;
}

function setSaved(text) {
  document.getElementById("saveState").textContent = text;
}
function showToast(text) {
  const toast = document.getElementById("toast");
  toast.textContent = text;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}
