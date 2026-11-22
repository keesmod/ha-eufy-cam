"""HomeBase accessories, the chime device and guard mode Off (#275)."""

import hashlib
import importlib.util
import json
import subprocess
import sys
import types
from copy import deepcopy
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from pytest_homeassistant.common import MockConfigEntry

from custom_components.eufy_viewer import (
    async_remove_config_entry_device,
    const,
    recording_file,
)
from custom_components.eufy_viewer.api import BridgeError, BridgeState
from custom_components.eufy_viewer.const import DOMAIN
from custom_components.eufy_viewer.diagnostics import (
    async_get_config_entry_diagnostics,
    support_report,
)

from .conftest import STATE
from .test_alarm import STATION
from .test_config_flow import DATA

FIXTURES = Path(__file__).parent / "fixtures"
FRAME = json.loads((FIXTURES / "state-accessories.json").read_text())
LEGACY_API = FIXTURES / "legacy-0.8.52-api.py.txt"
HB3, SENSOR, BACK, KEYPAD, CHIME = (
    "SYNTHHB30001",
    "SYNTHSENS001",
    "SYNTHSENS002",
    "SYNTHKEYP001",
    "SYNTHCHIM001",
)


def frame(**changes):
    data = deepcopy(FRAME)
    data.update(changes)
    return data


def rows(*items):
    return frame(accessories=list(items))


def row(serial):
    return deepcopy(next(r for r in FRAME["accessories"] if r["serial"] == serial))


def test_shared_frame_parses_every_category_and_reading():
    state = BridgeState.parse(FRAME)
    assert set(state.accessories) == {SENSOR, BACK, KEYPAD, CHIME}
    assert state.accessories_dropped == 0
    sensor = state.accessories[SENSOR]
    assert (sensor.category, sensor.station, sensor.model) == (
        "entry_sensor",
        HB3,
        "T8900",
    )
    assert sensor.readings["open"].value is True
    assert sensor.readings["open"].observed and sensor.readings["open"].live
    assert not sensor.readings["battery_low"].observed
    assert "battery_low" not in state.accessories[BACK].readings
    assert set(state.accessories[KEYPAD].readings) == {"battery_low", "charging"}
    chime = state.accessories[CHIME]
    assert (chime.category, chime.station, chime.readings) == ("chime", None, {})
    station = state.stations[HB3]
    assert station.guard_mode == 6 and station.current_mode == 6
    assert station.modes == [0, 1, 2, 3, 4, 5, 47, 63]
    assert station.extra_modes == [6]
    assert station.settable_modes[-1] == 6


def test_shared_frame_keeps_the_legacy_modes_list():
    # A 0.8.52 integration refuses the whole frame when modes contains 6.
    for station in FRAME["stations"]:
        assert station["modes"] == [0, 1, 2, 3, 4, 5, 47, 63]
        assert 6 not in station["modes"]


def _named(serial, **values):
    return {**row(SENSOR), "serial": serial, **values}


@pytest.mark.parametrize(
    "bad",
    [
        "PRIVATE_SERIAL",
        None,
        _named("../private"),
        _named("X" * 65),
        _named("BAD00001", category="camera"),
        _named("BAD00002", category=None),
        _named("BAD00003", name=7),
        _named("BAD00004", name="x" * 257),
        _named("BAD00005", model=None),
        _named("BAD00006", hardware=1),
        _named("BAD00007", software=None),
        _named("BAD00008", station=None),
        _named("BAD00009", station="UNKNOWNHB"),
        _named("BAD00010", station=["SYNTHHB30001"]),
        _named("BAD00011", readings=[]),
        _named("BAD00012", readings="open"),
        {**row(CHIME), "serial": "BAD00013", "station": HB3},
        {**row(KEYPAD), "serial": "BAD00014", "station": None},
        _named("SYNTHCAM0001"),
        _named(HB3),
    ],
)
def test_a_malformed_row_is_dropped_alone(bad):
    state = BridgeState.parse(frame(accessories=[*FRAME["accessories"], bad]))
    assert set(state.accessories) == {SENSOR, BACK, KEYPAD, CHIME}
    assert state.accessories_dropped == 1
    assert state.cameras and state.stations


def test_dropped_rows_are_logged_by_index_and_reason_only(caplog):
    caplog.set_level("DEBUG", logger="custom_components.eufy_viewer.api")
    frame = rows(row(SENSOR), {"serial": [], "category": "chime"}, row(SENSOR))
    camera = {**row(KEYPAD), "serial": FRAME["cameras"][0]["serial"]}
    frame["accessories"].append(camera)
    state = BridgeState.parse(frame)
    assert state.accessories_dropped == 4
    messages = [
        r.getMessage() for r in caplog.records if "accessory row" in r.getMessage()
    ]
    assert messages == [
        "Dropped accessory row 0: duplicate serial",
        "Dropped accessory row 1: invalid row",
        "Dropped accessory row 2: duplicate serial",
        "Dropped accessory row 3: serial of a camera or station",
    ]
    assert not any(SENSOR in message for message in messages)


def test_a_duplicated_serial_drops_every_copy():
    state = BridgeState.parse(rows(row(SENSOR), row(SENSOR), row(KEYPAD)))
    assert set(state.accessories) == {KEYPAD}
    assert state.accessories_dropped == 2


@pytest.mark.parametrize(
    "value,expected",
    [
        (None, ({}, 0)),
        ("accessories", ({}, 0)),
        ({"serial": SENSOR}, ({}, 0)),
        ([], ({}, 0)),
    ],
)
def test_missing_or_non_list_accessories_mean_none(value, expected):
    state = BridgeState.parse(frame(accessories=value))
    assert (state.accessories, state.accessories_dropped) == expected
    legacy = deepcopy(FRAME)
    del legacy["accessories"]
    assert BridgeState.parse(legacy).accessories == {}


def test_more_than_one_hundred_rows_are_all_dropped():
    many = [_named(f"MANY{i:04d}") for i in range(101)]
    state = BridgeState.parse(rows(*many))
    assert state.accessories == {} and state.accessories_dropped == 101
    state = BridgeState.parse(rows(*many[:100]))
    assert len(state.accessories) == 100


@pytest.mark.parametrize(
    "reading",
    [
        None,
        "on",
        {"value": "true", "source": "p2p", "observed_at": "2026-11-19T10:00:00Z"},
        {"value": 1, "source": "p2p", "observed_at": "2026-11-19T10:00:00Z"},
        {"value": True, "source": "app", "observed_at": "2026-11-19T10:00:00Z"},
        {"value": True, "source": "p2p", "observed_at": "2026-11-19T10:00:00"},
        {"value": True, "source": "p2p", "observed_at": "yesterday"},
        {"value": True, "source": "p2p", "observed_at": 1763546400},
        {"value": True, "source": "p2p", "observed_at": "2026-11-19T10:00:00Z" * 3},
        {"value": True, "source": [], "observed_at": "2026-11-19T10:00:00Z"},
        {"value": True, "source": {}, "observed_at": "2026-11-19T10:00:00Z"},
        {"value": True, "source": ["p2p"], "observed_at": "2026-11-19T10:00:00Z"},
    ],
)
def test_a_malformed_reading_is_dropped_and_the_row_kept(reading):
    if isinstance(reading, dict):
        reading = {**reading, "live": True}
    item = row(SENSOR)
    item["readings"]["open"] = reading
    state = BridgeState.parse(rows(item))
    assert "open" not in state.accessories[SENSOR].readings
    assert "battery_low" in state.accessories[SENSOR].readings
    item["readings"]["open"] = {
        "value": True,
        "source": "push",
        "observed_at": "2026-11-19T10:00:00Z",
        "live": "yes",
    }
    assert "open" not in BridgeState.parse(rows(item)).accessories[SENSOR].readings


def test_a_reading_outside_the_category_is_ignored():
    keypad = row(KEYPAD)
    keypad["readings"]["open"] = row(SENSOR)["readings"]["open"]
    chime = row(CHIME)
    chime["readings"] = {"charging": row(KEYPAD)["readings"]["charging"]}
    state = BridgeState.parse(rows(keypad, chime))
    assert set(state.accessories[KEYPAD].readings) == {"battery_low", "charging"}
    assert state.accessories[CHIME].readings == {}
    assert BridgeState.parse(rows({**chime, "readings": None})).accessories[CHIME]


@pytest.mark.parametrize(
    "extra,expected",
    [
        (None, []),
        ([6], [6]),
        ([6, 6], [6]),
        ([7, "6", 6.0, True, {}, [6]], []),
        ([63, 1], []),
        ("6", []),
        ({"6": True}, []),
    ],
)
def test_extra_modes_keep_known_values_and_never_refuse_the_frame(extra, expected):
    station = {**STATION}
    if extra is not None:
        station["extra_modes"] = extra
    state = BridgeState.parse({**STATE, "stations": [station]})
    assert state.stations["HB3"].extra_modes == expected


def test_off_in_the_legacy_modes_list_still_refuses_the_frame():
    with pytest.raises(BridgeError):
        BridgeState.parse({**STATE, "stations": [{**STATION, "modes": [6]}]})


def _legacy_parser():
    """The 0.8.52 integration parser, loaded on its own package name."""
    package = types.ModuleType("legacy_eufy_viewer")
    package.__path__ = []
    sys.modules["legacy_eufy_viewer"] = package
    sys.modules["legacy_eufy_viewer.const"] = const
    sys.modules["legacy_eufy_viewer.recording_file"] = recording_file
    spec = importlib.util.spec_from_loader("legacy_eufy_viewer.api", loader=None)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["legacy_eufy_viewer.api"] = module
    exec(compile(LEGACY_API.read_text(), "legacy-0.8.52-api.py", "exec"), vars(module))
    return module.BridgeState


# Git blob id of v0.8.52:custom_components/eufy_viewer/api.py. It pins the
# snapshot in checkouts without tags, as in CI.
LEGACY_API_BLOB = "5cfc549ef32d1434a8b20cf0cedee1e0f9e35c95"


def test_the_legacy_snapshot_has_the_0852_blob_id():
    data = LEGACY_API.read_bytes()
    blob = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
    assert blob == LEGACY_API_BLOB


def test_the_legacy_snapshot_is_the_0852_parser():
    try:
        released = subprocess.run(
            ["git", "show", "v0.8.52:custom_components/eufy_viewer/api.py"],
            cwd=Path(__file__).parents[1],
            capture_output=True,
            check=True,
            text=True,
        ).stdout
    except OSError, subprocess.CalledProcessError:
        pytest.skip("The v0.8.52 tag is not in this checkout")
    assert LEGACY_API.read_text() == released


def test_rolling_upgrade_in_both_directions():
    legacy = _legacy_parser()
    # Integration 0.8.52 with bridge 0.8.44 ignores accessories and extra_modes
    # and keeps every camera and station, Off included as the current mode.
    old = legacy.parse(FRAME)
    assert set(old.cameras) == {"SYNTHCAM0001"}
    assert old.stations[HB3].guard_mode == 6
    assert old.stations[HB3].modes == [0, 1, 2, 3, 4, 5, 47, 63]
    assert not hasattr(old, "accessories")
    # Integration 0.8.53 with bridge 0.8.43 has no accessories and no extra modes.
    old_frame = {**STATE, "stations": [STATION]}
    assert legacy.parse(old_frame).stations["HB3"].modes == STATION["modes"]
    new = BridgeState.parse(old_frame)
    assert new.accessories == {} and new.accessories_dropped == 0
    assert new.stations["HB3"].extra_modes == []
    assert new.stations["HB3"].settable_modes == STATION["modes"]


async def _setup(hass, data):
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    with patch(
        "custom_components.eufy_viewer.api.BridgeClient.state",
        AsyncMock(return_value=BridgeState.parse(data)),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return entry


async def _update(hass, entry, data):
    entry.runtime_data.async_set_updated_data(BridgeState.parse(data))
    await hass.async_block_till_done()


async def test_accessory_entities_devices_and_availability(hass):
    with patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"):
        entry = await _setup(hass, FRAME)
        entities = er.async_get(hass)
        devices = dr.async_get(hass)
        expected = {
            "binary_sensor.synthetic_front_door": f"{SENSOR}_open",
            "binary_sensor.synthetic_front_door_battery": f"{SENSOR}_battery_low",
            "binary_sensor.synthetic_back_door": f"{BACK}_open",
            "binary_sensor.synthetic_back_door_battery": f"{BACK}_battery_low",
            "binary_sensor.synthetic_keypad_battery": f"{KEYPAD}_battery_low",
            "binary_sensor.synthetic_keypad_charging": f"{KEYPAD}_charging",
        }
        for entity_id, unique_id in expected.items():
            assert entities.async_get(entity_id).unique_id == unique_id
        door = hass.states.get("binary_sensor.synthetic_front_door")
        assert door.state == "on"
        assert door.attributes["device_class"] == "opening"
        assert door.attributes["source"] == "p2p" and door.attributes["live"] is True
        # A cached cloud value is never shown as the door state.
        back = hass.states.get("binary_sensor.synthetic_back_door")
        assert back.state == "unknown" and "source" not in back.attributes
        battery = hass.states.get("binary_sensor.synthetic_front_door_battery")
        assert battery.state == "off" and battery.attributes["source"] == "cloud"
        assert hass.states.get("binary_sensor.synthetic_back_door_battery").state == (
            "unknown"
        )
        assert hass.states.get("binary_sensor.synthetic_keypad_battery").state == "off"
        assert hass.states.get("binary_sensor.synthetic_keypad_charging").state == "on"
        for entity_id in expected:
            if entity_id not in (
                "binary_sensor.synthetic_front_door",
                "binary_sensor.synthetic_back_door",
            ):
                assert entities.async_get(entity_id).entity_category == "diagnostic"
        homebase = devices.async_get_or_create(
            config_entry_id=entry.entry_id, identifiers={(DOMAIN, HB3)}
        )
        for serial in (SENSOR, BACK, KEYPAD):
            device = devices.async_get_or_create(
                config_entry_id=entry.entry_id, identifiers={(DOMAIN, serial)}
            )
            assert device.via_device_id == homebase.id
            assert device.manufacturer == "Eufy"
        sensor = devices.async_get_or_create(
            config_entry_id=entry.entry_id, identifiers={(DOMAIN, SENSOR)}
        )
        assert (sensor.model, sensor.hw_version, sensor.sw_version) == (
            "T8900",
            "0.0.1",
            None,
        )
        chime = devices.async_get_or_create(
            config_entry_id=entry.entry_id, identifiers={(DOMAIN, CHIME)}
        )
        assert (chime.model, chime.sw_version, chime.via_device_id) == (
            "T8026",
            "1.0.2.7",
            None,
        )
        assert not er.async_entries_for_device(entities, chime.id)
        # No camera, event or sensor entity for an accessory.
        for entity in er.async_entries_for_config_entry(entities, entry.entry_id):
            if entity.unique_id.startswith(("SYNTHSENS", "SYNTHKEYP", "SYNTHCHIM")):
                assert entity.domain == "binary_sensor"

        # The HomeBase connection carries the accessories.
        station = {**FRAME["stations"][0], "connected": False}
        await _update(hass, entry, frame(stations=[station]))
        assert hass.states.get("binary_sensor.synthetic_front_door").state == (
            "unavailable"
        )
        # After a reconnect the last observed value comes back, live false.
        reconnected = deepcopy(FRAME)
        reconnected["accessories"][0]["readings"]["open"]["live"] = False
        await _update(hass, entry, reconnected)
        door = hass.states.get("binary_sensor.synthetic_front_door")
        assert door.state == "on" and door.attributes["live"] is False
        closed = deepcopy(FRAME)
        closed["accessories"][0]["readings"]["open"].update(
            value=False, source="push", observed_at="2026-11-19T10:05:00.000Z"
        )
        await _update(hass, entry, closed)
        door = hass.states.get("binary_sensor.synthetic_front_door")
        assert door.state == "off" and door.attributes["source"] == "push"
        # An accessory that leaves the inventory keeps its registry entry.
        await _update(hass, entry, rows(row(KEYPAD), row(CHIME)))
        assert hass.states.get("binary_sensor.synthetic_front_door").state == (
            "unavailable"
        )
        assert hass.states.get("binary_sensor.synthetic_keypad_charging").state == "on"
        # The device link and entities stay when the inventory comes back.
        await _update(hass, entry, FRAME)
        assert hass.states.get("binary_sensor.synthetic_front_door").state == "on"
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_devices_can_be_removed_only_after_they_left_the_inventory(hass):
    with patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"):
        entry = await _setup(hass, FRAME)
        devices = dr.async_get(hass)

        def device(serial):
            return devices.async_get_or_create(
                config_entry_id=entry.entry_id, identifiers={(DOMAIN, serial)}
            )

        for serial in (SENSOR, CHIME, HB3, "SYNTHCAM0001"):
            assert not await async_remove_config_entry_device(
                hass, entry, device(serial)
            )
        await _update(hass, entry, rows(row(KEYPAD)))
        for serial in (SENSOR, CHIME):
            assert await async_remove_config_entry_device(hass, entry, device(serial))
        assert not await async_remove_config_entry_device(hass, entry, device(KEYPAD))
        assert await hass.config_entries.async_unload(entry.entry_id)
        unloaded = MockConfigEntry(domain=DOMAIN, unique_id="other", data=DATA)
        assert not await async_remove_config_entry_device(
            hass, unloaded, device(SENSOR)
        )


@pytest.mark.parametrize("auth", ["connecting", "error", "verify", "captcha"])
async def test_nothing_is_removable_while_the_bridge_is_not_connected(hass, auth):
    with patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"):
        entry = await _setup(hass, FRAME)
        devices = dr.async_get(hass)
        serials = (SENSOR, CHIME, HB3, "SYNTHCAM0001")
        # A bridge that restarts or needs a login sends an empty inventory.
        await _update(
            hass, entry, frame(auth=auth, cameras=[], stations=[], accessories=[])
        )
        for serial in serials:
            device = devices.async_get_device_by_identifier(
                (DOMAIN, serial), entry.entry_id
            )
            assert device is not None
            assert not await async_remove_config_entry_device(hass, entry, device)
        # A failed update is not an inventory either.
        await _update(hass, entry, rows(row(KEYPAD)))
        entry.runtime_data.async_set_update_error(BridgeError("lost"))
        device = devices.async_get_device_by_identifier(
            (DOMAIN, SENSOR), entry.entry_id
        )
        assert not await async_remove_config_entry_device(hass, entry, device)
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_a_removed_device_returns_with_its_entities(hass):
    with patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"):
        entry = await _setup(hass, FRAME)
        devices, entities = dr.async_get(hass), er.async_get(hass)

        def entity_ids(serial):
            device = devices.async_get_device_by_identifier(
                (DOMAIN, serial), entry.entry_id
            )
            if device is None:
                return None
            return sorted(
                e.entity_id for e in er.async_entries_for_device(entities, device.id)
            )

        before = {s: entity_ids(s) for s in (SENSOR, CHIME, HB3, "SYNTHCAM0001")}
        assert before[SENSOR] and before[HB3] and before["SYNTHCAM0001"]
        assert before[CHIME] == []

        async def remove(serial):
            # The steps of Home Assistant's remove_config_entry_device handler.
            device = devices.async_get_device_by_identifier(
                (DOMAIN, serial), entry.entry_id
            )
            assert await async_remove_config_entry_device(hass, entry, device)
            devices.async_remove_device(device.id)
            await hass.async_block_till_done()
            assert (
                devices.async_get_device_by_identifier((DOMAIN, serial), entry.entry_id)
                is None
            )

        # The camera, the sensor and the chime leave the inventory and are removed.
        await _update(hass, entry, frame(cameras=[], accessories=[row(KEYPAD)]))
        for serial in (SENSOR, CHIME, "SYNTHCAM0001"):
            await remove(serial)
        assert hass.states.get("binary_sensor.synthetic_front_door") is None
        # Then the HomeBase, with everything on it.
        await _update(hass, entry, frame(cameras=[], stations=[], accessories=[]))
        await remove(KEYPAD)
        await remove(HB3)
        # All of them come back without a reload.
        await _update(hass, entry, FRAME)
        assert {s: entity_ids(s) for s in before} == before
        assert hass.states.get("binary_sensor.synthetic_front_door").state == "on"
        sensor = devices.async_get_device_by_identifier(
            (DOMAIN, SENSOR), entry.entry_id
        )
        hb3 = devices.async_get_device_by_identifier((DOMAIN, HB3), entry.entry_id)
        assert sensor.via_device_id == hb3.id
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_accessories_link_again_when_their_removed_homebase_returns(hass):
    with patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"):
        entry = await _setup(hass, FRAME)
        devices = dr.async_get(hass)

        def device(serial):
            return devices.async_get_device_by_identifier(
                (DOMAIN, serial), entry.entry_id
            )

        # The HomeBase leaves with its sensors and keypad, and only it is removed.
        await _update(hass, entry, frame(stations=[], accessories=[row(CHIME)]))
        hb3 = device(HB3)
        assert await async_remove_config_entry_device(hass, entry, hb3)
        devices.async_remove_device(hb3.id)
        await hass.async_block_till_done()
        assert device(SENSOR).via_device_id is None
        # When it returns, every accessory hangs under it again.
        await _update(hass, entry, FRAME)
        hb3 = device(HB3)
        for serial in (SENSOR, BACK, KEYPAD):
            assert device(serial).via_device_id == hb3.id
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_accessories_without_a_name_get_a_category_name(hass):
    data = frame()
    for item in data["accessories"]:
        item["name"] = ""
    with patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"):
        entry = await _setup(hass, data)
        devices = dr.async_get(hass)

        def name(serial):
            return devices.async_get_device_by_identifier(
                (DOMAIN, serial), entry.entry_id
            ).name

        assert [name(s) for s in (SENSOR, BACK, KEYPAD, CHIME)] == [
            "Entry Sensor",
            "Entry Sensor",
            "Keypad",
            "Doorbell Chime",
        ]
        door = hass.states.get("binary_sensor.entry_sensor")
        assert door is not None and door.state == "on"
        # A name that arrives later replaces the fallback.
        await _update(hass, entry, FRAME)
        assert name(SENSOR) == row(SENSOR)["name"]
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_guard_mode_off_is_shown_and_settable_only_with_a_keypad(hass):
    with (
        patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"),
        patch(
            "custom_components.eufy_viewer.api.BridgeClient.set_guard_mode",
            new_callable=AsyncMock,
        ) as command,
    ):
        entry = await _setup(hass, FRAME)
        selector = "select.synthetic_homebase_3_guard_mode"
        alarm = "alarm_control_panel.synthetic_homebase_3"
        state = hass.states.get(selector)
        assert state.state == "Off" and "Off" in state.attributes["options"]
        assert hass.states.get(alarm).state == "disarmed"
        await hass.services.async_call(
            "select",
            "select_option",
            {"entity_id": selector, "option": "Off"},
            blocking=True,
        )
        command.assert_awaited_once_with(HB3, 6)
        # Disarm keeps sending Disarmed, never Off.
        await hass.services.async_call(
            "alarm_control_panel", "alarm_disarm", {"entity_id": alarm}, blocking=True
        )
        command.assert_awaited_with(HB3, 63)
        command.reset_mock()

        # Off set on a keypad the bridge does not report: shown, never sent.
        station = {**FRAME["stations"][0], "extra_modes": []}
        await _update(hass, entry, frame(stations=[station]))
        state = hass.states.get(selector)
        assert state.state == "Off" and state.attributes["options"][-1] == "Off"
        with pytest.raises(HomeAssistantError, match="unavailable"):
            await hass.services.async_call(
                "select",
                "select_option",
                {"entity_id": selector, "option": "Off"},
                blocking=True,
            )
        command.assert_not_awaited()

        # Without a keypad and in another mode, Off is not offered at all.
        station = {**station, "guard_mode": 1, "current_mode": 1}
        await _update(hass, entry, frame(stations=[station]))
        state = hass.states.get(selector)
        assert state.state == "Home" and "Off" not in state.attributes["options"]
        assert hass.states.get(alarm).state == "armed_home"
        assert await hass.config_entries.async_unload(entry.entry_id)


SUPPORT = json.loads((FIXTURES / "accessory-diagnostics.json").read_text())


def test_accessory_discovery_rows_and_observations_survive_download():
    result = support_report(
        {
            "schema": 2,
            "last_discovery": [SUPPORT["summary"], *SUPPORT["rows"]],
            "recent_events": [],
            "accessory_observations": SUPPORT["accessory_observations"],
        }
    )
    assert result["last_discovery"] == [SUPPORT["summary"], *SUPPORT["rows"]]
    assert result["accessory_observations"] == SUPPORT["accessory_observations"]


def test_a_full_discovery_report_with_accessory_refs_survives_download():
    accessory = SUPPORT["rows"][-1]
    rows = [
        SUPPORT["summary"],
        *({**accessory, "ref": 100 + i % 99} for i in range(298)),
    ]
    result = support_report({"schema": 2, "last_discovery": rows, "recent_events": []})[
        "last_discovery"
    ]
    # Every row of the largest report is kept, accessory refs up to 198 included.
    assert len(result) == 299 and result == rows
    beyond = support_report(
        {
            "schema": 2,
            "last_discovery": [{**accessory, "ref": 199}, {**SUPPORT["rows"][0]}],
            "recent_events": [],
        }
    )["last_discovery"]
    assert beyond[0]["ref"] is None and beyond[1] == SUPPORT["rows"][0]


@pytest.mark.parametrize("value", [None, "PRIVATE_SERIAL", 5, [], True])
def test_accessory_observations_are_null_without_a_client_or_an_old_bridge(value):
    report = {"schema": 2, "last_discovery": [], "recent_events": []}
    assert support_report(report)["accessory_observations"] is None
    report["accessory_observations"] = value
    assert support_report(report)["accessory_observations"] is None


def test_accessory_diagnostics_keep_bounded_values_and_no_identifiers():
    hostile = {
        **SUPPORT["rows"][0],
        "category": "camera",
        "has_station": 1,
        "serial": "PRIVATE_SERIAL",
        "name": "PRIVATE_NAME",
        "open": True,
        "station": "PRIVATE_HB",
    }
    result = support_report(
        {
            "schema": 2,
            "last_discovery": [
                {**SUPPORT["summary"], "accessories": 101},
                hostile,
            ],
            "recent_events": [],
            "accessory_observations": {
                "hub_notify": -1,
                "sensor_status": 2**31,
                "push_door_sensor": True,
                "camera_info": 1.0,
                "conflicts": 2**31 - 1,
                "PRIVATE_SERIAL": 1,
            },
        }
    )
    summary, row_result = result["last_discovery"]
    assert summary["accessories"] is None
    assert row_result["category"] is None and row_result["has_station"] is None
    assert result["accessory_observations"] == {"conflicts": 2**31 - 1}
    assert not {"serial", "name", "open", "station"} & row_result.keys()
    assert "PRIVATE" not in json.dumps(result)


def test_keypad_parameters_survive_download():
    result = support_report(
        {
            "schema": 2,
            "last_discovery": [],
            "recent_events": [],
            "keypad_parameters": SUPPORT["keypad_parameters"],
        }
    )
    assert result["keypad_parameters"] == SUPPORT["keypad_parameters"]


@pytest.mark.parametrize("value", [None, "PRIVATE_SERIAL", 5, {}, True])
def test_keypad_parameters_are_null_without_a_client_or_an_old_bridge(value):
    report = {"schema": 2, "last_discovery": [], "recent_events": []}
    assert support_report(report)["keypad_parameters"] is None
    report["keypad_parameters"] = value
    assert support_report(report)["keypad_parameters"] is None


def test_keypad_parameters_keep_types_and_battery_codes_only():
    hostile = {
        "inventory_row": 99,
        "serial": "PRIVATE_SERIAL",
        "cloud": {
            "types": [1655, 1655, -1, 70000, 1.5, True, "PRIVATE", *range(3000, 3080)],
            "codes": {
                "1101": "1234567",
                "1653": "PRIVATE",
                "1654": "other",
                "1655": 2,
                "1657": "4321",
            },
            "name": "PRIVATE_NAME",
        },
        "camera_info": "PRIVATE",
        "hub_notify": {"types": "PRIVATE", "codes": ["1655"]},
    }
    result = support_report(
        {
            "schema": 2,
            "last_discovery": [],
            "recent_events": [],
            "keypad_parameters": ["PRIVATE", hostile, *[{"inventory_row": 1}] * 9],
        }
    )["keypad_parameters"]
    # At most eight input rows are read, and a row that is no object is skipped.
    assert len(result) == 7
    row = result[0]
    assert list(row) == ["inventory_row", "cloud", "camera_info", "hub_notify"]
    assert row["inventory_row"] is None
    assert row["cloud"]["types"] == [1655, *range(3000, 3067)]
    assert row["cloud"]["codes"] == {"1654": "other"}
    assert row["camera_info"] == row["hub_notify"] == {"types": [], "codes": {}}
    assert "PRIVATE" not in json.dumps(result) and "4321" not in json.dumps(result)


async def test_download_lists_accessories_without_identifiers(hass):
    with patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"):
        entry = await _setup(hass, FRAME)
        with patch(
            "custom_components.eufy_viewer.api.BridgeClient.request",
            AsyncMock(
                return_value={
                    "schema": 2,
                    "last_discovery": SUPPORT["rows"],
                    "recent_events": [],
                    "accessory_observations": SUPPORT["accessory_observations"],
                    "keypad_parameters": SUPPORT["keypad_parameters"],
                }
            ),
        ):
            diagnostics = await async_get_config_entry_diagnostics(hass, entry)
        assert diagnostics["accessories"] == [
            {
                "category": "entry_sensor",
                "model": "T8900",
                "software": "unavailable",
                "has_station": True,
                "sources": {"open": "p2p", "battery_low": "cloud"},
            },
            {
                "category": "entry_sensor",
                "model": "T8900",
                "software": "unavailable",
                "has_station": True,
                "sources": {"open": "cloud"},
            },
            {
                "category": "keypad",
                "model": "T8960",
                "software": "0.0.1.7",
                "has_station": True,
                "sources": {"battery_low": "p2p", "charging": "p2p"},
            },
            {
                "category": "chime",
                "model": "T8026",
                "software": "1.0.2.7",
                "has_station": False,
                "sources": {},
            },
        ]
        assert diagnostics["accessories_dropped"] == 0
        support = diagnostics["support"]
        assert support["accessory_observations"] == SUPPORT["accessory_observations"]
        assert support["keypad_parameters"] == SUPPORT["keypad_parameters"]
        assert [r["category"] for r in support["last_discovery"]] == [
            "entry_sensor",
            "keypad",
            "chime",
        ]
        text = json.dumps(diagnostics)
        for value in ("SYNTH", "Synthetic", "observed_at"):
            assert value not in text
        assert await hass.config_entries.async_unload(entry.entry_id)
