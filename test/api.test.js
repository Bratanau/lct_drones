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
  assert.equal(result.assignments[0].segments.length, 2);
  assert.equal(result.assignments[0].flightTrajectory[0][0], 55.77);
  assert.equal(result.assignments[0].flightTrajectory.at(-1)[0], 55.77);
  const wpl = await fetch(`${baseUrl}/api/fleet/export-wpl`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignment: result.assignments[0], altitude: 120 }),
  });
  assert.equal(wpl.status, 200);
  assert.match(await wpl.text(), /QGC WPL 110/);
  const removed = await fetch(`${baseUrl}/api/fleet/${unit.id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
});
test("validates live MAVLink start request", async () => {
  const response = await fetch(`${baseUrl}/api/fleet/live-start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /БВС флота не найден/);
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
