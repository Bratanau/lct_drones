const EARTH_RADIUS = 6378137;
const SENSOR_SWATH_FACTORS = {
  rgb: 0.68,
  multispectral: 0.47,
  thermal: 0.52,
  lidar: 1.1,
};
const MODES = new Set(["survey", "inspection", "corridor", "lidar"]);

function normalizeGeometry(input) {
  if (Array.isArray(input.boundary))
    return {
      type: "MultiPolygon",
      polygons: [{ outer: cleanRing(input.boundary), holes: [] }],
    };
  const geometry = input.geometry?.type
    ? input.geometry
    : input.geometry || input;
  if (!geometry?.type) throw new Error("Не передана геометрия работ.");
  if (geometry.type === "LineString")
    return {
      type: "LineString",
      coordinates: geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    };
  const source =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : null;
  if (!source)
    throw new Error("Поддерживаются Polygon, MultiPolygon и LineString.");
  return {
    type: "MultiPolygon",
    polygons: source.map((rings) => ({
      outer: cleanRing(rings[0].map(([lng, lat]) => [lat, lng])),
      holes: rings
        .slice(1)
        .map((ring) => cleanRing(ring.map(([lng, lat]) => [lat, lng]))),
    })),
  };
}
function cleanRing(ring) {
  const points = ring.map((point) => [Number(point[0]), Number(point[1])]);
  if (points.length > 1 && samePoint(points[0], points.at(-1))) points.pop();
  return points;
}
function validateMission(input) {
  const errors = [];
  let geometry;
  try {
    geometry = normalizeGeometry(input);
  } catch (error) {
    errors.push(error.message);
    return errors;
  }
  if (geometry.type === "LineString") {
    if (
      geometry.coordinates.length < 2 ||
      geometry.coordinates.some(invalidPoint)
    )
      errors.push("Коридор должен содержать не менее двух корректных точек.");
  } else {
    if (!geometry.polygons.length) errors.push("Контур работ пуст.");
    geometry.polygons.forEach((polygon, index) => {
      if (polygon.outer.length < 3 || polygon.outer.some(invalidPoint))
        errors.push(`Внешнее кольцо ${index + 1} некорректно.`);
      if (polygonSelfIntersects(polygon.outer))
        errors.push(`Внешнее кольцо ${index + 1} имеет самопересечения.`);
      polygon.holes.forEach((hole, holeIndex) => {
        if (
          hole.length < 3 ||
          hole.some(invalidPoint) ||
          polygonSelfIntersects(hole)
        )
          errors.push(
            `Отверстие ${holeIndex + 1} в полигоне ${index + 1} некорректно.`,
          );
        if (hole.some((point) => !pointInRing(point, polygon.outer)))
          errors.push(
            `Отверстие ${holeIndex + 1} находится вне внешнего кольца.`,
          );
      });
    });
  }
  const settings = input.settings || {};
  if (!SENSOR_SWATH_FACTORS[settings.sensor])
    errors.push("Укажите поддерживаемый сенсор.");
  [
    ["altitude", 20, 500],
    ["speed", 1, 30],
    ["frontOverlap", 50, 95],
    ["sideOverlap", 50, 95],
  ].forEach(([key, min, max]) => {
    const value = Number(settings[key]);
    if (!Number.isFinite(value) || value < min || value > max)
      errors.push(`Параметр ${key} должен быть в диапазоне ${min}-${max}.`);
  });
  if (input.mode && !MODES.has(input.mode))
    errors.push("Неизвестный режим задания.");
  return errors;
}

function planMission(input, context = {}) {
  const errors = validateMission(input);
  if (errors.length) return { errors };
  const geometry = normalizeGeometry(input);
  const settings = normalizeSettings(input.settings);
  const platform = normalizePlatform(context.platform);
  const mode = input.mode || (settings.sensor === "lidar" ? "lidar" : "survey");
  const areaM2 =
    geometry.type === "MultiPolygon"
      ? geometry.polygons.reduce(
          (sum, polygon) =>
            sum +
            geodesicArea(polygon.outer) -
            polygon.holes.reduce(
              (holes, hole) => holes + geodesicArea(hole),
              0,
            ),
          0,
        )
      : 0;
  if (areaM2 > 20_000_000)
    return { errors: ["Площадь контура превышает лимит 2 000 га."] };
  const safety = safetyChecks(
    input,
    geometry,
    settings,
    platform,
    context.restrictedZones || [],
  );
  if (safety.blocking.length) return { errors: safety.blocking, safety };
  let candidate;
  if (mode === "inspection") candidate = inspectionPlan(geometry, settings);
  else if (mode === "corridor") candidate = corridorPlan(geometry, settings);
  else candidate = surveyPlan(geometry, settings, mode);
  if (!candidate.segments.length)
    return {
      errors: [
        "По указанной геометрии не удалось построить безопасные проходы.",
      ],
      safety,
    };
  const battery = splitFlights(candidate.segments, settings, platform);
  const totalDistanceM =
    candidate.coverageDistanceM +
    candidate.transitDistanceM +
    candidate.turnPenaltyM;
  const warnings = [
    ...safety.warnings,
    ...recommendations(areaM2, settings, candidate, battery, mode),
  ];
  return {
    plan: {
      mode,
      orientationDegrees: candidate.angle,
      orientation: orientationLabel(candidate.angle),
      spacingM: round(candidate.spacingM, 1),
      areaM2: round(areaM2, 1),
      coverageDistanceM: round(candidate.coverageDistanceM, 1),
      transitDistanceM: round(candidate.transitDistanceM, 1),
      totalDistanceM: round(totalDistanceM, 1),
      durationSeconds: Math.ceil(totalDistanceM / settings.speed),
      segments: candidate.segments,
      points: candidate.points || [],
      flights: battery.flights,
      battery: battery.summary,
      alternatives: candidate.alternatives || [],
      recommendations: warnings,
      safety,
    },
  };
}
function surveyPlan(geometry, settings, mode) {
  if (geometry.type !== "MultiPolygon") return { segments: [] };
  const center = geometryCenter(geometry);
  const spacingM = Math.max(
    5,
    settings.altitude *
      SENSOR_SWATH_FACTORS[settings.sensor] *
      (1 - settings.sideOverlap / 100),
  );
  const candidates = [];
  for (let angle = 0; angle < 180; angle += 15)
    candidates.push(buildGridCandidate(geometry, center, spacingM, angle));
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  best.alternatives = candidates.slice(0, 4).map((candidate) => ({
    orientationDegrees: candidate.angle,
    totalDistanceM: round(candidate.totalDistanceM, 1),
    score: round(candidate.score, 1),
  }));
  if (mode === "lidar") best.spacingM = Math.max(4, spacingM * 0.8);
  return best;
}
function buildGridCandidate(geometry, center, spacingM, angle) {
  const rotated = geometry.polygons.map((polygon) => ({
    outer: polygon.outer.map((point) => rotate(project(point, center), -angle)),
    holes: polygon.holes.map((hole) =>
      hole.map((point) => rotate(project(point, center), -angle)),
    ),
  }));
  const ys = rotated.flatMap((polygon) =>
    polygon.outer.map((point) => point.y),
  );
  const segments = [];
  let reverse = false;
  for (
    let y = Math.min(...ys) + spacingM / 2;
    y < Math.max(...ys);
    y += spacingM
  ) {
    for (const polygon of rotated) {
      const ranges = subtractIntervals(
        intervalsAtY(polygon.outer, y),
        polygon.holes.flatMap((hole) => intervalsAtY(hole, y)),
      );
      for (const [start, end] of ranges) {
        if (end - start < 1) continue;
        const endpoints = [
          { x: start, y },
          { x: end, y },
        ];
        if (reverse) endpoints.reverse();
        const segment = endpoints.map((point) =>
          unproject(rotate(point, angle), center),
        );
        if (segmentInsideGeometry(segment, geometry)) segments.push(segment);
        reverse = !reverse;
      }
    }
  }
  const ordered = orderSegments(segments);
  const coverageDistanceM = ordered.reduce(
    (sum, segment) => sum + distance(segment[0], segment[1]),
    0,
  );
  const transitDistanceM = ordered
    .slice(1)
    .reduce(
      (sum, segment, index) => sum + distance(ordered[index][1], segment[0]),
      0,
    );
  const turnPenaltyM =
    Math.max(0, ordered.length - 1) * Math.min(20, spacingM * 0.75);
  const totalDistanceM = coverageDistanceM + transitDistanceM + turnPenaltyM;
  return {
    angle,
    spacingM,
    segments: ordered,
    coverageDistanceM,
    transitDistanceM,
    turnPenaltyM,
    totalDistanceM,
    score: totalDistanceM + ordered.length * 4,
  };
}
function inspectionPlan(geometry, settings) {
  if (geometry.type !== "MultiPolygon") return { segments: [] };
  const center = geometryCenter(geometry);
  const step = Math.max(10, settings.altitude * 0.5);
  const points = [];
  const projected = geometry.polygons.flatMap((polygon) =>
    polygon.outer.map((point) => project(point, center)),
  );
  const xs = projected.map((point) => point.x),
    ys = projected.map((point) => point.y);
  for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step)
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) {
      const point = unproject({ x, y }, center);
      if (pointInGeometry(point, geometry)) points.push(point);
    }
  const segments = points.map((point) => [point, point]);
  return {
    angle: 0,
    spacingM: step,
    points,
    segments,
    coverageDistanceM: 0,
    transitDistanceM: points
      .slice(1)
      .reduce((sum, point, index) => sum + distance(points[index], point), 0),
    turnPenaltyM: 0,
  };
}
function corridorPlan(geometry, settings) {
  if (geometry.type !== "LineString") return { segments: [] };
  const segments = geometry.coordinates
    .slice(1)
    .map((point, index) => [geometry.coordinates[index], point]);
  const coverageDistanceM = segments.reduce(
    (sum, segment) => sum + distance(segment[0], segment[1]),
    0,
  );
  return {
    angle: null,
    spacingM: Math.max(10, settings.altitude * 0.5),
    segments,
    coverageDistanceM,
    transitDistanceM: 0,
    turnPenaltyM: 0,
  };
}
function safetyChecks(input, geometry, settings, platform, restrictedZones) {
  const blocking = [];
  const warnings = [];
  if (
    settings.altitude > platform.maxAltitudeM ||
    settings.altitude < platform.minAltitudeM
  )
    blocking.push(
      `Высота должна быть в диапазоне ${platform.minAltitudeM}-${platform.maxAltitudeM} м для выбранной платформы.`,
    );
  if (settings.speed > platform.maxSpeedMS)
    blocking.push(
      `Скорость превышает ограничение платформы ${platform.maxSpeedMS} м/с.`,
    );
  if (input.terrainElevationM === undefined)
    warnings.push(
      "Нет данных DEM: высота рассчитывается относительно точки взлёта, а не рельефа.",
    );
  if (
    geometry.type === "MultiPolygon" &&
    restrictedZones.some((zone) =>
      geometry.polygons.some((polygon) =>
        polygon.outer.some((point) =>
          pointInGeometry(point, normalizeGeometry({ geometry: zone })),
        ),
      ),
    )
  )
    blocking.push("Контур пересекает запрещённую зону.");
  return { blocking, warnings };
}
function splitFlights(segments, settings, platform) {
  const usableSeconds =
    platform.flightMinutes * 60 * (1 - platform.reservePercent / 100);
  const maxDistance = Math.min(
    platform.maxRangeM,
    usableSeconds * settings.speed,
  );
  const flights = [];
  let current = [];
  let length = 0;
  for (const segment of segments) {
    const segmentLength = distance(segment[0], segment[1]);
    if (current.length && length + segmentLength > maxDistance) {
      flights.push(current);
      current = [];
      length = 0;
    }
    current.push(segment);
    length += segmentLength;
  }
  if (current.length) flights.push(current);
  return {
    flights: flights.map((segmentsForFlight, index) => ({
      number: index + 1,
      segments: segmentsForFlight,
      distanceM: round(
        segmentsForFlight.reduce(
          (sum, segment) => sum + distance(segment[0], segment[1]),
          0,
        ),
        1,
      ),
    })),
    summary: {
      flights: Math.max(1, flights.length),
      usableFlightSeconds: usableSeconds,
      reservePercent: platform.reservePercent,
      maxDistanceM: round(maxDistance, 1),
    },
  };
}
function normalizeSettings(raw) {
  return {
    sensor: raw.sensor,
    altitude: Number(raw.altitude),
    speed: Number(raw.speed),
    frontOverlap: Number(raw.frontOverlap),
    sideOverlap: Number(raw.sideOverlap),
  };
}
function normalizePlatform(raw = {}) {
  return {
    id: raw.id || "generic-quad",
    name: raw.name || "Универсальный квадрокоптер",
    maxAltitudeM: Number(raw.maxAltitudeM || 500),
    minAltitudeM: Number(raw.minAltitudeM || 20),
    maxSpeedMS: Number(raw.maxSpeedMS || 18),
    maxRangeM: Number(raw.maxRangeM || 12000),
    flightMinutes: Number(raw.flightMinutes || 28),
    reservePercent: Number(raw.reservePercent || 20),
    batteryWh: Number(raw.batteryWh || 180),
  };
}
function intervalsAtY(ring, y) {
  const hits = [];
  ring.forEach((a, index) => {
    const b = ring[(index + 1) % ring.length];
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y))
      hits.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
  });
  hits.sort((a, b) => a - b);
  const intervals = [];
  for (let index = 0; index + 1 < hits.length; index += 2)
    intervals.push([hits[index], hits[index + 1]]);
  return intervals;
}
function subtractIntervals(base, cuts) {
  let result = base;
  for (const [cutStart, cutEnd] of cuts)
    result = result.flatMap(([start, end]) =>
      cutEnd <= start || cutStart >= end
        ? [[start, end]]
        : [
            [start, Math.max(start, cutStart)],
            [Math.min(end, cutEnd), end],
          ].filter(([a, b]) => b - a > 0.01),
    );
  return result;
}
function orderSegments(segments) {
  if (!segments.length) return [];
  const pending = [...segments];
  const ordered = [pending.shift()];
  while (pending.length) {
    const previous = ordered.at(-1)[1];
    let bestIndex = 0,
      bestReverse = false,
      bestDistance = Infinity;
    pending.forEach((segment, index) =>
      [
        [segment[0], false],
        [segment[1], true],
      ].forEach(([point, reverse]) => {
        const d = distance(previous, point);
        if (d < bestDistance) {
          bestIndex = index;
          bestReverse = reverse;
          bestDistance = d;
        }
      }),
    );
    const next = pending.splice(bestIndex, 1)[0];
    ordered.push(bestReverse ? [next[1], next[0]] : next);
  }
  return ordered;
}
function segmentInsideGeometry(segment, geometry) {
  for (let t = 0.01; t < 1; t += 0.1)
    if (
      !pointInGeometry(
        [
          segment[0][0] + (segment[1][0] - segment[0][0]) * t,
          segment[0][1] + (segment[1][1] - segment[0][1]) * t,
        ],
        geometry,
      )
    )
      return false;
  return true;
}
function pointInGeometry(point, geometry) {
  return geometry.polygons.some(
    (polygon) =>
      pointInRing(point, polygon.outer) &&
      !polygon.holes.some((hole) => pointInRing(point, hole)),
  );
}
function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
function geometryCenter(geometry) {
  const points = geometry.polygons.flatMap((polygon) => polygon.outer);
  return points.reduce(
    (sum, point) => [
      sum[0] + point[0] / points.length,
      sum[1] + point[1] / points.length,
    ],
    [0, 0],
  );
}
function invalidPoint(point) {
  return (
    !Array.isArray(point) ||
    point.length !== 2 ||
    !point.every(Number.isFinite) ||
    Math.abs(point[0]) > 90 ||
    Math.abs(point[1]) > 180
  );
}
function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}
function project([lat, lng], center) {
  return {
    x: (lng - center[1]) * 111320 * Math.cos((center[0] * Math.PI) / 180),
    y: (lat - center[0]) * 111320,
  };
}
function unproject(point, center) {
  return [
    point.y / 111320 + center[0],
    point.x / (111320 * Math.cos((center[0] * Math.PI) / 180)) + center[1],
  ];
}
function rotate(point, angle) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  };
}
function distance(a, b) {
  const dLat = ((b[0] - a[0]) * Math.PI) / 180,
    dLng = ((b[1] - a[1]) * Math.PI) / 180,
    h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a[0] * Math.PI) / 180) *
        Math.cos((b[0] * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}
function geodesicArea(points) {
  let sum = 0;
  points.forEach((a, index) => {
    const b = points[(index + 1) % points.length];
    sum +=
      (((b[1] - a[1]) * Math.PI) / 180) *
      (2 + Math.sin((a[0] * Math.PI) / 180) + Math.sin((b[0] * Math.PI) / 180));
  });
  return Math.abs((sum * EARTH_RADIUS ** 2) / 2);
}
function polygonSelfIntersects(points) {
  if (points.length < 4) return false;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === points.length - 1))
        continue;
      if (
        segmentsIntersect(
          points[i],
          points[(i + 1) % points.length],
          points[j],
          points[(j + 1) % points.length],
        )
      )
        return true;
    }
  return false;
}
function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) =>
    (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]);
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  return abC > 0 !== abD > 0 && cdA > 0 !== cdB > 0;
}
function orientationLabel(angle) {
  return angle === null ? "по оси коридора" : `${round(angle, 0)}°`;
}
function recommendations(areaM2, settings, candidate, battery, mode) {
  const messages = [
    mode === "corridor"
      ? "Маршрут построен по оси коридора."
      : `Выбран угол сетки ${orientationLabel(candidate.angle)} по минимальной оценочной длине.`,
  ];
  if (battery.summary.flights > 1)
    messages.push(
      `Маршрут разделён на ${battery.summary.flights} вылета с резервом ${battery.summary.reservePercent}%.`,
    );
  if (settings.frontOverlap < 70)
    messages.push(
      "Продольное перекрытие ниже 70%: проверьте требуемое качество фотограмметрии.",
    );
  if (settings.sensor === "lidar")
    messages.push(
      "Для LiDAR применена уменьшенная ширина полосы; уточните требуемую плотность точек в настройках платформы.",
    );
  if (areaM2 && areaM2 < 2000)
    messages.push("Участок малый: возможно снижение высоты для детализации.");
  return messages;
}
function round(value, digits) {
  return Number(value.toFixed(digits));
}
module.exports = {
  normalizeGeometry,
  validateMission,
  planMission,
  geodesicArea,
  distance,
  pointInGeometry,
  segmentInsideGeometry,
};
