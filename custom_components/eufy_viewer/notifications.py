"""Stable event names shared by the push boundary and event entities."""

EVENT_TYPES = [
    "motion",
    "person",
    "stranger",
    "ring",
    "vehicle",
    "pet",
    "crying",
    "sound",
    "package_delivered",
    "package_stranded",
    "package_taken",
    "loitering",
    "radar_motion",
    "dog",
    "dog_lick",
    "dog_poop",
    "notification",
]


def notification_signal(entry_id: str) -> str:
    """Keep event delivery scoped to its owning config entry."""
    return f"eufy_viewer_notification_{entry_id}"
