// src/whep.ts
var unquoteLinkValue = (value) => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\([\\"])/g, "$1");
};
var parseIceServerLinks = (header) => {
  if (!header) return [];
  const servers = [];
  const linkPattern = /<([^>]+)>\s*((?:;\s*[^,;=\s]+(?:\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^,;\s]+))?)*)/g;
  let link;
  while (link = linkPattern.exec(header)) {
    const url = link[1]?.trim() ?? "";
    if (!/^(stun|stuns|turn|turns):/i.test(url)) continue;
    const attributes = /* @__PURE__ */ new Map();
    const attributePattern = /;\s*([^,;=\s]+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^,;\s]+))?/g;
    let attribute;
    while (attribute = attributePattern.exec(link[2] ?? "")) {
      attributes.set(
        attribute[1].toLowerCase(),
        attribute[2] ? unquoteLinkValue(attribute[2]) : ""
      );
    }
    if (!attributes.get("rel")?.split(/\s+/).includes("ice-server")) continue;
    servers.push({
      urls: url,
      ...attributes.has("username") ? { username: attributes.get("username") } : {},
      ...attributes.has("credential") ? { credential: attributes.get("credential") } : {}
    });
  }
  return servers.slice(0, 8);
};
var discoverWhepIceServers = async (endpoint, token, signal) => {
  try {
    const response = await fetch(endpoint, {
      method: "OPTIONS",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal
    });
    if (!response.ok) return [];
    return parseIceServerLinks(response.headers.get("Link"));
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
};
var normalizeWhepEndpoint = (value, baseUrl) => {
  const endpoint = new URL(value.trim(), baseUrl);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("The WHEP endpoint must use HTTP or HTTPS.");
  }
  endpoint.hash = "";
  return endpoint.toString();
};
var deriveGatewayEndpoints = (videoStreamBaseUrl, browserBaseUrl, streamPath) => {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(streamPath)) {
    throw new Error("The gateway stream path is invalid.");
  }
  const browser = new URL(browserBaseUrl);
  if (videoStreamBaseUrl.startsWith("/")) {
    return {
      whep: `/webrtc/${streamPath}/whep`,
      rtsp: `rtsp://${browser.hostname}:8554/${streamPath}`
    };
  }
  const video = new URL(videoStreamBaseUrl);
  const signaling = new URL(video.toString());
  signaling.protocol = video.protocol === "https:" ? "https:" : "http:";
  signaling.port = "8889";
  signaling.pathname = `/${streamPath}/whep`;
  signaling.search = "";
  signaling.hash = "";
  return {
    whep: signaling.toString(),
    rtsp: `rtsp://${video.hostname}:8554/${streamPath}`
  };
};
var deriveGatewayDiscoveryEndpoint = (videoStreamBaseUrl, browserBaseUrl) => {
  const browser = new URL(browserBaseUrl);
  if (browser.protocol === "http:" || browser.protocol === "https:") {
    return "/webrtc/_discovery/paths";
  }
  const video = new URL(videoStreamBaseUrl);
  const endpoint = new URL(video.toString());
  endpoint.protocol = video.protocol === "https:" ? "https:" : "http:";
  endpoint.port = "9997";
  endpoint.pathname = "/v3/paths/list";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
};
var parseGatewayStreams = (value) => {
  if (!value || typeof value !== "object") return [];
  const items = value.items;
  if (!Array.isArray(items)) return [];
  const streams = /* @__PURE__ */ new Map();
  for (const candidate of items) {
    if (!candidate || typeof candidate !== "object") continue;
    const path = candidate;
    if (path.ready !== true || typeof path.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(path.name))
      continue;
    const tracks = Array.isArray(path.tracks) ? path.tracks.filter((track) => typeof track === "string").slice(0, 16) : [];
    streams.set(path.name, { name: path.name, tracks });
  }
  return [...streams.values()].sort(
    (left, right) => left.name.localeCompare(right.name)
  );
};
var discoverGatewayStreams = async (endpoint, signal, fetcher = fetch) => {
  const response = await fetcher(endpoint, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal
  });
  if (!response.ok) {
    throw new Error(`Stream discovery failed (${response.status}).`);
  }
  return parseGatewayStreams(await response.json());
};
var parseIceServers = (value) => {
  return value.split(/[,\n]/).map((url) => url.trim()).filter(Boolean).slice(0, 8).map((url) => {
    if (!/^(stun|stuns|turn|turns):/i.test(url)) {
      throw new Error(`Unsupported ICE server URL: ${url}`);
    }
    return { urls: url };
  });
};
var resolveSessionUrl = (endpoint, locationHeader) => {
  return locationHeader ? new URL(locationHeader, endpoint).toString() : null;
};
var waitForIceGatheringComplete = async (peer, timeoutMs = 1e4) => {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timeout = setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
};
var connectWhep = async (options) => {
  const discoveredIceServers = await discoverWhepIceServers(
    options.endpoint,
    options.token,
    options.signal
  );
  const peer = new RTCPeerConnection({
    iceServers: [...options.iceServers ?? [], ...discoveredIceServers].slice(
      0,
      8
    )
  });
  let sessionUrl = null;
  let closed = false;
  peer.addEventListener("track", options.onTrack);
  peer.addEventListener("connectionstatechange", () => {
    options.onStateChange?.(peer.connectionState);
  });
  peer.addTransceiver("video", { direction: "recvonly" });
  if (options.receiveAudio)
    peer.addTransceiver("audio", { direction: "recvonly" });
  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGatheringComplete(peer);
    if (!peer.localDescription?.sdp)
      throw new Error("The browser did not create a WebRTC offer.");
    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/sdp",
        "Content-Type": "application/sdp",
        ...options.token ? { Authorization: `Bearer ${options.token}` } : {}
      },
      body: peer.localDescription.sdp,
      signal: options.signal
    });
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 240);
      throw new Error(
        `WHEP negotiation failed (${response.status})${detail ? `: ${detail}` : ""}`
      );
    }
    const answer = await response.text();
    if (!answer.trim())
      throw new Error("The WHEP server returned an empty SDP answer.");
    sessionUrl = resolveSessionUrl(
      options.endpoint,
      response.headers.get("Location")
    );
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (error) {
    peer.close();
    throw error;
  }
  return {
    peer,
    get sessionUrl() {
      return sessionUrl;
    },
    async close() {
      if (closed) return;
      closed = true;
      peer.close();
      if (sessionUrl) {
        try {
          await fetch(sessionUrl, {
            method: "DELETE",
            keepalive: true,
            headers: options.token ? { Authorization: `Bearer ${options.token}` } : {}
          });
        } catch {
        }
      }
    }
  };
};

// src/stats.ts
var finiteNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
var collectWebRtcMetrics = (report, previous, sampledAt) => {
  let inbound;
  let selectedCandidatePairId;
  let fallbackCandidatePair;
  report.forEach((rawEntry) => {
    const entry = rawEntry;
    if (entry.type === "inbound-rtp" && (entry.kind ?? entry.mediaType) === "video")
      inbound = entry;
    else if (entry.type === "transport" && entry.selectedCandidatePairId)
      selectedCandidatePairId = entry.selectedCandidatePairId;
    else if (entry.type === "candidate-pair" && entry.nominated === true && entry.state === "succeeded")
      fallbackCandidatePair = entry;
  });
  const selectedCandidatePair = selectedCandidatePairId ? report.get(selectedCandidatePairId) : fallbackCandidatePair;
  const bytesReceived = finiteNumber(inbound?.bytesReceived) ?? 0;
  const elapsedSeconds = (sampledAt - previous.sampledAt) / 1e3;
  const received = finiteNumber(inbound?.packetsReceived);
  const lost = Math.max(0, finiteNumber(inbound?.packetsLost) ?? 0);
  const packetTotal = received === void 0 ? 0 : received + lost;
  return {
    ...previous.sampledAt > 0 && elapsedSeconds > 0 && bytesReceived >= previous.bytesReceived ? {
      bitrateKbps: (bytesReceived - previous.bytesReceived) * 8 / 1e3 / elapsedSeconds
    } : {},
    ...finiteNumber(inbound?.framesPerSecond) !== void 0 ? { framesPerSecond: finiteNumber(inbound?.framesPerSecond) } : {},
    ...finiteNumber(selectedCandidatePair?.currentRoundTripTime) !== void 0 ? {
      roundTripTimeMs: finiteNumber(selectedCandidatePair?.currentRoundTripTime) * 1e3
    } : {},
    ...finiteNumber(inbound?.jitter) !== void 0 ? { jitterMs: finiteNumber(inbound?.jitter) * 1e3 } : {},
    ...finiteNumber(inbound?.packetsLost) !== void 0 ? { packetsLost: lost } : {},
    ...packetTotal > 0 ? { packetLossPercent: lost / packetTotal * 100 } : {},
    ...finiteNumber(inbound?.framesDropped) !== void 0 ? { framesDropped: finiteNumber(inbound?.framesDropped) } : {},
    baseline: { bytesReceived, sampledAt }
  };
};

// src/index.ts
var PANEL_ID = "la.tessel.roboboy.webrtc";
var CUSTOM_SOURCE = "__custom__";
var STREAM_PATH_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
var DEFAULT_VISIBLE_STATS = {
  resolution: true,
  bitrate: true,
  fps: true,
  latency: true,
  jitter: false,
  packetLoss: true,
  framesDropped: false
};
var STATISTIC_KEYS = Object.keys(DEFAULT_VISIBLE_STATS);
var sanitizeConfig = (value, defaults) => {
  const candidate = value && typeof value === "object" ? value : {};
  const legacyPath = typeof candidate.whepUrl === "string" ? candidate.whepUrl.match(
    /\/([a-z0-9][a-z0-9_-]*)\/whep(?:[?#].*)?$/i
  )?.[1] : void 0;
  const streamPath = typeof candidate.streamPath === "string" && STREAM_PATH_PATTERN.test(candidate.streamPath) ? candidate.streamPath : legacyPath ?? "";
  const visibleStats = candidate.visibleStats && typeof candidate.visibleStats === "object" ? candidate.visibleStats : defaults.visibleStats;
  return {
    sourceMode: candidate.sourceMode === "custom" || candidate.sourceMode === void 0 && candidate.whepUrl && !legacyPath ? "custom" : defaults.sourceMode,
    streamPath,
    whepUrl: typeof candidate.whepUrl === "string" ? candidate.whepUrl.trim() : defaults.whepUrl,
    rtspUrl: typeof candidate.rtspUrl === "string" ? candidate.rtspUrl.trim() : defaults.rtspUrl,
    fit: ["contain", "cover", "fill"].includes(candidate.fit ?? "") ? candidate.fit : defaults.fit,
    receiveAudio: candidate.receiveAudio === true,
    autoConnect: candidate.autoConnect !== false,
    iceServers: typeof candidate.iceServers === "string" ? candidate.iceServers : defaults.iceServers,
    visibleStats: {
      resolution: visibleStats.resolution !== false,
      bitrate: visibleStats.bitrate !== false,
      fps: visibleStats.fps !== false,
      latency: visibleStats.latency !== false,
      jitter: visibleStats.jitter === true,
      packetLoss: visibleStats.packetLoss !== false,
      framesDropped: visibleStats.framesDropped === true
    }
  };
};
var PANEL_MARKUP = `
  <style>
    .rb-webrtc { position: relative; height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: 8px; padding: 10px; box-sizing: border-box; overflow: hidden; color: var(--text-color, #eef3f8); background: var(--background-secondary, #171c24); font: 13px/1.35 system-ui, sans-serif; }
    .rb-webrtc * { box-sizing: border-box; }
    .rb-webrtc__toolbar, .rb-webrtc__status, .rb-webrtc__footer, .rb-webrtc__metrics { display: flex; align-items: center; gap: 8px; }
    .rb-webrtc__toolbar { flex-wrap: wrap; }
    .rb-webrtc__title { margin: 0 auto 0 0; font-size: 15px; }
    .rb-webrtc button { border: 1px solid var(--border-color, #3d4654); border-radius: 6px; padding: 6px 10px; color: inherit; background: var(--card-bg, #242b36); cursor: pointer; font: inherit; }
    .rb-webrtc button:hover { border-color: var(--primary-color, #5ca9ff); }
    .rb-webrtc button:disabled { opacity: .45; cursor: default; }
    .rb-webrtc__dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: #7b8795; box-shadow: 0 0 0 3px #7b879522; }
    .rb-webrtc__dot[data-tone="live"] { background: #57d68d; box-shadow: 0 0 0 3px #57d68d22; }
    .rb-webrtc__dot[data-tone="warn"] { background: #ffb454; box-shadow: 0 0 0 3px #ffb45422; }
    .rb-webrtc__stage { position: relative; min-height: 0; display: grid; place-items: center; overflow: hidden; border: 1px solid var(--border-color, #343d49); border-radius: 8px; background: #080b10; }
    .rb-webrtc video { width: 100%; height: 100%; display: block; background: #080b10; object-fit: contain; }
    .rb-webrtc__placeholder { position: absolute; inset: 0; display: grid; place-content: center; gap: 6px; padding: 20px; text-align: center; color: var(--text-secondary, #9aa7b6); pointer-events: none; }
    .rb-webrtc__placeholder strong { color: var(--text-color, #eef3f8); }
    .rb-webrtc__placeholder[hidden] { display: none; }
    .rb-webrtc__footer { min-width: 0; color: var(--text-secondary, #aeb8c4); font-variant-numeric: tabular-nums; }
    .rb-webrtc__metrics { min-width: 0; width: 100%; padding-bottom: 2px; overflow-x: auto; white-space: nowrap; scrollbar-width: thin; }
    .rb-webrtc__metric, .rb-webrtc__protocol { flex: 0 0 auto; display: inline-flex; align-items: baseline; gap: 5px; padding: 3px 7px; border-radius: 999px; background: #ffffff0b; }
    .rb-webrtc__metric[hidden] { display: none; }
    .rb-webrtc__metric small { color: var(--text-secondary, #8f9aa8); font-size: 10px; text-transform: uppercase; letter-spacing: .03em; }
    .rb-webrtc__metric strong { color: var(--text-color, #eef3f8); font-size: 12px; font-weight: 600; }
    .rb-webrtc__protocol { color: #8bc4ff; background: #5ca9ff1c; }
    .rb-webrtc__settings { position: absolute; z-index: 10; inset: 50px 8px 8px auto; width: min(620px, calc(100% - 16px)); display: flex; flex-direction: column; gap: 12px; padding: 12px; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--border-color, #343d49); border-radius: 10px; box-shadow: 0 12px 32px #0009; background: var(--card-bg, #242b36); }
    .rb-webrtc__settings[hidden] { display: none; }
    .rb-webrtc__settings-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .rb-webrtc__settings-header h3 { margin: 0; font-size: 15px; }
    .rb-webrtc__source { display: grid; gap: 10px; }
    .rb-webrtc label { display: grid; gap: 4px; min-width: 0; color: var(--text-secondary, #aeb8c4); }
    .rb-webrtc input, .rb-webrtc select, .rb-webrtc textarea { width: 100%; min-width: 0; border: 1px solid var(--border-color, #414b59); border-radius: 5px; padding: 7px 8px; color: var(--text-color, #eef3f8); background: var(--background-primary, #11161d); font: inherit; }
    .rb-webrtc textarea { min-height: 62px; resize: vertical; }
    .rb-webrtc__input-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
    .rb-webrtc__custom { display: grid; gap: 10px; }
    .rb-webrtc__custom[hidden] { display: none; }
    .rb-webrtc__helper, .rb-webrtc__notice { margin: 0; color: var(--text-secondary, #8f9aa8); font-size: 12px; }
    .rb-webrtc__notice { padding: 8px 9px; border-left: 3px solid #5ca9ff; background: #5ca9ff10; }
    .rb-webrtc__advanced { border: 1px solid var(--border-color, #343d49); border-radius: 8px; }
    .rb-webrtc__advanced summary { padding: 9px 10px; cursor: pointer; font-weight: 600; }
    .rb-webrtc__advanced-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 2px 10px 10px; }
    .rb-webrtc__advanced-grid .wide { grid-column: 1 / -1; }
    .rb-webrtc__check { display: flex !important; grid-auto-flow: column; justify-content: start; align-items: center; align-content: end; padding-bottom: 6px; }
    .rb-webrtc__check input { width: auto; }
    .rb-webrtc__stats-options { min-width: 0; margin: 0; padding: 8px 9px 9px; border: 1px solid var(--border-color, #343d49); border-radius: 7px; }
    .rb-webrtc__stats-options legend { padding: 0 4px; color: var(--text-color, #eef3f8); font-weight: 600; }
    .rb-webrtc__stats-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px 10px; }
    .rb-webrtc__stats-grid .rb-webrtc__check { padding: 0; }
    .rb-webrtc__settings-actions { position: sticky; bottom: -12px; display: flex; gap: 8px; margin-top: auto; padding: 10px 0 2px; background: var(--card-bg, #242b36); }
    .rb-webrtc__settings-actions button { min-width: 92px; }
    .rb-webrtc__settings-actions button[type="submit"] { border-color: var(--primary-color, #5ca9ff); background: var(--primary-color, #347fc4); }
    .rb-webrtc[data-compact] { padding: 7px; gap: 5px; }
    .rb-webrtc[data-compact] .rb-webrtc__settings { inset: 38px 5px 5px; width: auto; padding: 9px; }
    .rb-webrtc[data-compact] .rb-webrtc__toolbar button { padding: 4px 7px; }
    @media (max-width: 620px) {
      .rb-webrtc { padding: 8px; gap: 6px; }
      .rb-webrtc__settings { inset: 44px 6px 6px; width: auto; padding: 10px; -webkit-overflow-scrolling: touch; }
      .rb-webrtc__advanced-grid { grid-template-columns: minmax(0, 1fr); }
      .rb-webrtc__advanced-grid .wide { grid-column: auto; }
      .rb-webrtc__stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .rb-webrtc__footer { align-items: flex-start; }
    }
  </style>
  <section class="rb-webrtc" aria-label="WebRTC RTSP Camera panel">
    <header class="rb-webrtc__toolbar">
      <h2 class="rb-webrtc__title">WebRTC / RTSP Camera</h2>
      <span class="rb-webrtc__status"><i class="rb-webrtc__dot"></i><span data-role="status">Not connected</span></span>
      <button type="button" data-action="connect">Connect</button>
      <button type="button" data-action="disconnect" disabled>Disconnect</button>
      <button type="button" data-action="configure" aria-expanded="false">Configure</button>
    </header>
    <form class="rb-webrtc__settings" data-role="settings" aria-label="WebRTC stream configuration" hidden>
      <div class="rb-webrtc__settings-header">
        <h3>Stream source</h3>
        <button type="button" data-action="close-settings" aria-label="Close configuration">\xD7</button>
      </div>
      <div class="rb-webrtc__source">
        <label>Available stream
          <span class="rb-webrtc__input-row">
            <select data-field="source"><option value="">Discovering streams\u2026</option><option value="${CUSTOM_SOURCE}">Custom URL\u2026</option></select>
            <button type="button" data-action="refresh-streams">Refresh</button>
          </span>
        </label>
        <p class="rb-webrtc__helper" data-role="discovery-status">Checking the active media gateway\u2026</p>
        <div class="rb-webrtc__custom" data-role="custom-source" hidden>
          <label>WebRTC playback (WHEP)
            <input data-field="whepUrl" inputmode="url" autocomplete="url" />
          </label>
          <label>RTSP gateway source
            <input data-field="rtspUrl" inputmode="url" autocomplete="url" />
          </label>
        </div>
        <p class="rb-webrtc__notice">Ready streams are discovered from the active gateway. Choose Custom URL only for a stream outside Robo-Boy's gateway. Browsers use WHEP; RTSP is shown for native clients.</p>
      </div>
      <details class="rb-webrtc__advanced">
        <summary>Connection and display settings</summary>
        <div class="rb-webrtc__advanced-grid">
          <label>Video fit
            <select data-field="fit"><option value="contain">Contain</option><option value="cover">Cover</option><option value="fill">Stretch</option></select>
          </label>
          <label class="rb-webrtc__check"><input data-field="receiveAudio" type="checkbox" />Receive audio</label>
          <label class="rb-webrtc__check"><input data-field="autoConnect" type="checkbox" />Connect automatically</label>
          <label>Bearer token (this session only)
            <input data-field="token" type="password" autocomplete="off" />
          </label>
          <label class="wide">STUN/TURN servers
            <textarea data-field="iceServers" placeholder="stun:stun.example.org:3478&#10;turns:turn.example.org:5349"></textarea>
          </label>
          <fieldset class="rb-webrtc__stats-options wide">
            <legend>Visible stream statistics</legend>
            <div class="rb-webrtc__stats-grid">
              <label class="rb-webrtc__check"><input data-stat-toggle="resolution" type="checkbox" />Resolution</label>
              <label class="rb-webrtc__check"><input data-stat-toggle="bitrate" type="checkbox" />Bitrate</label>
              <label class="rb-webrtc__check"><input data-stat-toggle="fps" type="checkbox" />Frame rate</label>
              <label class="rb-webrtc__check"><input data-stat-toggle="latency" type="checkbox" />RTT latency</label>
              <label class="rb-webrtc__check"><input data-stat-toggle="jitter" type="checkbox" />Jitter</label>
              <label class="rb-webrtc__check"><input data-stat-toggle="packetLoss" type="checkbox" />Packet loss</label>
              <label class="rb-webrtc__check"><input data-stat-toggle="framesDropped" type="checkbox" />Dropped frames</label>
            </div>
          </fieldset>
        </div>
      </details>
      <div class="rb-webrtc__settings-actions">
        <button type="submit">Apply & connect</button>
        <button type="button" data-action="close-settings">Cancel</button>
      </div>
    </form>
    <div class="rb-webrtc__stage">
      <video data-role="video" autoplay muted playsinline></video>
      <div class="rb-webrtc__placeholder" data-role="placeholder"><strong>Low-latency camera</strong><span>Select an available stream or enter a custom WHEP endpoint.</span></div>
    </div>
    <footer class="rb-webrtc__footer">
      <div class="rb-webrtc__metrics" aria-label="WebRTC stream statistics">
        <span class="rb-webrtc__protocol">WHEP</span>
        <span class="rb-webrtc__metric" data-stat="resolution"><small>Size</small><strong data-role="resolution">\u2014</strong></span>
        <span class="rb-webrtc__metric" data-stat="bitrate"><small>Bitrate</small><strong data-role="bitrate">\u2014</strong></span>
        <span class="rb-webrtc__metric" data-stat="fps"><small>FPS</small><strong data-role="fps">\u2014</strong></span>
        <span class="rb-webrtc__metric" data-stat="latency"><small>RTT</small><strong data-role="latency">\u2014</strong></span>
        <span class="rb-webrtc__metric" data-stat="jitter"><small>Jitter</small><strong data-role="jitter">\u2014</strong></span>
        <span class="rb-webrtc__metric" data-stat="packetLoss"><small>Loss</small><strong data-role="packetLoss">\u2014</strong></span>
        <span class="rb-webrtc__metric" data-stat="framesDropped"><small>Dropped</small><strong data-role="framesDropped">\u2014</strong></span>
      </div>
    </footer>
  </section>
`;
var createPanelInstance = (context) => {
  const browserBaseUrl = globalThis.location?.href ?? "http://localhost/";
  const discoveryEndpoint = deriveGatewayDiscoveryEndpoint(
    context.runtime.endpoints.videoStream,
    browserBaseUrl
  );
  const defaults = {
    sourceMode: "discovered",
    streamPath: "",
    whepUrl: "",
    rtspUrl: "",
    fit: "contain",
    receiveAudio: false,
    autoConnect: true,
    iceServers: "",
    visibleStats: DEFAULT_VISIBLE_STATS
  };
  let config = sanitizeConfig(
    context.storage?.get("config", defaults),
    defaults
  );
  let root = null;
  let settings = null;
  let video = null;
  let connection = null;
  let attemptController = null;
  let discoveryController = null;
  let availableStreams = [];
  let statsTimer = null;
  let connectionTimer = null;
  let viewportUnsubscribe = null;
  let active = true;
  let generation = 0;
  let statsBaseline = { bytesReceived: 0, sampledAt: 0 };
  const query = (selector) => {
    const element = root?.querySelector(selector);
    if (!element) throw new Error(`WebRTC panel is missing ${selector}.`);
    return element;
  };
  const setStatus = (message, tone = "idle") => {
    if (!root) return;
    query('[data-role="status"]').textContent = message;
    query(".rb-webrtc__dot").dataset.tone = tone;
  };
  const setSettingsOpen = (open) => {
    if (!settings || !root) return;
    if (open) populateInputs();
    settings.hidden = !open;
    query('[data-action="configure"]').setAttribute(
      "aria-expanded",
      String(open)
    );
  };
  const persistConfig = () => {
    try {
      context.storage?.set("config", config);
    } catch (error) {
      context.logger.warn("Unable to persist WebRTC settings.", error);
    }
  };
  const streamLabel = (stream) => {
    const name = stream.name.replace(/[_-]+/g, " ");
    const label = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    return stream.tracks.length > 0 ? `${label} \xB7 ${stream.tracks.join(", ")}` : label;
  };
  const setCustomSourceVisible = (visible) => {
    if (!root) return;
    query('[data-role="custom-source"]').hidden = !visible;
  };
  const applySourceSelection = () => {
    if (!root) return;
    const selected = query('[data-field="source"]').value;
    const custom = selected === CUSTOM_SOURCE;
    setCustomSourceVisible(custom);
    if (custom || !selected) return;
    const endpoints = deriveGatewayEndpoints(
      context.runtime.endpoints.videoStream,
      browserBaseUrl,
      selected
    );
    query('[data-field="whepUrl"]').value = endpoints.whep;
    query('[data-field="rtspUrl"]').value = endpoints.rtsp;
  };
  const renderSourceOptions = () => {
    if (!root) return;
    const select = query('[data-field="source"]');
    select.replaceChildren();
    if (availableStreams.length === 0) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "No ready streams";
      empty.disabled = true;
      select.append(empty);
    }
    for (const stream of availableStreams) {
      const option = document.createElement("option");
      option.value = stream.name;
      option.textContent = streamLabel(stream);
      select.append(option);
    }
    const custom = document.createElement("option");
    custom.value = CUSTOM_SOURCE;
    custom.textContent = "Custom URL\u2026";
    select.append(custom);
    if (config.sourceMode === "custom") select.value = CUSTOM_SOURCE;
    else if (availableStreams.some((stream) => stream.name === config.streamPath))
      select.value = config.streamPath;
    else select.value = availableStreams[0]?.name ?? "";
    applySourceSelection();
  };
  const renderStatsVisibility = () => {
    if (!root) return;
    for (const key of STATISTIC_KEYS) {
      query(`[data-stat="${key}"]`).hidden = !config.visibleStats[key];
    }
  };
  const populateInputs = () => {
    if (!root) return;
    query('[data-field="whepUrl"]').value = config.whepUrl;
    query('[data-field="rtspUrl"]').value = config.rtspUrl;
    query('[data-field="fit"]').value = config.fit;
    query('[data-field="receiveAudio"]').checked = config.receiveAudio;
    query('[data-field="autoConnect"]').checked = config.autoConnect;
    query('[data-field="iceServers"]').value = config.iceServers;
    query('[data-field="token"]').value = "";
    for (const key of STATISTIC_KEYS) {
      query(`[data-stat-toggle="${key}"]`).checked = config.visibleStats[key];
    }
    renderSourceOptions();
    renderStatsVisibility();
  };
  const readInputs = () => {
    const selected = query('[data-field="source"]').value;
    return sanitizeConfig(
      {
        sourceMode: selected === CUSTOM_SOURCE ? "custom" : "discovered",
        streamPath: selected === CUSTOM_SOURCE ? "" : selected,
        whepUrl: query('[data-field="whepUrl"]').value,
        rtspUrl: query('[data-field="rtspUrl"]').value,
        fit: query('[data-field="fit"]').value,
        receiveAudio: query('[data-field="receiveAudio"]').checked,
        autoConnect: query('[data-field="autoConnect"]').checked,
        iceServers: query('[data-field="iceServers"]').value,
        visibleStats: Object.fromEntries(
          STATISTIC_KEYS.map((key) => [
            key,
            query(`[data-stat-toggle="${key}"]`).checked
          ])
        )
      },
      defaults
    );
  };
  const stopStats = () => {
    if (statsTimer !== null) clearInterval(statsTimer);
    statsTimer = null;
    if (connectionTimer !== null) clearTimeout(connectionTimer);
    connectionTimer = null;
    statsBaseline = { bytesReceived: 0, sampledAt: 0 };
    if (root) {
      for (const role of [
        "resolution",
        "bitrate",
        "fps",
        "latency",
        "jitter",
        "packetLoss",
        "framesDropped"
      ])
        query(`[data-role="${role}"]`).textContent = "\u2014";
    }
  };
  const updateStats = async () => {
    if (!connection || !root) return;
    const report = await connection.peer.getStats();
    const metrics = collectWebRtcMetrics(
      report,
      statsBaseline,
      performance.now()
    );
    statsBaseline = metrics.baseline;
    query('[data-role="bitrate"]').textContent = metrics.bitrateKbps === void 0 ? "\u2014" : `${Math.round(metrics.bitrateKbps)} kb/s`;
    query('[data-role="fps"]').textContent = metrics.framesPerSecond === void 0 ? "\u2014" : String(Math.round(metrics.framesPerSecond));
    query('[data-role="latency"]').textContent = metrics.roundTripTimeMs === void 0 ? "\u2014" : `${Math.round(metrics.roundTripTimeMs)} ms`;
    query('[data-role="jitter"]').textContent = metrics.jitterMs === void 0 ? "\u2014" : `${metrics.jitterMs.toFixed(1)} ms`;
    query('[data-role="packetLoss"]').textContent = metrics.packetsLost === void 0 ? "\u2014" : `${metrics.packetsLost} (${(metrics.packetLossPercent ?? 0).toFixed(2)}%)`;
    query('[data-role="framesDropped"]').textContent = metrics.framesDropped === void 0 ? "\u2014" : String(metrics.framesDropped);
  };
  const disconnect = async (showStatus = true) => {
    generation += 1;
    attemptController?.abort();
    attemptController = null;
    stopStats();
    const current = connection;
    connection = null;
    await current?.close();
    if (video) video.srcObject = null;
    if (root) {
      query('[data-role="placeholder"]').hidden = false;
      query('[data-action="connect"]').disabled = false;
      query('[data-action="disconnect"]').disabled = true;
      if (showStatus) setStatus("Disconnected");
    }
  };
  const connect = async () => {
    if (!root || !video || !active) return;
    if (!config.whepUrl) {
      setStatus("Select an available stream first.", "warn");
      setSettingsOpen(true);
      return;
    }
    await disconnect(false);
    const currentGeneration = generation;
    const controller = new AbortController();
    attemptController = controller;
    query('[data-action="connect"]').disabled = true;
    query('[data-action="disconnect"]').disabled = false;
    setStatus("Negotiating WebRTC\u2026", "warn");
    try {
      const endpoint = normalizeWhepEndpoint(config.whepUrl, browserBaseUrl);
      const token = query(
        '[data-field="token"]'
      ).value.trim();
      const nextConnection = await connectWhep({
        endpoint,
        token,
        iceServers: parseIceServers(config.iceServers),
        receiveAudio: config.receiveAudio,
        signal: controller.signal,
        onTrack(event) {
          if (!video) return;
          video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          query('[data-role="placeholder"]').hidden = true;
          void video.play().catch(() => setStatus("Stream ready \xB7 tap video to play", "warn"));
        },
        onStateChange(state) {
          if (!root) return;
          if (state === "connected") {
            if (connectionTimer !== null) clearTimeout(connectionTimer);
            connectionTimer = null;
            setStatus("Live \xB7 WebRTC", "live");
          } else if (state === "failed" || state === "disconnected")
            setStatus(`WebRTC ${state}`, "warn");
          else
            setStatus(
              `WebRTC ${state}`,
              state === "connecting" ? "warn" : "idle"
            );
        }
      });
      if (currentGeneration !== generation || controller.signal.aborted) {
        await nextConnection.close();
        return;
      }
      connection = nextConnection;
      attemptController = null;
      if (nextConnection.peer.connectionState !== "connected") {
        connectionTimer = setTimeout(() => {
          if (connection !== nextConnection || nextConnection.peer.connectionState === "connected")
            return;
          void disconnect(false).then(() => {
            setStatus(
              "ICE media path timed out \xB7 check VPN or TURN relay",
              "warn"
            );
          });
        }, 15e3);
      }
      statsTimer = setInterval(() => void updateStats(), 1e3);
    } catch (error) {
      if (controller.signal.aborted) return;
      context.logger.warn("WebRTC connection failed.", error);
      setStatus(
        error instanceof Error ? error.message : "WebRTC connection failed",
        "warn"
      );
      query('[data-action="connect"]').disabled = false;
      query('[data-action="disconnect"]').disabled = true;
    }
  };
  const refreshStreams = async (connectAfter = false) => {
    discoveryController?.abort();
    const controller = new AbortController();
    discoveryController = controller;
    if (root) {
      query('[data-action="refresh-streams"]').disabled = true;
      query('[data-role="discovery-status"]').textContent = "Checking the active media gateway\u2026";
    }
    try {
      const streams = await discoverGatewayStreams(
        discoveryEndpoint,
        controller.signal
      );
      if (controller.signal.aborted || !active || !root) return;
      availableStreams = streams;
      if (config.sourceMode === "discovered" && streams.length > 0) {
        const selected = streams.find((stream) => stream.name === config.streamPath) ?? streams[0];
        const endpoints = deriveGatewayEndpoints(
          context.runtime.endpoints.videoStream,
          browserBaseUrl,
          selected.name
        );
        config = {
          ...config,
          streamPath: selected.name,
          whepUrl: endpoints.whep,
          rtspUrl: endpoints.rtsp
        };
        persistConfig();
      }
      populateInputs();
      query('[data-role="discovery-status"]').textContent = streams.length === 0 ? "No ready streams are currently published." : `${streams.length} ready ${streams.length === 1 ? "stream" : "streams"} found.`;
      if (connectAfter && config.autoConnect) {
        if (config.sourceMode === "custom" || streams.length > 0)
          void connect();
        else setStatus("No ready streams available", "warn");
      }
    } catch (error) {
      if (controller.signal.aborted || !active || !root) return;
      availableStreams = [];
      renderSourceOptions();
      query('[data-role="discovery-status"]').textContent = "Automatic discovery is unavailable. Use Custom URL or refresh.";
      context.logger.warn("Unable to discover WebRTC streams.", error);
      if (config.whepUrl) {
        const select = query('[data-field="source"]');
        select.value = CUSTOM_SOURCE;
        setCustomSourceVisible(true);
        if (connectAfter && config.autoConnect) void connect();
      } else if (connectAfter) {
        setStatus("Stream discovery unavailable", "warn");
      }
    } finally {
      if (discoveryController === controller) discoveryController = null;
      if (root)
        query('[data-action="refresh-streams"]').disabled = false;
    }
  };
  return {
    mount(container) {
      container.innerHTML = PANEL_MARKUP;
      root = container.querySelector(".rb-webrtc");
      if (!root) throw new Error("Unable to create the WebRTC panel root.");
      settings = query('[data-role="settings"]');
      video = query('[data-role="video"]');
      video.style.objectFit = config.fit;
      video.muted = !config.receiveAudio;
      populateInputs();
      video.addEventListener("loadedmetadata", () => {
        if (!video || !root) return;
        query('[data-role="resolution"]').textContent = `${video.videoWidth || "\u2014"}\xD7${video.videoHeight || "\u2014"}`;
      });
      video.addEventListener("click", () => void video?.play());
      root.addEventListener("click", (event) => {
        const action = event.target instanceof Element ? event.target.closest("[data-action]")?.dataset.action : void 0;
        if (action === "connect") void connect();
        else if (action === "disconnect") void disconnect();
        else if (action === "configure") setSettingsOpen(settings.hidden);
        else if (action === "close-settings") setSettingsOpen(false);
        else if (action === "refresh-streams") void refreshStreams();
      });
      root.addEventListener("change", (event) => {
        if (event.target instanceof HTMLSelectElement && event.target.matches('[data-field="source"]'))
          applySourceSelection();
      });
      settings.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
          config = readInputs();
          normalizeWhepEndpoint(config.whepUrl, browserBaseUrl);
          parseIceServers(config.iceServers);
          if (config.rtspUrl) {
            const rtsp = new URL(config.rtspUrl);
            if (rtsp.protocol !== "rtsp:" && rtsp.protocol !== "rtsps:")
              throw new Error("The RTSP source must use rtsp:// or rtsps://.");
          }
          persistConfig();
          video.style.objectFit = config.fit;
          video.muted = !config.receiveAudio;
          renderStatsVisibility();
          setSettingsOpen(false);
          void connect();
        } catch (error) {
          setStatus(
            error instanceof Error ? error.message : "Invalid stream settings",
            "warn"
          );
        }
      });
      viewportUnsubscribe = context.viewport.subscribe((snapshot) => {
        root?.toggleAttribute(
          "data-compact",
          snapshot.width < 540 || snapshot.height < 320
        );
      });
      void refreshStreams(true);
    },
    setActive(isActive) {
      const wasActive = active;
      active = isActive;
      if (!isActive) void disconnect(false);
      else if (!wasActive && config.autoConnect) void refreshStreams(true);
    },
    async unmount() {
      active = false;
      discoveryController?.abort();
      discoveryController = null;
      viewportUnsubscribe?.();
      viewportUnsubscribe = null;
      await disconnect(false);
      root?.remove();
      root = null;
      settings = null;
      video = null;
    }
  };
};
var definition = {
  apiVersion: "1.0.0",
  id: PANEL_ID,
  activate: createPanelInstance
};
var index_default = definition;
export {
  index_default as default
};
