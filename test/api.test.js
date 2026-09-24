const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
process.env.GEOSCAN_DB = ":memory:";
const { server } = require("../src/server");
const payload = {
  title: "API тест",
  mode: "survey",
  platformId: "generic-quad",
  boundary: [
    [55.75, 37.61],
    [55.75, 37.63],
    [55.76, 37.63],
    [55.76, 37.61],
  ],
  settings: {
    sensor: "rgb",
    altitude: 120,
    speed: 8,
    frontOverlap: 75,
    sideOverlap: 70,
  },
};
let baseUrl;
let missionId;
test.before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test("exposes demo map assets and seeded UAV platforms", async () => {
  let response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /leaflet/);
  response = await fetch(`${baseUrl}/api/platforms`);
  const platforms = await response.json();
  assert.ok(platforms.some((platform) => platform.id === "test-quad-mini"));
  assert.ok(platforms.some((platform) => platform.id === "test-fixed-wing"));
});
test("creates, updates, lists, versions, exports and deletes mission", async () => {
  let response = await fetch(`${baseUrl}/api/missions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  missionId = created.id;
  assert.ok(created.plan.segments.length);
  assert.ok(["optimized", "raster"].includes(created.plan.routeOrder?.method));
  response = await fetch(`${baseUrl}/api/missions/${missionId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, title: "Обновлённая миссия" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, "Обновлённая миссия");
  response = await fetch(`${baseUrl}/api/missions`);
  assert.ok((await response.json()).some((item) => item.id === missionId));
  response = await fetch(`${baseUrl}/api/missions/${missionId}/versions`);
  assert.ok((await response.json()).length >= 2);
  response = await fetch(
    `${baseUrl}/api/missions/${missionId}/export?format=kml`,
  );
  assert.match(await response.text(), /<kml/);
  response = await fetch(
    `${baseUrl}/api/missions/${missionId}/export?format=csv`,
  );
  assert.match(await response.text(), /flight,segment/);
  response = await fetch(`${baseUrl}/api/missions/${missionId}`, {
    method: "DELETE",
  });
  assert.equal(response.status, 204);
});
test("creates and deletes a custom UAV with full specifications", async () => {
  const response = await fetch(`${baseUrl}/api/platforms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "API Test VTOL",
      category: "VTOL",
      description: "Custom aircraft",
      minAltitudeM: 30,
      maxAltitudeM: 300,
      maxSpeedMS: 22,
      maxRangeM: 18000,
      flightMinutes: 45,
      reservePercent: 25,
      batteryWh: 420,
      takeoffWeightKg: 8,
      payloadCapacityKg: 1.5,
      propulsion: "Electric",
      launchType: "Vertical",
      cruiseSpeedMS: 15,
    }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.platform.maxSpeedMS, 22);
  const details = await fetch(
    `${baseUrl}/api/platforms/${created.platform.id}`,
  );
  assert.equal((await details.json()).payloadCapacityKg, 1.5);
  const deleted = await fetch(
    `${baseUrl}/api/platforms/${created.platform.id}`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 200);
});
test("stores fleet home, allocates segments and exports Mission Planner WPL", async () => {
  const created = await fetch(`${baseUrl}/api/fleet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Fleet Test 01",
      platformId: "test-fixed-wing",
      homeLat: 55.77,
      homeLng: 37.59,
      payloads: ["RGB", "LiDAR"],
    }),
  });
  assert.equal(created.status, 201);
  const unit = (await created.json()).unit;
  const allocation = await fetch(`${baseUrl}/api/fleet/allocate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      plan: {
        mode: "survey",
        segments: [
          [
            [55.775, 37.6],
            [55.776, 37.61],
          ],
          [
            [55.776, 37.6],
            [55.777, 37.61],
          ],
        ],
      },
      fleetIds: [unit.id],
    }),
  });
  assert.equal(allocation.status, 200);
  const result = await allocation.json();
  const assignment = result.allocations[0];
  assert.equal(assignment.survey_segments_lonlat.length, 2);
  assert.equal(assignment.flight_trajectory_lonlat[0][1], 55.77);
  assert.equal(assignment.flight_trajectory_lonlat.at(-1)[1], 55.77);
  const wplAssignment = {
    uavId: assignment.uav_id,
    home: assignment.home_lonlat.slice().reverse(),
    segments: assignment.survey_segments_lonlat.map((segment) =>
      segment.map(([lng, lat]) => [lat, lng]),
    ),
  };
  const wpl = await fetch(`${baseUrl}/api/fleet/export-wpl`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignment: wplAssignment, altitude: 120 }),
  });
  assert.equal(wpl.status, 200);
  assert.match(await wpl.text(), /QGC WPL 110/);
  const removed = await fetch(`${baseUrl}/api/fleet/${unit.id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
});
test("keeps live MAVLink start disabled unless explicitly armed", async () => {
  const response = await fetch(`${baseUrl}/api/fleet/live-start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /GEOSCAN_ALLOW_LIVE_ARM/);
});
test("validates live MAVLink start request once armed", async () => {
  process.env.GEOSCAN_ALLOW_LIVE_ARM = "1";
  try {
    const response = await fetch(`${baseUrl}/api/fleet/live-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /БВС флота не найден/);
  } finally {
    delete process.env.GEOSCAN_ALLOW_LIVE_ARM;
  }
});
test("rejects an unsupported export format without mutating the mission", async () => {
  const created = await fetch(`${baseUrl}/api/missions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const mission = await created.json();
  const response = await fetch(
    `${baseUrl}/api/missions/${mission.id}/export?format=shapefile`,
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Неподдерживаемый формат/);
  const reloaded = await fetch(`${baseUrl}/api/missions/${mission.id}`);
  assert.equal((await reloaded.json()).status, "planned");
});
test("rejects an unknown mission mode before calling the planner", async () => {
  const response = await fetch(`${baseUrl}/api/missions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, mode: "flyby" }),
  });
  assert.equal(response.status, 422);
  assert.match((await response.json()).errors.join(" "), /mode/);
});
test("keeps a platform that is referenced by a mission or fleet unit", async () => {
  const created = await fetch(`${baseUrl}/api/platforms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "In-use VTOL",
      minAltitudeM: 30,
      maxAltitudeM: 300,
      maxSpeedMS: 22,
      maxRangeM: 18000,
      flightMinutes: 45,
      reservePercent: 25,
      batteryWh: 420,
    }),
  });
  const platformId = (await created.json()).platform.id;
  const unit = await fetch(`${baseUrl}/api/fleet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "In-use fleet unit",
      platformId,
      homeLat: 55.7,
      homeLng: 37.6,
    }),
  });
  const unitId = (await unit.json()).unit.id;
  const blocked = await fetch(`${baseUrl}/api/platforms/${platformId}`, {
    method: "DELETE",
  });
  assert.equal(blocked.status, 422);
  assert.match((await blocked.json()).errors.join(" "), /используется/);
  await fetch(`${baseUrl}/api/fleet/${unitId}`, { method: "DELETE" });
  const allowed = await fetch(`${baseUrl}/api/platforms/${platformId}`, {
    method: "DELETE",
  });
  assert.equal(allowed.status, 200);
});
test("returns 422 for invalid planning input", async () => {
  const response = await fetch(`${baseUrl}/api/missions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...payload,
      settings: { ...payload.settings, speed: 99 },
    }),
  });
  assert.equal(response.status, 422);
  assert.ok((await response.json()).errors.length);
});
