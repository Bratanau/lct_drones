const COMMAND = {
  WAYPOINT: 16,
  RETURN_TO_LAUNCH: 21,
};
const FRAME = 3;

function waypointRow({
  sequence,
  current = 0,
  command,
  latitude,
  longitude,
  altitude,
}) {
  return [
    sequence,
    current,
    FRAME,
    command,
    0,
    0,
    0,
    0,
    Number(latitude).toFixed(7),
    Number(longitude).toFixed(7),
    Number(altitude).toFixed(2),
    1,
  ].join("\t");
}

function missionPlannerWpl(assignment, altitude = 120) {
  const [homeLat, homeLng] = assignment.home;
  const lines = ["QGC WPL 110"];
  let sequence = 0;

  lines.push(
    waypointRow({
      sequence: sequence++,
      current: 1,
      command: COMMAND.WAYPOINT,
      latitude: homeLat,
      longitude: homeLng,
      altitude,
    }),
  );
  for (const segment of assignment.segments) {
    for (const [latitude, longitude] of segment) {
      lines.push(
        waypointRow({
          sequence: sequence++,
          command: COMMAND.WAYPOINT,
          latitude,
          longitude,
          altitude,
        }),
      );
    }
  }
  lines.push(
    waypointRow({
      sequence,
      command: COMMAND.RETURN_TO_LAUNCH,
      latitude: homeLat,
      longitude: homeLng,
      altitude,
    }),
  );
  return lines.join("\n");
}

module.exports = { missionPlannerWpl, waypointRow };
