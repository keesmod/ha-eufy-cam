"""Prepare and transfer a private camera inventory without Eufy cloud access."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Bridge redirects are not allowed")


def request(url, token, path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = Request(
        url + path,
        data=body,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    with build_opener(NoRedirect).open(req, timeout=65) as response:
        raw = response.read(1_048_577)
        if len(raw) > 1_048_576:
            raise ValueError("Bridge response is too large")
        return json.loads(raw)


def inventory(state):
    if state.get("protocol") != 1 or state.get("auth") != "connected":
        raise ValueError("Connect the old bridge before preparing migration")
    if state.get("backend") not in ("legacy", "mega"):
        raise ValueError("Update the old bridge to a supported preparation version")
    if not isinstance(state.get("bridge_id"), str) or not state["bridge_id"]:
        raise ValueError("Bridge identity is missing")
    result = {
        "version": 1,
        "bridge_id": state["bridge_id"],
        "backend": state["backend"],
    }
    for key in ("cameras", "stations"):
        values = state.get(key, [])
        if not isinstance(values, list) or len(values) > 100:
            raise ValueError("Invalid device inventory")
        ids = [item.get("serial") for item in values]
        if any(
            not isinstance(value, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value)
            for value in ids
        ):
            raise ValueError("Invalid device identifier")
        if len(set(ids)) != len(ids):
            raise ValueError("Duplicate device identifier")
        result[key] = sorted(ids)
    if not result["cameras"]:
        raise ValueError("The old bridge has no cameras. Do not upgrade yet")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="Existing local bridge address")
    parser.add_argument(
        "--inventory", type=Path, default=Path("camera-migration-private.json")
    )
    args = parser.parse_args()
    parsed = urlsplit(args.url)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise ValueError("Use a bridge address without embedded credentials or a path")
    url = args.url.rstrip("/")
    token = getpass.getpass("Bridge token: ")
    if args.inventory.exists():
        saved = json.loads(args.inventory.read_text())
        print("Using the saved inventory. It will not be overwritten.")
    else:
        saved = inventory(request(url, token, "/v1/state"))
        fd = os.open(args.inventory, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(saved, stream)
        print("Device list saved. Keep this file private.")
    input(
        "Back up and update the bridge using the same data and token. Press Enter when ready. "
    )
    current = request(url, token, "/v1/state")
    if (
        current.get("bridge_id") != saved.get("bridge_id")
        or current.get("migration", {}).get("version") != 1
    ):
        raise ValueError(
            "The updated bridge identity or migration support does not match"
        )
    if request(url, token, "/v1/migration", saved).get("accepted") is not True:
        raise ValueError("Migration inventory was not accepted")
    print(
        "Device list transferred. Complete the Mega login if asked, then check your cameras."
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError):
        raise SystemExit(
            "Migration paused. Keep your backup and use the recovery steps in docs/MEGA_MIGRATION.md."
        ) from None
