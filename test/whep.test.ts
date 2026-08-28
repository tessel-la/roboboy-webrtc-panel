import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveGatewayDiscoveryEndpoint,
  deriveGatewayEndpoints,
  discoverGatewayStreams,
  normalizeWhepEndpoint,
  parseGatewayStreams,
  parseIceServers,
  parseIceServerLinks,
  resolveSessionUrl,
} from "../src/whep.ts";

test("normalizes relative WHEP endpoints and rejects non-HTTP transports", () => {
  assert.equal(
    normalizeWhepEndpoint(
      "/webrtc/camera/whep",
      "https://roboboy.test/workspace",
    ),
    "https://roboboy.test/webrtc/camera/whep",
  );
  assert.throws(
    () =>
      normalizeWhepEndpoint("rtsp://camera.local/live", "https://roboboy.test"),
    /HTTP or HTTPS/,
  );
});

test("derives discovered stream proxy and direct-host endpoints", () => {
  assert.deepEqual(
    deriveGatewayEndpoints(
      "/video_stream",
      "https://roboboy.test",
      "genesis_wrist_camera",
    ),
    {
      whep: "/webrtc/genesis_wrist_camera/whep",
      rtsp: "rtsp://roboboy.test:8554/genesis_wrist_camera",
    },
  );
  assert.deepEqual(
    deriveGatewayEndpoints(
      "http://robot.local:8080",
      "tauri://localhost",
      "genesis_wrist_camera",
    ),
    {
      whep: "http://robot.local:8889/genesis_wrist_camera/whep",
      rtsp: "rtsp://robot.local:8554/genesis_wrist_camera",
    },
  );
});

test("derives arbitrary safe gateway stream paths", () => {
  assert.deepEqual(
    deriveGatewayEndpoints(
      "/video_stream",
      "https://roboboy.test",
      "manipulator_wrist_camera",
    ),
    {
      whep: "/webrtc/manipulator_wrist_camera/whep",
      rtsp: "rtsp://roboboy.test:8554/manipulator_wrist_camera",
    },
  );
  assert.throws(
    () =>
      deriveGatewayEndpoints("/video_stream", "https://roboboy.test", "../bad"),
    /invalid/,
  );
});

test("derives web-proxy and desktop discovery endpoints", () => {
  assert.equal(
    deriveGatewayDiscoveryEndpoint(
      "/video_stream",
      "https://roboboy.test/workspace",
    ),
    "/webrtc/_discovery/paths",
  );
  assert.equal(
    deriveGatewayDiscoveryEndpoint(
      "http://robot.local:8080",
      "tauri://localhost",
    ),
    "http://robot.local:9997/v3/paths/list",
  );
});

test("keeps only ready, valid, deduplicated gateway streams", () => {
  assert.deepEqual(
    parseGatewayStreams({
      items: [
        { name: "z_camera", ready: true, tracks: ["H264"] },
        { name: "offline", ready: false, tracks: ["H264"] },
        { name: "../invalid", ready: true },
        { name: "a_camera", ready: true, tracks: ["VP9", 42] },
        { name: "z_camera", ready: true, tracks: ["H264", "Opus"] },
      ],
    }),
    [
      { name: "a_camera", tracks: ["VP9"] },
      { name: "z_camera", tracks: ["H264", "Opus"] },
    ],
  );
  assert.deepEqual(parseGatewayStreams({ items: "invalid" }), []);
});

test("fetches gateway streams without caching", async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    return new Response(
      JSON.stringify({
        items: [
          { name: "manipulator_wrist_camera", ready: true, tracks: ["H264"] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  await assert.doesNotReject(async () => {
    assert.deepEqual(
      await discoverGatewayStreams(
        "/webrtc/_discovery/paths",
        undefined,
        fetcher,
      ),
      [{ name: "manipulator_wrist_camera", tracks: ["H264"] }],
    );
  });
});

test("parses bounded STUN and TURN server lists", () => {
  assert.deepEqual(
    parseIceServers("stun:stun.example.org,\nturns:turn.example.org"),
    [{ urls: "stun:stun.example.org" }, { urls: "turns:turn.example.org" }],
  );
  assert.throws(
    () => parseIceServers("https://not-ice.example.org"),
    /Unsupported ICE/,
  );
});

test("parses WHEP ICE server links with temporary TURN credentials", () => {
  assert.deepEqual(
    parseIceServerLinks(
      '<turn:10.8.0.1:3478?transport=tcp>; rel="ice-server"; username="1787779000:session"; credential="temporary-secret", <stun:stun.example.org>; rel="ice-server"',
    ),
    [
      {
        urls: "turn:10.8.0.1:3478?transport=tcp",
        username: "1787779000:session",
        credential: "temporary-secret",
      },
      { urls: "stun:stun.example.org" },
    ],
  );
  assert.deepEqual(parseIceServerLinks(null), []);
  assert.deepEqual(
    parseIceServerLinks('<https://example.org>; rel="ice-server"'),
    [],
  );
});

test("resolves relative WHEP session resources", () => {
  assert.equal(
    resolveSessionUrl("https://camera.test/live/whep", "../session/42"),
    "https://camera.test/session/42",
  );
  assert.equal(resolveSessionUrl("https://camera.test/live/whep", null), null);
});
