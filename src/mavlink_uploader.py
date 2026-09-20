"""Upload a MAVLink mission and start it after an explicit backend request."""

import asyncio
import json
import sys
import time
from typing import Any

from .constants import DEFAULT_CAMERA_TRIGGER_DISTANCE_M
from .schemas import MavlinkMissionRequest

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

try:
    from pymavlink import mavutil
except ImportError:  # Allows the rest of the planner to run without SITL tooling.
    mavutil = None


class MavlinkUploadError(RuntimeError):
    """A flight controller did not complete the expected mission protocol step."""


def _wait_message(connection: Any, message_types: list[str], timeout_seconds: float) -> Any:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        message = connection.recv_match(type=message_types, blocking=False)
        if message is not None:
            return message
        time.sleep(0.05)
    raise MavlinkUploadError(
        f"Таймаут ожидания MAVLink: {', '.join(message_types)}."
    )


def _mission_item(
    sequence: int,
    command: int,
    latitude: float,
    longitude: float,
    altitude_m: float,
    *,
    current: int = 0,
    param1: float = 0.0,
) -> dict[str, Any]:
    return {
        "sequence": sequence,
        "command": command,
        "latitude": latitude,
        "longitude": longitude,
        "altitude_m": altitude_m,
        "current": current,
        "param1": param1,
    }


def build_mission_items(
    waypoints_list: list[list[list[float]]],
    home: list[float],
    altitude_m: float,
    transit_altitude_m: float,
    camera_trigger_distance_m: float = DEFAULT_CAMERA_TRIGGER_DISTANCE_M,
) -> list[dict[str, Any]]:
    """Create an uploadable mission with transit altitude and camera trigger boundaries."""
    if len(home) != 2:
        raise MavlinkUploadError("Для LIVE START нужна домашняя площадка БВС.")
    if not waypoints_list:
        raise MavlinkUploadError("У БВС нет назначенных галсов.")

    home_lat, home_lng = map(float, home)
    items = [
        _mission_item(0, mavutil.mavlink.MAV_CMD_NAV_WAYPOINT, home_lat, home_lng, transit_altitude_m, current=1),
        _mission_item(1, mavutil.mavlink.MAV_CMD_NAV_TAKEOFF, home_lat, home_lng, transit_altitude_m),
    ]
    sequence = 2
    for segment in waypoints_list:
        if len(segment) < 2:
            continue
        # Start and stop camera triggering around each assigned survey line.
        items.append(_mission_item(sequence, mavutil.mavlink.MAV_CMD_DO_SET_CAM_TRIGG_DIST, 0.0, 0.0, 0.0, param1=camera_trigger_distance_m))
        sequence += 1
        for latitude, longitude in segment:
            items.append(_mission_item(sequence, mavutil.mavlink.MAV_CMD_NAV_WAYPOINT, float(latitude), float(longitude), altitude_m))
            sequence += 1
        items.append(_mission_item(sequence, mavutil.mavlink.MAV_CMD_DO_SET_CAM_TRIGG_DIST, 0.0, 0.0, 0.0, param1=0.0))
        sequence += 1
    items.append(_mission_item(sequence, mavutil.mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH, home_lat, home_lng, transit_altitude_m))
    return items


def _upload_and_start_sync(mav_connection_str: str, waypoints_list: list[list[list[float]]], home: list[float], altitude_m: float, transit_altitude_m: float, timeout_seconds: float, auto_mode: int, camera_trigger_distance_m: float) -> dict[str, Any]:
    if mavutil is None:
        raise MavlinkUploadError("pymavlink не установлен. Выполните: pip install pymavlink")

    connection = mavutil.mavlink_connection(mav_connection_str, autoreconnect=False)
    try:
        heartbeat = _wait_message(connection, ["HEARTBEAT"], timeout_seconds)
        target_system = heartbeat.get_srcSystem()
        target_component = heartbeat.get_srcComponent()
        items = build_mission_items(waypoints_list, home, altitude_m, transit_altitude_m, camera_trigger_distance_m)

        connection.mav.mission_clear_all_send(target_system, target_component, mavutil.mavlink.MAV_MISSION_TYPE_MISSION)
        _wait_message(connection, ["MISSION_ACK"], timeout_seconds)
        connection.mav.mission_count_send(target_system, target_component, len(items), mavutil.mavlink.MAV_MISSION_TYPE_MISSION)

        for expected_sequence in range(len(items)):
            request = _wait_message(connection, ["MISSION_REQUEST", "MISSION_REQUEST_INT"], timeout_seconds)
            requested_sequence = request.seq
            if requested_sequence != expected_sequence:
                raise MavlinkUploadError(f"Контроллер запросил точку {requested_sequence}, ожидалась {expected_sequence}.")
            item = items[requested_sequence]
            connection.mav.mission_item_int_send(
                target_system,
                target_component,
                item["sequence"],
                mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
                item["command"],
                item["current"],
                1,
                item["param1"],
                0.0,
                0.0,
                0.0,
                int(round(item["latitude"] * 10_000_000)),
                int(round(item["longitude"] * 10_000_000)),
                item["altitude_m"],
                mavutil.mavlink.MAV_MISSION_TYPE_MISSION,
            )

        acknowledgement = _wait_message(connection, ["MISSION_ACK"], timeout_seconds)
        if acknowledgement.type != mavutil.mavlink.MAV_MISSION_ACCEPTED:
            raise MavlinkUploadError(f"Контроллер отклонил миссию, код MAV_MISSION_RESULT: {acknowledgement.type}.")

        connection.mav.command_long_send(target_system, target_component, mavutil.mavlink.MAV_CMD_DO_SET_MODE, 0, mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, auto_mode, 0, 0, 0, 0, 0)
        connection.mav.command_long_send(target_system, target_component, mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 0, 1, 0, 0, 0, 0, 0, 0)
        return {"ok": True, "targetSystem": target_system, "targetComponent": target_component, "uploadedItems": len(items), "startedAt": time.time()}
    finally:
        connection.close()


async def upload_and_start_mission(request: MavlinkMissionRequest) -> dict[str, Any]:
    """Wait for a controller, upload mission items, select AUTO and arm the vehicle."""
    return await asyncio.to_thread(
        _upload_and_start_sync,
        request.connection,
        request.segments,
        request.home,
        request.altitudeM,
        request.transitAltitudeM,
        request.timeoutSeconds,
        request.autoMode,
        request.cameraTriggerDistanceM,
    )


async def main() -> None:
    try:
        payload = MavlinkMissionRequest.model_validate(json.loads(sys.stdin.read() or "{}"))
        result = await upload_and_start_mission(payload)
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({"errors": [str(error)]}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
