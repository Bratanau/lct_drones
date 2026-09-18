const test = require("node:test");
const assert = require("node:assert/strict");
const { planMission, validateMission } = require("../src/mission-planner");

const settings = {
  sensor: "rgb",
  altitude: 120,
  speed: 8,
  frontOverlap: 75,
  sideOverlap: 70,
};
const mission = {
  title: "Тестовая миссия",
  mode: "survey",
  boundary: [
    [55.75, 37.61],
    [55.75, 37.63],
    [55.76, 37.63],
    [55.76, 37.61],
  ],
  settings,
};

test("calculates a valid survey plan", () => {
  const result = planMission(mission);
  assert.equal(result.errors, undefined);
  assert.ok(result.plan.segments.length > 0);
  assert.ok(result.plan.totalDistanceM >= result.plan.coverageDistanceM);
  assert.ok(result.plan.alternatives.length >= 2);
});
test("rejects invalid mission parameters", () => {
  const errors = validateMission({
    ...mission,
    settings: { ...settings, speed: 100 },
  });
  assert.ok(errors.some((error) => error.includes("speed")));
});
test("rejects self-intersecting boundaries", () => {
  const errors = validateMission({
    ...mission,
    boundary: [
      [55.75, 37.61],
      [55.76, 37.63],
      [55.75, 37.63],
      [55.76, 37.61],
    ],
  });
  assert.ok(errors.some((error) => error.includes("самопересечения")));
});
