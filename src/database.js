const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

function openDatabase(filename = path.join(__dirname, "data", "geoscan.db")) {
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS platforms (id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sensor_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS restricted_zones (id TEXT PRIMARY KEY, name TEXT NOT NULL, geometry_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL, platform_id TEXT, sensor_preset_id TEXT, payload_json TEXT NOT NULL, plan_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mission_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, event TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  seed(db);
  return db;
}
function seed(db) {
  const platform = db.prepare(
    "INSERT OR IGNORE INTO platforms (id, name, config_json) VALUES (?, ?, ?)",
  );
  platform.run(
    "generic-quad",
    "Универсальный квадрокоптер",
    JSON.stringify({
      id: "generic-quad",
      maxAltitudeM: 500,
      minAltitudeM: 20,
      maxSpeedMS: 18,
      maxRangeM: 12000,
      flightMinutes: 28,
      reservePercent: 20,
      batteryWh: 180,
    }),
  );
  platform.run(
    "geoscan-201",
    "Геоскан 201",
    JSON.stringify({
      id: "geoscan-201",
      maxAltitudeM: 500,
      minAltitudeM: 50,
      maxSpeedMS: 30,
      maxRangeM: 50000,
      flightMinutes: 180,
      reservePercent: 25,
      batteryWh: 1100,
    }),
  );
  const sensor = db.prepare(
    "INSERT OR IGNORE INTO sensor_presets (id, name, config_json) VALUES (?, ?, ?)",
  );
  sensor.run(
    "rgb-default",
    "RGB-камера",
    JSON.stringify({ sensor: "rgb", frontOverlap: 75, sideOverlap: 70 }),
  );
  sensor.run(
    "lidar-default",
    "LiDAR",
    JSON.stringify({
      sensor: "lidar",
      frontOverlap: 60,
      sideOverlap: 60,
      pointsPerM2: 100,
    }),
  );
}
function parse(row) {
  return (
    row && {
      ...row,
      payload: JSON.parse(row.payload_json),
      plan: row.plan_json ? JSON.parse(row.plan_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  );
}
function listRows(db, table) {
  return db
    .prepare(`SELECT * FROM ${table} ORDER BY name`)
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      ...JSON.parse(row.config_json || row.geometry_json),
    }));
}
module.exports = { openDatabase, parse, listRows };
