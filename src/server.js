const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { openDatabase, parse, listRows } = require("./database");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_ROOT = path.join(__dirname, "public");
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
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
function platform(id) {
  const row = db
    .prepare("SELECT * FROM platforms WHERE id = ?")
    .get(id || "generic-quad");
  return row ? { id: row.id, ...JSON.parse(row.config_json) } : null;
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
  if (parts[1] === "platforms" && request.method === "GET")
    return send(response, 200, listRows(db, "platforms"));
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
