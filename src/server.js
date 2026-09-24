const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { openDatabase, parse, listRows } = require("./database");
const { missionPlannerWpl } = require("./exporters/qgc-wpl");
const {
  allocateRoutes: runPythonAllocator,
  planMission: runPythonPlanner,
  uploadMavlinkMission: runMavlinkUploader,
} = require("./services/python-worker");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_ROOT = path.join(__dirname, "public");
const PORT = Number(process.env.GEOSCAN_PORT || 4173);
const MISSION_MODES = new Set(["survey", "inspection", "corridor", "lidar"]);
const MISSION_STATUSES = new Set(["draft", "planned", "exported"]);
const EXPORT_FORMATS = new Set(["geojson", "kml", "csv", "waypoints"]);
// live-start реально ставит борт на охрану и в AUTO, поэтому выключен по умолчанию.
function isLiveArmEnabled() {
  return process.env.GEOSCAN_ALLOW_LIVE_ARM === "1";
}
const db = openDatabase(
  process.env.GEOSCAN_DB || path.join(ROOT, "data", "geoscan.db"),
);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
function now() {
  return new Date().toISOString();
}
function clientError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
function body(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) reject(clientError("Тело запроса превышает 1 МБ."));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (_) {
        reject(clientError("Некорректный JSON."));
      }
    });
    request.on("error", reject);
  });
}
function send(response, status, data, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(data === undefined ? "" : JSON.stringify(data));
}
function sendError(response, error, fallbackStatus = 422) {
  if (error.isWorkerFault)
    return send(response, 502, { errors: [error.message] });
  const status = error.statusCode || fallbackStatus;
  return send(response, status, { errors: [error.message] });
}
function normalizePlatformInput(input) {
  const requiredNumericFields = [
    "minAltitudeM",
    "maxAltitudeM",
    "maxSpeedMS",
    "maxRangeM",
    "flightMinutes",
    "reservePercent",
    "batteryWh",
  ];
  // Не участвуют в расчете плана.
  const optionalNumericFields = [
    "takeoffWeightKg",
    "payloadCapacityKg",
    "cruiseSpeedMS",
  ];
  const config = {
    category: String(input.category || "Мультикоптер").slice(0, 60),
    description: String(input.description || "").slice(0, 500),
    propulsion: String(input.propulsion || "").slice(0, 80),
    launchType: String(input.launchType || "").slice(0, 80),
  };
  for (const field of requiredNumericFields) {
    const value = Number(input[field]);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Поле ${field} должно быть неотрицательным числом.`);
    config[field] = value;
  }
  for (const field of optionalNumericFields) {
    if (
      input[field] === undefined ||
      input[field] === null ||
      input[field] === ""
    ) {
      config[field] = 0;
      continue;
    }
    const value = Number(input[field]);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Поле ${field} должно быть неотрицательным числом.`);
    config[field] = value;
  }
  if (!config.maxAltitudeM || config.maxAltitudeM < config.minAltitudeM)
    throw new Error("Максимальная высота должна быть больше минимальной.");
  if (config.reservePercent > 80)
    throw new Error("Резерв не может превышать 80%.");
  return config;
}
function createPlatform(input) {
  const name = String(input.name || "")
    .trim()
    .slice(0, 100);
  if (!name) return { errors: ["Укажите название БВС."] };
  try {
    const config = normalizePlatformInput(input);
    const id = `custom-${crypto.randomUUID()}`;
    db.prepare(
      "INSERT INTO platforms (id, name, config_json) VALUES (?, ?, ?)",
    ).run(id, name, JSON.stringify({ id, name, userDefined: true, ...config }));
    return { platform: { id, name, userDefined: true, ...config } };
  } catch (error) {
    return { errors: [error.message] };
  }
}
function deletePlatform(id) {
  const row = db
    .prepare("SELECT config_json FROM platforms WHERE id=?")
    .get(id);
  if (!row) return { errors: ["БВС не найден."] };
  const config = JSON.parse(row.config_json);
  if (!config.userDefined)
    return { errors: ["Системные платформы нельзя удалить."] };
  const missionCount = db
    .prepare("SELECT COUNT(*) AS count FROM missions WHERE platform_id=?")
    .get(id).count;
  const fleetCount = db
    .prepare("SELECT COUNT(*) AS count FROM fleet_units WHERE platform_id=?")
    .get(id).count;
  if (missionCount || fleetCount)
    return {
      errors: [
        `Платформа используется: миссий — ${missionCount}, БВС флота — ${fleetCount}. Сначала отвяжите их.`,
      ],
    };
  db.prepare("DELETE FROM platforms WHERE id=?").run(id);
  return { ok: true };
}

function platform(id) {
  const row = db
    .prepare("SELECT * FROM platforms WHERE id = ?")
    .get(id || "generic-quad");
  return row
    ? { id: row.id, name: row.name, ...JSON.parse(row.config_json) }
    : null;
}
function fleetRows() {
  return db
    .prepare("SELECT * FROM fleet_units ORDER BY name")
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      platformId: row.platform_id,
      homeLat: row.home_lat,
      homeLng: row.home_lng,
      payloads: JSON.parse(row.payloads_json),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      platform: platform(row.platform_id),
    }));
}
function createFleetUnit(input) {
  const name = String(input.name || "")
    .trim()
    .slice(0, 100);
  const selectedPlatform = platform(input.platformId);
  const homeLat = Number(input.homeLat);
  const homeLng = Number(input.homeLng);
  const payloads = Array.isArray(input.payloads)
    ? input.payloads.map(String).slice(0, 12)
    : [];
  if (!name) return { errors: ["Укажите позывной БВС."] };
  if (!selectedPlatform) return { errors: ["Платформа БВС не найдена."] };
  if (
    !Number.isFinite(homeLat) ||
    !Number.isFinite(homeLng) ||
    homeLat < -90 ||
    homeLat > 90 ||
    homeLng < -180 ||
    homeLng > 180
  )
    return { errors: ["Координаты стартовой площадки некорректны."] };
  const id = `uav-${crypto.randomUUID()}`;
  const timestamp = now();
  db.prepare(
    "INSERT INTO fleet_units (id,name,platform_id,home_lat,home_lng,payloads_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    name,
    selectedPlatform.id,
    homeLat,
    homeLng,
    JSON.stringify(payloads),
    input.status || "ready",
    timestamp,
    timestamp,
  );
  return { unit: fleetRows().find((item) => item.id === id) };
}
function deleteFleetUnit(id) {
  const result = db.prepare("DELETE FROM fleet_units WHERE id=?").run(id);
  return result.changes ? { ok: true } : { errors: ["БВС флота не найден."] };
}
function missionFromRow(row) {
  const record = parse(row);
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    mode: record.mode,
    platformId: record.platform_id,
    sensorPresetId: record.sensor_preset_id,
    ...record.payload,
    plan: record.plan,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
function snapshot(id, event) {
  const row = db.prepare("SELECT * FROM missions WHERE id = ?").get(id);
  if (row)
    db.prepare(
      "INSERT INTO mission_versions (mission_id, event, snapshot_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, event, JSON.stringify(missionFromRow(row)), now());
}
function validateMissionInput(input) {
  const errors = [];
  if (input.mode !== undefined && !MISSION_MODES.has(input.mode))
    errors.push(
      `Поле mode должно быть одним из: ${[...MISSION_MODES].join(", ")}.`,
    );
  if (input.status !== undefined && !MISSION_STATUSES.has(input.status))
    errors.push(
      `Поле status должно быть одним из: ${[...MISSION_STATUSES].join(", ")}.`,
    );
  if (!input.boundary && !input.geometry)
    errors.push("Передайте контур работ: boundary или geometry.");
  return errors;
}
// Миссия и ее версия пишутся атомарно.
const persistMission = db.transaction(
  (
    id,
    payload,
    status,
    platformId,
    sensorPresetId,
    planJson,
    timestamp,
    isUpdate,
  ) => {
    if (isUpdate)
      db.prepare(
        "UPDATE missions SET title=?, status=?, mode=?, platform_id=?, sensor_preset_id=?, payload_json=?, plan_json=?, updated_at=? WHERE id=?",
      ).run(
        payload.title,
        status,
        payload.mode,
        platformId,
        sensorPresetId,
        JSON.stringify(payload),
        planJson,
        timestamp,
        id,
      );
    else
      db.prepare(
        "INSERT INTO missions (id,title,status,mode,platform_id,sensor_preset_id,payload_json,plan_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        payload.title,
        status,
        payload.mode,
        platformId,
        sensorPresetId,
        JSON.stringify(payload),
        planJson,
        timestamp,
        timestamp,
      );
    snapshot(id, isUpdate ? "updated" : "created");
  },
);
async function saveMission(input, existing) {
  const validationErrors = validateMissionInput(input);
  if (validationErrors.length) return { errors: validationErrors };
  const selectedPlatform = platform(input.platformId || existing?.platform_id);
  if (!selectedPlatform) return { errors: ["Выбранная платформа не найдена."] };
  const result = await runPythonPlanner(input, selectedPlatform);
  if (result.errors) return result;
  const id = existing?.id || crypto.randomUUID();
  const timestamp = now();
  const payload = {
    title: String(input.title || "Новая миссия").slice(0, 120),
    mode: input.mode || "survey",
    boundary: input.boundary,
    geometry: input.geometry,
    settings: input.settings,
    terrainElevationM: input.terrainElevationM,
  };
  const status = input.status || "planned";
  persistMission(
    id,
    payload,
    status,
    selectedPlatform.id,
    input.sensorPresetId || null,
    JSON.stringify(result.plan),
    timestamp,
    Boolean(existing),
  );
  return {
    mission: missionFromRow(
      db.prepare("SELECT * FROM missions WHERE id=?").get(id),
    ),
  };
}
function exportGeoJson(mission) {
  const polygonCoordinates = mission.boundary
    ? [mission.boundary.map(([lat, lng]) => [lng, lat])]
    : null;
  const workGeometry =
    mission.geometry ||
    (polygonCoordinates
      ? { type: "Polygon", coordinates: polygonCoordinates }
      : null);
  return {
    type: "FeatureCollection",
    features: [
      ...(workGeometry
        ? [
            {
              type: "Feature",
              properties: { name: "Контур работ", mission: mission.title },
              geometry: workGeometry,
            },
          ]
        : []),
      {
        type: "Feature",
        properties: {
          name: "Маршрут",
          ...mission.settings,
          orientationDegrees: mission.plan.orientationDegrees,
          flights: mission.plan.flights.length,
        },
        geometry: {
          type: "MultiLineString",
          coordinates: mission.plan.segments.map((segment) =>
            segment.map(([lat, lng]) => [lng, lat]),
          ),
        },
      },
    ],
  };
}
function exportKml(mission) {
  const lines = mission.plan.segments
    .map(
      (segment) =>
        `<LineString><coordinates>${segment.map(([lat, lng]) => `${lng},${lat},${mission.settings.altitude}`).join(" ")}</coordinates></LineString>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escapeXml(mission.title)}</name>${lines}</Document></kml>`;
}
function exportCsv(mission) {
  const rows = ["flight,segment,point,latitude,longitude,altitude_m,speed_ms"];
  let segmentNo = 0;
  mission.plan.flights.forEach((flight) =>
    flight.segments.forEach((segment) => {
      segmentNo++;
      segment.forEach(([lat, lng], point) =>
        rows.push(
          [
            flight.number,
            segmentNo,
            point + 1,
            lat,
            lng,
            mission.settings.altitude,
            mission.settings.speed,
          ].join(","),
        ),
      );
    }),
  );
  return rows.join("\n");
}
function exportWaypoints(mission) {
  return {
    format: "geoscan-neutral-waypoints/v1",
    mission: mission.title,
    platformId: mission.platformId,
    settings: mission.settings,
    flights: mission.plan.flights.map((flight) => ({
      number: flight.number,
      waypoints: flight.segments.flatMap((segment) =>
        segment.map(([lat, lng]) => ({
          lat,
          lng,
          altitudeM: Number(mission.settings.altitude),
          speedMS: Number(mission.settings.speed),
        })),
      ),
    })),
  };
}
function escapeXml(value) {
  return String(value).replace(
    /[<>&"']/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );
}
async function api(request, response, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];
  if (parts[1] === "platforms") {
    if (request.method === "GET" && !parts[2])
      return send(response, 200, listRows(db, "platforms"));
    if (request.method === "GET" && parts[2]) {
      const row = db
        .prepare("SELECT * FROM platforms WHERE id=?")
        .get(parts[2]);
      return row
        ? send(response, 200, {
            id: row.id,
            name: row.name,
            ...JSON.parse(row.config_json),
          })
        : send(response, 404, { error: "БВС не найден." });
    }
    if (request.method === "POST") {
      const result = createPlatform(await body(request));
      return send(response, result.errors ? 422 : 201, result);
    }
    if (request.method === "DELETE" && parts[2]) {
      const result = deletePlatform(parts[2]);
      return send(response, result.errors ? 422 : 200, result);
    }
    return send(response, 405, { error: "Метод не поддерживается." });
  }
  if (parts[1] === "fleet") {
    if (request.method === "GET" && !parts[2])
      return send(response, 200, fleetRows());
    if (request.method === "POST" && !parts[2]) {
      const result = createFleetUnit(await body(request));
      return send(response, result.errors ? 422 : 201, result);
    }
    if (request.method === "DELETE" && parts[2]) {
      const result = deleteFleetUnit(parts[2]);
      return send(response, result.errors ? 404 : 200, result);
    }
    if (request.method === "POST" && parts[2] === "allocate") {
      const input = await body(request);
      const units = fleetRows().filter((unit) =>
        (input.fleetIds || []).includes(unit.id),
      );
      try {
        const result = await runPythonAllocator({
          plan: input.plan || {},
          units,
        });
        return send(response, result.errors ? 422 : 200, result);
      } catch (error) {
        return sendError(response, error);
      }
    }
    if (request.method === "POST" && parts[2] === "live-start") {
      if (!isLiveArmEnabled())
        return send(response, 403, {
          error:
            "LIVE START отключен. Установите GEOSCAN_ALLOW_LIVE_ARM=1, чтобы разрешить вооружение борта по MAVLink.",
        });
      const input = await body(request);
      const assignment = input.assignment;
      const unit = fleetRows().find(
        (item) => item.id === input.uavId || item.id === assignment?.uavId,
      );
      if (!unit) return send(response, 404, { error: "БВС флота не найден." });
      if (!assignment?.segments?.length)
        return send(response, 422, { error: "У БВС нет назначенных галсов." });
      try {
        const result = await runMavlinkUploader({
          connection:
            input.connection ||
            process.env.GEOSCAN_MAVLINK_CONNECTION ||
            "udp:127.0.0.1:14550",
          segments: assignment.segments,
          home: assignment.home || [unit.homeLat, unit.homeLng],
          altitudeM: input.altitudeM || 120,
          transitAltitudeM: input.transitAltitudeM || 50,
          timeoutSeconds: input.timeoutSeconds || 10,
          autoMode: input.autoMode || 3,
        });
        return send(response, result.errors ? 422 : 200, result);
      } catch (error) {
        return sendError(response, error, 502);
      }
    }
    if (request.method === "POST" && parts[2] === "export-wpl") {
      const input = await body(request);
      const assignment = input.assignment;
      if (!assignment)
        return send(response, 422, {
          errors: ["Не передано назначение маршрута."],
        });
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${assignment.uavId || "uav"}.waypoints"`,
      });
      return response.end(missionPlannerWpl(assignment, input.altitude || 120));
    }
    return send(response, 405, { error: "Метод не поддерживается." });
  }
  if (parts[1] === "sensor-presets" && request.method === "GET")
    return send(response, 200, listRows(db, "sensor_presets"));
  if (parts[1] !== "missions")
    return send(response, 404, { error: "Ресурс не найден." });
  if (!id && request.method === "GET")
    return send(
      response,
      200,
      db
        .prepare("SELECT * FROM missions ORDER BY updated_at DESC")
        .all()
        .map(missionFromRow),
    );
  if (!id && request.method === "POST") {
    try {
      const saved = await saveMission(await body(request));
      return saved.errors
        ? send(response, 422, saved)
        : send(response, 201, saved.mission);
    } catch (error) {
      return sendError(response, error);
    }
  }
  const row = db.prepare("SELECT * FROM missions WHERE id=?").get(id);
  if (!row) return send(response, 404, { error: "Миссия не найдена." });
  const mission = missionFromRow(row);
  if (parts[3] === "versions" && request.method === "GET")
    return send(
      response,
      200,
      db
        .prepare(
          "SELECT id,event,snapshot_json,created_at FROM mission_versions WHERE mission_id=? ORDER BY id DESC",
        )
        .all(id)
        .map((item) => ({
          id: item.id,
          event: item.event,
          snapshot: JSON.parse(item.snapshot_json),
          createdAt: item.created_at,
        })),
    );
  if (parts[3] === "duplicate" && request.method === "POST") {
    try {
      const duplicate = await saveMission({
        ...mission,
        title: `${mission.title} (копия)`,
        status: "draft",
      });
      return duplicate.errors
        ? send(response, 422, duplicate)
        : send(response, 201, duplicate.mission);
    } catch (error) {
      return sendError(response, error);
    }
  }
  if (parts[3] === "export" && request.method === "GET") {
    const format = url.searchParams.get("format") || "geojson";
    if (!EXPORT_FORMATS.has(format))
      return send(response, 400, {
        error: `Неподдерживаемый формат экспорта. Доступно: ${[...EXPORT_FORMATS].join(", ")}.`,
      });
    if (!mission.plan)
      return send(response, 409, {
        error: "У миссии еще нет рассчитанного плана.",
      });
    const content =
      format === "kml"
        ? exportKml(mission)
        : format === "csv"
          ? exportCsv(mission)
          : format === "waypoints"
            ? JSON.stringify(exportWaypoints(mission), null, 2)
            : JSON.stringify(exportGeoJson(mission), null, 2);
    const type =
      format === "kml"
        ? "application/vnd.google-earth.kml+xml"
        : format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/json; charset=utf-8";
    snapshot(id, `exported:${format}`);
    db.prepare("UPDATE missions SET status=?, updated_at=? WHERE id=?").run(
      "exported",
      now(),
      id,
    );
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${id}.${format === "waypoints" ? "json" : format}"`,
    });
    return response.end(content);
  }
  if (request.method === "GET") return send(response, 200, mission);
  if (request.method === "PUT") {
    try {
      const saved = await saveMission(await body(request), row);
      return saved.errors
        ? send(response, 422, saved)
        : send(response, 200, saved.mission);
    } catch (error) {
      return sendError(response, error);
    }
  }
  if (request.method === "DELETE") {
    db.prepare("DELETE FROM mission_versions WHERE mission_id=?").run(id);
    db.prepare("DELETE FROM missions WHERE id=?").run(id);
    response.writeHead(204);
    return response.end();
  }
  return send(response, 405, { error: "Метод не поддерживается." });
}
async function staticFile(request, response, url) {
  const relative =
    url.pathname === "/"
      ? "index.html"
      : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const target = path.resolve(PUBLIC_ROOT, relative);
  const relativeTarget = path.relative(PUBLIC_ROOT, target);
  if (
    relativeTarget.startsWith("..") ||
    path.isAbsolute(relativeTarget) ||
    path.extname(target) === ".pdf"
  ) {
    response.writeHead(404);
    return response.end();
  }
  try {
    const content = await fs.readFile(target);
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(target)] || "application/octet-stream",
    });
    response.end(content);
  } catch (_) {
    response.writeHead(404);
    response.end("Not found");
  }
}
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/"))
      return await api(request, response, url);
    return await staticFile(request, response, url);
  } catch (error) {
    const status = error.isWorkerFault ? 502 : error.statusCode || 500;
    send(response, status, { error: error.message || "Ошибка сервера." });
  }
});
if (require.main === module)
  server.listen(PORT, "127.0.0.1", () =>
    console.log(`Geoscan Planner: http://127.0.0.1:${PORT}`),
  );
module.exports = { server, db, saveMission };
