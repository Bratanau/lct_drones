const EARTH_RADIUS = 6378137;
const SENSOR_SWATH_FACTORS = { rgb: 0.68, multispectral: 0.47, thermal: 0.52, lidar: 1.1 };

function validateMission(input) {
  const errors = [];
  const boundary = input.boundary;
  if (!Array.isArray(boundary) || boundary.length < 3) errors.push('Контур должен содержать не менее трёх точек.');
  if (Array.isArray(boundary)) {
    boundary.forEach((point, index) => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || Math.abs(point[0]) > 90 || Math.abs(point[1]) > 180) errors.push(`Некорректная координата в точке ${index + 1}.`);
    });
    if (boundary.length >= 3 && polygonSelfIntersects(boundary)) errors.push('Контур не должен иметь самопересечений.');
  }
  const settings = input.settings || {};
  if (!SENSOR_SWATH_FACTORS[settings.sensor]) errors.push('Укажите поддерживаемый сенсор.');
  [['altitude', 20, 500], ['speed', 1, 30], ['frontOverlap', 50, 95], ['sideOverlap', 50, 95]].forEach(([key, min, max]) => {
    const value = Number(settings[key]);
    if (!Number.isFinite(value) || value < min || value > max) errors.push(`Параметр ${key} должен быть в диапазоне ${min}-${max}.`);
  });
  return errors;
}

function planMission(input) {
  const errors = validateMission(input);
  if (errors.length) return { errors };
  const settings = normalizeSettings(input.settings);
  const areaM2 = geodesicArea(input.boundary);
  if (areaM2 > 20_000_000) return { errors: ['Площадь контура превышает лимит MVP: 2 000 га.'] };
  const candidates = ['east-west', 'north-south'].map(orientation => buildCandidate(input.boundary, settings, orientation));
  const plan = candidates.sort((a, b) => a.score - b.score)[0];
  const battery = estimateBattery(plan, settings);
  return {
    plan: {
      orientation: plan.orientation,
      spacingM: round(plan.spacingM, 1),
      areaM2: round(areaM2, 1),
      coverageDistanceM: round(plan.coverageDistanceM, 1),
      transitDistanceM: round(plan.transitDistanceM, 1),
      totalDistanceM: round(plan.totalDistanceM, 1),
      durationSeconds: Math.ceil(plan.totalDistanceM / settings.speed),
      segments: plan.segments,
      battery,
      alternatives: candidates.map(candidate => ({ orientation: candidate.orientation, totalDistanceM: round(candidate.totalDistanceM, 1), score: round(candidate.score, 1) })),
      recommendations: recommendations(areaM2, settings, plan, battery)
    }
  };
}

function normalizeSettings(raw) {
  return { sensor: raw.sensor, altitude: Number(raw.altitude), speed: Number(raw.speed), frontOverlap: Number(raw.frontOverlap), sideOverlap: Number(raw.sideOverlap) };
}

function buildCandidate(boundary, settings, orientation) {
  const center = centroid(boundary);
  const projected = boundary.map(([lat, lng]) => project(lat, lng, center));
  const spacingM = Math.max(5, settings.altitude * SENSOR_SWATH_FACTORS[settings.sensor] * (1 - settings.sideOverlap / 100));
  const scanHorizontal = orientation === 'east-west';
  const values = projected.map(point => scanHorizontal ? point.y : point.x);
  const min = Math.min(...values), max = Math.max(...values);
  const segments = [];
  let reverse = false;
  for (let scan = min + spacingM / 2; scan < max; scan += spacingM) {
    const intersections = lineIntersections(projected, scan, scanHorizontal);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const endpoints = scanHorizontal ? [{ x: intersections[i], y: scan }, { x: intersections[i + 1], y: scan }] : [{ x: scan, y: intersections[i] }, { x: scan, y: intersections[i + 1] }];
      if (reverse) endpoints.reverse();
      segments.push(endpoints.map(point => unproject(point, center)));
      reverse = !reverse;
    }
  }
  const coverageDistanceM = segments.reduce((sum, segment) => sum + distance(segment[0], segment[1]), 0);
  const transitDistanceM = segments.slice(1).reduce((sum, segment, index) => sum + distance(segments[index][1], segment[0]), 0);
  const turnPenaltyM = Math.max(0, segments.length - 1) * Math.min(20, spacingM * 0.75);
  const totalDistanceM = coverageDistanceM + transitDistanceM + turnPenaltyM;
  return { orientation, spacingM, segments, coverageDistanceM, transitDistanceM, totalDistanceM, score: totalDistanceM + segments.length * 4 };
}

function lineIntersections(polygon, value, horizontal) {
  const hits = [];
  polygon.forEach((a, index) => {
    const b = polygon[(index + 1) % polygon.length];
    const aAxis = horizontal ? a.y : a.x;
    const bAxis = horizontal ? b.y : b.x;
    if ((aAxis <= value && bAxis > value) || (bAxis <= value && aAxis > value)) {
      const ratio = (value - aAxis) / (bAxis - aAxis);
      hits.push(horizontal ? a.x + ratio * (b.x - a.x) : a.y + ratio * (b.y - a.y));
    }
  });
  return hits.sort((a, b) => a - b);
}

function estimateBattery(plan, settings) {
  const usableFlightSeconds = 22 * 60;
  const flightSeconds = plan.totalDistanceM / settings.speed;
  const flights = Math.max(1, Math.ceil(flightSeconds / usableFlightSeconds));
  return { usableFlightSeconds, flights, reservePercent: 20, estimatedFlightSeconds: Math.ceil(flightSeconds) };
}
function recommendations(areaM2, settings, plan, battery) {
  const items = [`Выбрана ориентация ${plan.orientation === 'east-west' ? 'восток-запад' : 'север-юг'}: она уменьшает оценочную длину маршрута.`];
  if (battery.flights > 1) items.push(`Потребуется ${battery.flights} вылета: план превышает безопасное время одного аккумулятора.`);
  if (settings.frontOverlap < 70) items.push('Продольное перекрытие ниже 70%: проверьте достаточность для фотограмметрии.');
  if (areaM2 < 2000) items.push('Участок малый: снизьте высоту для более детальной съёмки.');
  return items;
}
function centroid(points) { return points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]); }
function project(lat, lng, center) { const y = (lat - center[0]) * 111320; return { x: (lng - center[1]) * 111320 * Math.cos(center[0] * Math.PI / 180), y }; }
function unproject(point, center) { return [point.y / 111320 + center[0], point.x / (111320 * Math.cos(center[0] * Math.PI / 180)) + center[1]]; }
function distance(a, b) { const dLat = (b[0] - a[0]) * Math.PI / 180; const dLng = (b[1] - a[1]) * Math.PI / 180; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLng / 2) ** 2; return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h)); }
function geodesicArea(points) { let sum = 0; points.forEach((a, index) => { const b = points[(index + 1) % points.length]; sum += (b[1] - a[1]) * Math.PI / 180 * (2 + Math.sin(a[0] * Math.PI / 180) + Math.sin(b[0] * Math.PI / 180)); }); return Math.abs(sum * EARTH_RADIUS ** 2 / 2); }
function polygonSelfIntersects(points) { for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) { if (Math.abs(i - j) <= 1 || (i === 0 && j === points.length - 1)) continue; if (segmentsIntersect(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length])) return true; } return false; }
function segmentsIntersect(a, b, c, d) { const cross = (p, q, r) => (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]); const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b); return ((abC > 0) !== (abD > 0)) && ((cdA > 0) !== (cdB > 0)); }
function round(value, digits) { return Number(value.toFixed(digits)); }
module.exports = { validateMission, planMission, geodesicArea, distance };
