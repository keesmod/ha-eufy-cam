# Home Assistant ICE configuration

References [camera issue #10](https://github.com/keesmod/ha-eufy-cam/issues/10).

The external reporter attempts completed offer/answer signaling but stayed in
ICE checking with no displayed frames or playback acknowledgements. The earlier
local report connected. This locates the external failure at connectivity but
does not establish the reporter's NAT, firewall or relay configuration.

## Repair

The previous card and both go2rtc offers used empty ICE server lists. Integration
0.8.18 resolves `homeassistant.components.web_rtc.async_get_ice_servers` separately
when each media or late-audio peer is prepared. A copied snapshot goes to that
peer's authenticated browser event and its go2rtc offer. Provider credentials
can change between peers and sessions. Cleanup releases the integration's copy.
A provider exception produces only a fixed warning and an empty direct-ICE list.
No provider exception text or credentials enter diagnostic history.

The browser sends its offer immediately, then trickles up to 64 candidates after
the offer is accepted. It does not wait for unreachable STUN servers to finish
collecting candidates. The existing bridge startup and playback deadlines,
15-second optional-audio deadline, fallback and owner cancellation remain in
force. ICE messages do not renew a camera lease. A closed peer cannot send more
candidates or trigger a fallback in a later viewer session.

The API was checked against HA 2026.9.2 and the repository's pinned 2026.9.0.
Their `web_rtc` provider implementation is identical. HA owns custom/default
STUN and registered providers. The integration now declares `web_rtc` as a
dependency. See [HA WebRTC configuration](https://www.home-assistant.io/integrations/web_rtc/),
[HA provider source](https://github.com/home-assistant/core/blob/2026.9.2/homeassistant/components/web_rtc/__init__.py)
and [HA camera negotiation](https://github.com/home-assistant/core/blob/2026.9.2/homeassistant/components/camera/__init__.py).

## Validation method

HA tests exercise the real ICE provider registry, default/custom STUN, provider
removal, changing credentials, separate peer snapshots, provider exceptions,
owning WebSocket authorization and cleanup. Browser tests verify incomplete
gathering, offer-before-candidate ordering, both peers and bounded diagnostics.

The real browser suite uses Chromium, official go2rtc 1.9.14, FFmpeg and a temporary
coturn process. Set `GO2RTC_BINARY` and optionally `TURN_SERVER_BINARY`, then run
`npm test` in `frontend`. CI installs coturn only for this test job.

Relay cases force browser `iceTransportPolicy: relay` and remove non-relay
candidates from incoming signaling. Both video and late audio must decode,
acknowledgements must advance, both go2rtc peers must provide relay candidates,
and the browser's nominated local candidate must be a relay. A server may answer
through a peer-reflexive candidate while media still traverses the browser's
relay. The fixture does not claim separate network namespaces or a reproduction
of the reporter's external network.

Control cases remove relay configuration or use incorrect relay credentials.
They must reach the existing JPEG fallback with zero WebRTC playback, without
restarting the camera. An unreachable STUN server must still allow direct
playback. Existing media, late-audio, recording and cleanup regressions also run.
All fixtures use synthetic media. Their reports contain only counters and fixed
categories. Private addresses, SDP, candidate strings, relay URLs and credentials
are excluded from diagnostic downloads.

## Acceptance boundary

Bridge 0.8.17 and client 0.12.2 do not change. This repair adds use of HA's existing
connection assistance, not a new relay service. STUN alone cannot relay packets.
A dashboard proxy does not automatically carry WebRTC media. A permitted direct
media route or a functioning TURN provider may still be needed.

Software and local T8160 playback evidence do not establish external T8134
acceptance. Issue #10 stays open until the reporter's actual route, continuous
video and audible audio are confirmed. Publishing a new release remains a
separate approval step.
