# Camera events and recognized people

Integration and bridge 0.5.0 add one event entity per camera and the
`eufy_viewer_event` Home Assistant automation event. Update the bridge first,
update the integration, and restart Home Assistant. The push connection is shown
separately by a diagnostic binary sensor.

One camera detection produces one actionable event. The bridge combines Eufy's
parallel push formats and the SDK's derived detector callbacks for 500 ms before
publishing. For example, a recognized person does not also fire a generic motion
event or duplicate metadata notifications. Distinct cameras and separate upstream
event identities stay separate.

## Event fields

| Field | Meaning |
| --- | --- |
| `event_type` | `person`, `ring`, `motion`, or another supported type below |
| `device_name` | Device name from the bridge inventory |
| `serial` | Device serial, usable as a stable automation filter |
| `person_name` | Eufy's recognized name, such as `Peter`, otherwise `null` |
| `recognition` | `known`, `unknown`, `unidentified`, or `not_applicable` |
| `received_at` | UTC time the bridge first received this occurrence |
| `occurred_at` | UTC detection time reported by Eufy, otherwise `null` |
| `id` | Bridge event ID used for delivery deduplication |
| `config_entry_id` | Integration entry which owns the event |
| `source` | `push`, or `device` for a detector-only fallback |
| `eufy_event_type` | Optional original Eufy event code for troubleshooting |

`known` means Eufy recognized a person. The name is included when Eufy supplies
it. `unknown` means Eufy explicitly reported a stranger. `unidentified` means only
person detection was supplied; it does not assert that the person is a stranger.
Names such as the SDK's `Unknown` placeholder are represented as `null`.

Person names are available in HA events, entity attributes and recorder history.
Credentials, account details, PINs, verification codes, raw message text and signed
image URLs are excluded. This integration does not perform face recognition;
it forwards Eufy's result.

## Automate a recognized person

In Developer Tools > Events, listen to `eufy_viewer_event`, then walk past a
camera to identify its serial and the exact recognition name from Eufy.

```yaml
alias: Eufy recognizes Peter
triggers:
  - trigger: event
    event_type: eufy_viewer_event
    event_data:
      event_type: person
      serial: REPLACE_WITH_FRONT_CAMERA_SERIAL
      recognition: known
      person_name: Peter
conditions: []
actions:
  - action: persistent_notification.create
    data:
      title: Person recognized
      message: "{{ trigger.event.data.person_name }} was detected by {{ trigger.event.data.device_name }}."
mode: queued
```

For all people, remove the `recognition` and `person_name` filters. For explicitly
unknown people use `recognition: unknown`. For the doorbell use `event_type: ring`
and its serial. No additional `notification` or `motion` action is necessary for
the same recognized-person occurrence.

Camera event entities show the most recent event with translated event-type
labels. Use the event bus trigger above to avoid triggering on unavailable or
restored entity states.

Other types include `vehicle`, `pet`, `crying`, `sound`, `package_delivered`,
`package_taken`, `package_stranded`, `loitering`, `radar_motion`, `dog`, `dog_lick`
and `dog_poop`. Unclassified device/HomeBase alerts use `notification` with the
Eufy code. Models and security-mode settings determine available event types.
Account-only notifications without a known device are excluded.

## All alerts in HA, selected notifications on the phone

Keep Eufy push enabled for the desired cameras in every relevant security mode.
The dedicated HA account needs shared access. Camera notification settings and
snooze can affect HA's source messages too. Independent Eufy filters per account
have not been established.

Use HA Companion notifications to apply phone-specific rules: for example, always
notify for `ring`, and only notify for `person` when the intended person or
household is away. Choose the correct presence entity and phone service yourself;
the integration does not install personal notification rules automatically.

After testing delivery, Eufy app notifications can be suppressed in the phone's
OS settings to avoid duplicate phone alerts. This may also affect the native
Eufy doorbell call notification; HA notification handling does not implement
Eufy's two-way calling UI.

## Connection and delivery limits

Receiving events does not start camera streams or poll cameras. The push sensor
reports SDK push registration separately from cloud login. A connected socket
still needs a real detection test to prove delivery for an account.

The bridge uses bounded five-minute in-memory upstream identity deduplication.
Companion formats without a common identity are correlated within 500 ms when
their device/type and occurrence timestamps agree. Late companions with no shared
identity cannot always be recognized. Separate IDs in the same format are never
merged just because they arrive close together.

The SDK-only fallback merges detector flags within 500 ms and ignores reset
callbacks. Its property-state model may coalesce repeat detections; upstream push
messages retain separate occurrence identities when available. No event backlog
is replayed on reconnect. Events during an outage may be missed; this is not a
guaranteed alarm channel.

A saved v6 session can be rejected by Eufy even before its recorded expiry. The
initial live test needed a fresh session before push registration worked. This
feature reports connectivity; it does not claim to fix upstream authentication
recovery for every account.
