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
