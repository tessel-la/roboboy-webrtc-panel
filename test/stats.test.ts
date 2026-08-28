import assert from "node:assert/strict";
import test from "node:test";
import { collectWebRtcMetrics } from "../src/stats.ts";

const report = (...entries: Array<Record<string, unknown>>): RTCStatsReport =>
  new Map(
    entries.map((entry) => [String(entry.id), entry]),
  ) as unknown as RTCStatsReport;

test("collects receiver and selected candidate-pair telemetry", () => {
  const metrics = collectWebRtcMetrics(
    report(
      {
        id: "video",
        type: "inbound-rtp",
        kind: "video",
        bytesReceived: 20_000,
        framesPerSecond: 29.7,
        jitter: 0.008,
        packetsReceived: 100,
        packetsLost: 5,
        framesDropped: 3,
      },
      {
        id: "transport",
        type: "transport",
        selectedCandidatePairId: "pair",
      },
      {
        id: "pair",
        type: "candidate-pair",
        currentRoundTripTime: 0.042,
      },
    ),
    { bytesReceived: 10_000, sampledAt: 1_000 },
    2_000,
  );

  assert.equal(metrics.bitrateKbps, 80);
  assert.equal(metrics.framesPerSecond, 29.7);
  assert.equal(metrics.roundTripTimeMs, 42);
  assert.equal(metrics.jitterMs, 8);
  assert.equal(metrics.packetsLost, 5);
  assert.equal(metrics.packetLossPercent?.toFixed(2), "4.76");
  assert.equal(metrics.framesDropped, 3);
  assert.deepEqual(metrics.baseline, {
    bytesReceived: 20_000,
    sampledAt: 2_000,
  });
});

test("uses a nominated candidate pair and omits unavailable metrics", () => {
  const metrics = collectWebRtcMetrics(
    report(
      {
        id: "video",
        type: "inbound-rtp",
        mediaType: "video",
        bytesReceived: 500,
      },
      {
        id: "pair",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.015,
      },
    ),
    { bytesReceived: 0, sampledAt: 0 },
    500,
  );

  assert.equal(metrics.bitrateKbps, undefined);
  assert.equal(metrics.packetLossPercent, undefined);
  assert.equal(metrics.roundTripTimeMs, 15);
});
