const test = require('node:test');
const assert = require('node:assert/strict');
const { geodesicArea, planMission, validateMission } = require('../planner');

const mission = {
  title: 'Тестовая миссия',
  mode: 'survey',
  boundary: [[55.75, 37.61], [55.75, 37.63], [55.76, 37.63], [55.76, 37.61]],
  settings: { sensor: 'rgb', altitude: 120, speed: 8, frontOverlap: 75, sideOverlap: 70 }
};

test('calculates an approximate geodesic area', () => {
  const area = geodesicArea(mission.boundary);
  assert.ok(area > 1_000_000 && area < 2_000_000);
});
test('rejects invalid mission parameters', () => {
  const errors = validateMission({ ...mission, settings: { ...mission.settings, speed: 100 } });
  assert.ok(errors.some(error => error.includes('speed')));
});
test('chooses an orientation and produces clipped survey segments', () => {
  const result = planMission(mission);
  assert.equal(result.errors, undefined);
  assert.ok(result.plan.segments.length > 0);
  assert.ok(result.plan.totalDistanceM > result.plan.coverageDistanceM);
  assert.match(result.plan.orientation, /east-west|north-south/);
});
test('rejects self-intersecting boundary', () => {
  const errors = validateMission({ ...mission, boundary: [[55.75, 37.61], [55.76, 37.63], [55.75, 37.63], [55.76, 37.61]] });
  assert.ok(errors.some(error => error.includes('самопересечений')));
});
