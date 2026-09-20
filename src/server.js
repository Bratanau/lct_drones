const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { openDatabase, parse, listRows } = require("./database");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_ROOT = path.join(__dirname, "public");
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const PORT = Number(process.env.GEOSCAN_PORT || 4173);
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
function body(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) reject(new Error("Тело запроса превышает 1 МБ."));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (_) {
        reject(new Error("Некорректный JSON."));
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
function runMavlinkUploader(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, ["-m", "src.mavlink_uploader"], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => {
        child.kill();
        reject(
          new Error("Таймаут MAVLink: симулятор или контроллер не ответил."),
        );
      },
      (Number(input.timeoutSeconds) || 10) * 1000 + 5000,
    );
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout || "{}");
        if (code === 0 && !result.errors) resolve(result);
        else
          reject(
            new Error(
              result.errors?.join(" ") || stderr || "MAVLink uploader failed.",
            ),
          );
      } catch (_) {
        reject(new Error(stderr || "MAVLink uploader returned invalid JSON."));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
function runPythonPlanner(input, selectedPlatform) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, ["-m", "src.geometry.service"], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 5 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      try {
        const result = JSON.parse(stdout);
        if (code === 0 || result.errors) resolve(result);
        else reject(new Error(result.errors.join(" ")));
      } catch (_) {
        reject(new Error(stderr || "Python planner returned invalid JSON."));
      }
    });
    child.stdin.end(JSON.stringify({ ...input, platform: selectedPlatform }));
  });
}
function runPythonAllocator(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, ["-m", "src.route_optimizer"], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Таймаут OR-Tools solver."));
    }, 8000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout || "{}");
        if (code === 0 && !result.errors) resolve(result);
        else
          reject(
            new Error(
              result.errors?.join(" ") || stderr || "OR-Tools solver failed.",
            ),
          );
      } catch (_) {
        reject(new Error(stderr || "OR-Tools solver returned invalid JSON."));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
function normalizePlatformInput(input) {
  const numericFields = [
    "minAltitudeM",
    "maxAltitudeM",
    "maxSpeedMS",
    "maxRangeM",
    "flightMinutes",
    "reservePercent",
    "batteryWh",
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
  for (const field of numericFields) {
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
function distanceM(first, second) {
  const radius = 6371000;
  const radians = Math.PI / 180;
  const dLat = (second[0] - first[0]) * radians;
  const dLng = (second[1] - first[1]) * radians;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(first[0] * radians) *
      Math.cos(second[0] * radians) *
      Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}
function allocateRoutes(plan, units) {
  if (!Array.isArray(plan.segments) || !plan.segments.length)
    return { errors: ["Не переданы галсы для распределения."] };
  const candidates = units
    .filter((unit) => {
      const required = plan.mode === "lidar" ? "lidar" : null;
      return (
        Number(unit.platform?.maxSpeedMS || 0) > 0 &&
        (!required ||
          unit.payloads.some((payload) => payload.toLowerCase() === required))
      );
    })
    .map((unit) => ({
      uavId: unit.id,
      name: unit.name,
      home: [unit.homeLat, unit.homeLng],
      platform: unit.platform,
      pending: [],
      assignedSeconds: 0,
      warnings: [],
    }));
  if (!candidates.length)
    return { errors: ["Нет БВС с подходящей полезной нагрузкой."] };

  const unassigned = [];
  for (const [index, segment] of plan.segments.entries()) {
    const midpoint = [
      (segment[0][0] + segment[1][0]) / 2,
      (segment[0][1] + segment[1][1]) / 2,
    ];
    const length = distanceM(segment[0], segment[1]);
    const ranked = candidates
      .map((candidate) => {
        const speed = Number(candidate.platform.maxSpeedMS);
        const roundTrip = distanceM(candidate.home, midpoint) * 2 + length;
        const usableSeconds =
          Number(candidate.platform.flightMinutes || 0) *
          60 *
          (1 - Number(candidate.platform.reservePercent || 20) / 100);
        return {
          candidate,
          costSeconds: roundTrip / speed,
          usableSeconds,
          distanceToHome: distanceM(candidate.home, midpoint),
        };
      })
      .sort((first, second) => first.distanceToHome - second.distanceToHome);
    const selected = ranked.find(
      (item) =>
        item.candidate.assignedSeconds + item.costSeconds <= item.usableSeconds,
    );
    if (!selected) {
      unassigned.push(index);
      continue;
    }
    selected.candidate.pending.push({ segment, index });
    selected.candidate.assignedSeconds += selected.costSeconds;
  }

  const allocations = candidates.map((candidate) => {
    const remaining = [...candidate.pending];
    const trajectory = [[...candidate.home]];
    const surveySegments = [];
    let position = candidate.home;
    while (remaining.length) {
      let bestIndex = 0;
      let reverse = false;
      let bestDistance = Infinity;
      remaining.forEach((task, index) => {
        const toStart = distanceM(position, task.segment[0]);
        const toEnd = distanceM(position, task.segment[1]);
        if (toStart < bestDistance) {
          bestIndex = index;
          reverse = false;
          bestDistance = toStart;
        }
        if (toEnd < bestDistance) {
          bestIndex = index;
          reverse = true;
          bestDistance = toEnd;
        }
      });
      const task = remaining.splice(bestIndex, 1)[0];
      const oriented = reverse
        ? [task.segment[1], task.segment[0]]
        : task.segment;
      trajectory.push([...oriented[0]], [...oriented[1]]);
      surveySegments.push(oriented);
      position = oriented[1];
    }
    if (surveySegments.length) trajectory.push([...candidate.home]);
    const distance = trajectory
      .slice(1)
      .reduce(
        (total, point, index) => total + distanceM(trajectory[index], point),
        0,
      );
    const speed = Number(candidate.platform.maxSpeedMS || 1);
    const usableSeconds =
      Number(candidate.platform.flightMinutes || 0) *
      60 *
      (1 - Number(candidate.platform.reservePercent || 20) / 100);
    if (distance / speed > usableSeconds)
      candidate.warnings.push(
        "Непрерывный маршрут превышает доступную автономность.",
      );
    return {
      uav_id: candidate.uavId,
      uavId: candidate.uavId,
      name: candidate.name,
      home: candidate.home,
      flight_trajectory_lonlat: trajectory.map(([lat, lng]) => [lng, lat]),
      flightTrajectory: trajectory,
      surveySegments,
      segments: surveySegments,
      stats: {
        flight_time_m: Math.ceil(distance / speed / 60),
        distance_m: Math.round(distance),
      },
      distanceM: Math.round(distance),
      estimatedSeconds: Math.ceil(distance / speed),
      warnings: candidate.warnings,
    };
  });
  return { allocations, assignments: allocations, unassigned };
}
function missionPlannerWpl(assignment, altitude = 120) {
  const lines = ["QGC WPL 110"];
  let sequence = 0;
  const [homeLat, homeLng] = assignment.home;
  lines.push(
    `${sequence++}\t1\t3\t16\t0\t0\t0\t0\t${homeLat.toFixed(7)}\t${homeLng.toFixed(7)}\t${Number(altitude).toFixed(2)}\t1`,
  );
  for (const segment of assignment.segments) {
    for (const point of segment)
      lines.push(
        `${sequence++}\t0\t3\t16\t0\t0\t0\t0\t${point[0].toFixed(7)}\t${point[1].toFixed(7)}\t${Number(altitude).toFixed(2)}\t1`,
      );
  }
  lines.push(
    `${sequence}\t0\t3\t21\t0\t0\t0\t0\t${homeLat.toFixed(7)}\t${homeLng.toFixed(7)}\t${Number(altitude).toFixed(2)}\t1`,
  );
  return lines.join("\n");
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
async function saveMission(input, existing) {
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
  if (existing)
    db.prepare(
      "UPDATE missions SET title=?, status=?, mode=?, platform_id=?, sensor_preset_id=?, payload_json=?, plan_json=?, updated_at=? WHERE id=?",
    ).run(
      payload.title,
      status,
      payload.mode,
      selectedPlatform.id,
      input.sensorPresetId || null,
      JSON.stringify(payload),
      JSON.stringify(result.plan),
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
      selectedPlatform.id,
      input.sensorPresetId || null,
      JSON.stringify(payload),
      JSON.stringify(result.plan),
      timestamp,
      timestamp,
    );
  snapshot(id, existing ? "updated" : "created");
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
        return send(response, 200, result);
      } catch (error) {
        return send(response, 422, { errors: [error.message] });
      }
    }
    if (request.method === "POST" && parts[2] === "live-start") {
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
        return send(response, 200, result);
      } catch (error) {
        return send(response, 502, { error: error.message });
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
    const saved = await saveMission(await body(request));
    return saved.errors
      ? send(response, 422, saved)
      : send(response, 201, saved.mission);
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
    const duplicate = await saveMission({
      ...mission,
      title: `${mission.title} (копия)`,
      status: "draft",
    });
    return duplicate.errors
      ? send(response, 422, duplicate)
      : send(response, 201, duplicate.mission);
  }
  if (parts[3] === "export" && request.method === "GET") {
    const format = url.searchParams.get("format") || "geojson";
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
    const saved = await saveMission(await body(request), row);
    return saved.errors
      ? send(response, 422, saved)
      : send(response, 200, saved.mission);
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
    send(response, 400, { error: error.message || "Ошибка сервера." });
  }
});
if (require.main === module)
  server.listen(PORT, "127.0.0.1", () =>
    console.log(`Geoscan Planner: http://127.0.0.1:${PORT}`),
  );
module.exports = { server, db, saveMission };
