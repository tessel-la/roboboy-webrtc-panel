# Robo-Boy WebRTC / RTSP Camera Panel

A standalone Robo-Boy external panel for low-latency camera playback through a
[WHEP](https://www.ietf.org/archive/id/draft-ietf-wish-whep-03.html) endpoint. It also keeps the matching RTSP URL visible for VLC, NVR, and server-side consumers.

The panel does not attempt to decode RTSP in the browser. A media gateway such as MediaMTX accepts the RTSP stream and exposes WHEP signaling plus WebRTC media to the panel.

## Features

- WHEP offer/answer negotiation with best-effort session cleanup.
- Automatic discovery of ready streams from Robo-Boy's restricted MediaMTX path-list route.
- A source dropdown with refresh and a Custom URL fallback for external gateways.
- Configurable contain, cover, or stretch behavior and optional audio.
- Optional STUN/TURN URLs and a session-only bearer token that is never persisted.
- Selectable resolution, bitrate, frame-rate, RTT latency, jitter, packet-loss, and dropped-frame indicators.
- A height-safe, horizontally scrollable statistics footer that remains visible in compact and mobile tiles.
- Auto-connect, inactive-tile suspension, and responsive settings.

## Genesis source

The companion Genesis simulation configuration publishes the wrist camera at:

- WHEP: `http://localhost:8889/genesis_wrist_camera/whep`
- RTSP: `rtsp://localhost:8554/genesis_wrist_camera`
- WebRTC ICE media: UDP `8189`

When Genesis is active, the panel discovers `genesis_wrist_camera` and derives `/webrtc/genesis_wrist_camera/whep`. The RTSP URL remains a direct gateway reference because browsers do not play RTSP URLs.

## Manipulator Sim source

The non-Genesis ROS/Gazebo simulator publishes its first wrist camera through:

- WHEP: `http://localhost:8889/manipulator_wrist_camera/whep`
- RTSP: `rtsp://localhost:8554/manipulator_wrist_camera`

When Manipulator Sim is active, the same dropdown discovers
`manipulator_wrist_camera` and derives the proxied
`/webrtc/manipulator_wrist_camera/whep` endpoint without a simulator-specific preset.

## Stream discovery

Robo-Boy exposes only `GET /webrtc/_discovery/paths` from MediaMTX's loopback
control API. The panel filters that response to ready paths with safe names,
sorts them, and derives matching WHEP and RTSP endpoints. If the configured path
is no longer available, the first ready path is selected automatically. The raw
control API and all mutation endpoints remain inaccessible through Robo-Boy.

Direct/desktop deployments attempt MediaMTX's standard
`http://HOST:9997/v3/paths/list` endpoint. When it is not reachable, choose
**Custom URL…** and enter WHEP/RTSP endpoints manually.

## Develop

```bash
npm install
npm run build
npm run integrity
npm run validate
```

After changing the bundle, copy the value printed by `npm run integrity` into `roboboy.panel.json`. The type-only SDK development dependency is pinned to the versioned Panel SDK GitHub release.

To load this working tree in Robo-Boy, list `robo-boy-webrtc-panel` in a schema-v2 local source's `repositories` array and rerun the panel installer. A local source reads the manifest and bundle directly; an inventory entry is needed only for a published remote installation.

## Use

1. Start either simulator and its stream gateway.
2. Add **WebRTC / RTSP Camera** to a Robo-Boy workspace.
3. The panel discovers and connects to the ready stream automatically. Open **Configure** to select another discovered stream, refresh, or use a custom endpoint.

The panel runs as trusted same-realm code. Its `network` capability permits WHEP requests and its `storage` capability persists non-secret per-tile settings; it does not access Robo-Boy's internal stores.
