const test = require("node:test");
const assert = require("node:assert/strict");
const {
  planMission,
  normalizeGeometry,
  segmentInsideGeometry,
} = require("../src/mission-planner");

const settings = {
  sensor: "rgb",
  altitude: 120,
  speed: 8,
  frontOverlap: 75,
  sideOverlap: 70,
};
const polygon = {
  type: "Polygon",
  coordinates: [
    [
      [37.61, 55.75],
      [37.63, 55.75],
      [37.63, 55.76],
      [37.61, 55.76],
      [37.61, 55.75],
    ],
  ],
};

test("supports polygon holes and keeps survey segments inside allowed area", () => {
  const geometry = {
    type: "Polygon",
    coordinates: [
      polygon.coordinates[0],
      [
        [37.617, 55.753],
        [37.623, 55.753],
        [37.623, 55.757],
        [37.617, 55.757],
        [37.617, 55.753],
      ],
    ],
  };
  const result = planMission({ geometry, mode: "survey", settings });
  assert.equal(result.errors, undefined);
  assert.ok(
    result.plan.segments.every((segment) =>
      segmentInsideGeometry(segment, normalizeGeometry({ geometry })),
    ),
  );
});
test("supports inspection and corridor modes", () => {
  const inspection = planMission({
    geometry: polygon,
    mode: "inspection",
    settings,
  });
  assert.equal(inspection.errors, undefined);
  assert.ok(inspection.plan.points.length > 0);
  const corridor = planMission({
    geometry: {
      type: "LineString",
      coordinates: [
        [37.61, 55.75],
        [37.62, 55.755],
        [37.63, 55.76],
      ],
    },
    mode: "corridor",
    settings,
  });
  assert.equal(corridor.errors, undefined);
  assert.equal(corridor.plan.segments.length, 2);
});
test("supports multipolygon geometry and angle alternatives", () => {
  const multi = {
    type: "MultiPolygon",
    coordinates: [
      [polygon.coordinates[0]],
      [
        [
          [37.64, 55.75],
          [37.65, 55.75],
          [37.65, 55.76],
          [37.64, 55.76],
          [37.64, 55.75],
        ],
      ],
    ],
  };
  const result = planMission({ geometry: multi, mode: "survey", settings });
  assert.equal(result.errors, undefined);
  assert.ok(result.plan.alternatives.length >= 2);
  assert.ok(result.plan.orientationDegrees >= 0);
});
