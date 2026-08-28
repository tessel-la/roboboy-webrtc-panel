export interface StatsBaseline {
  bytesReceived: number;
  sampledAt: number;
}

export interface WebRtcMetrics {
  bitrateKbps?: number;
  framesPerSecond?: number;
  roundTripTimeMs?: number;
  jitterMs?: number;
  packetsLost?: number;
  packetLossPercent?: number;
  framesDropped?: number;
  baseline: StatsBaseline;
}

type StatsEntry = RTCStats & {
  type: string;
  kind?: string;
  mediaType?: string;
  bytesReceived?: number;
  framesPerSecond?: number;
  jitter?: number;
  packetsLost?: number;
  packetsReceived?: number;
  framesDropped?: number;
  selectedCandidatePairId?: string;
  currentRoundTripTime?: number;
  nominated?: boolean;
  state?: string;
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const collectWebRtcMetrics = (
  report: RTCStatsReport,
  previous: StatsBaseline,
  sampledAt: number,
): WebRtcMetrics => {
  let inbound: StatsEntry | undefined;
  let selectedCandidatePairId: string | undefined;
  let fallbackCandidatePair: StatsEntry | undefined;

  report.forEach((rawEntry) => {
    const entry = rawEntry as StatsEntry;
    if (
      entry.type === "inbound-rtp" &&
      (entry.kind ?? entry.mediaType) === "video"
    )
      inbound = entry;
    else if (entry.type === "transport" && entry.selectedCandidatePairId)
      selectedCandidatePairId = entry.selectedCandidatePairId;
    else if (
      entry.type === "candidate-pair" &&
      entry.nominated === true &&
      entry.state === "succeeded"
    )
      fallbackCandidatePair = entry;
  });

  const selectedCandidatePair = selectedCandidatePairId
    ? (report.get(selectedCandidatePairId) as StatsEntry | undefined)
    : fallbackCandidatePair;
  const bytesReceived = finiteNumber(inbound?.bytesReceived) ?? 0;
  const elapsedSeconds = (sampledAt - previous.sampledAt) / 1000;
  const received = finiteNumber(inbound?.packetsReceived);
  const lost = Math.max(0, finiteNumber(inbound?.packetsLost) ?? 0);
  const packetTotal = received === undefined ? 0 : received + lost;

  return {
    ...(previous.sampledAt > 0 &&
    elapsedSeconds > 0 &&
    bytesReceived >= previous.bytesReceived
      ? {
          bitrateKbps:
            ((bytesReceived - previous.bytesReceived) * 8) /
            1000 /
            elapsedSeconds,
        }
      : {}),
    ...(finiteNumber(inbound?.framesPerSecond) !== undefined
      ? { framesPerSecond: finiteNumber(inbound?.framesPerSecond) }
      : {}),
    ...(finiteNumber(selectedCandidatePair?.currentRoundTripTime) !== undefined
      ? {
          roundTripTimeMs:
            finiteNumber(selectedCandidatePair?.currentRoundTripTime)! * 1000,
        }
      : {}),
    ...(finiteNumber(inbound?.jitter) !== undefined
      ? { jitterMs: finiteNumber(inbound?.jitter)! * 1000 }
      : {}),
    ...(finiteNumber(inbound?.packetsLost) !== undefined
      ? { packetsLost: lost }
      : {}),
    ...(packetTotal > 0
      ? { packetLossPercent: (lost / packetTotal) * 100 }
      : {}),
    ...(finiteNumber(inbound?.framesDropped) !== undefined
      ? { framesDropped: finiteNumber(inbound?.framesDropped) }
      : {}),
    baseline: { bytesReceived, sampledAt },
  };
};
