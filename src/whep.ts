export interface WhepConnectionOptions {
  endpoint: string;
  token?: string;
  iceServers?: RTCIceServer[];
  receiveAudio?: boolean;
  signal?: AbortSignal;
  onTrack(track: RTCTrackEvent): void;
  onStateChange?(state: RTCPeerConnectionState): void;
  fetcher?: PanelFetch;
}

interface PanelFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

type PanelFetch = (
  url: string,
  request?: {
    method?: "GET" | "POST" | "DELETE" | "OPTIONS";
    headers?: Record<string, string>;
    body?: string;
    cache?: "default" | "no-store";
    signal?: AbortSignal;
  },
) => Promise<PanelFetchResponse>;

export interface WhepConnection {
  readonly peer: RTCPeerConnection;
  readonly sessionUrl: string | null;
  close(): Promise<void>;
}

export interface GatewayStream {
  name: string;
  tracks: string[];
}

const unquoteLinkValue = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\([\\"])/g, "$1");
};

export const parseIceServerLinks = (header: string | null): RTCIceServer[] => {
  if (!header) return [];
  const servers: RTCIceServer[] = [];
  const linkPattern =
    /<([^>]+)>\s*((?:;\s*[^,;=\s]+(?:\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^,;\s]+))?)*)/g;
  let link: RegExpExecArray | null;

  while ((link = linkPattern.exec(header))) {
    const url = link[1]?.trim() ?? "";
    if (!/^(stun|stuns|turn|turns):/i.test(url)) continue;
    const attributes = new Map<string, string>();
    const attributePattern =
      /;\s*([^,;=\s]+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^,;\s]+))?/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributePattern.exec(link[2] ?? ""))) {
      attributes.set(
        attribute[1].toLowerCase(),
        attribute[2] ? unquoteLinkValue(attribute[2]) : "",
      );
    }
    if (!attributes.get("rel")?.split(/\s+/).includes("ice-server")) continue;

    servers.push({
      urls: url,
      ...(attributes.has("username")
        ? { username: attributes.get("username") }
        : {}),
      ...(attributes.has("credential")
        ? { credential: attributes.get("credential") }
        : {}),
    });
  }
  return servers.slice(0, 8);
};

export const discoverWhepIceServers = async (
  endpoint: string,
  token?: string,
  signal?: AbortSignal,
  fetcher: PanelFetch = fetch,
): Promise<RTCIceServer[]> => {
  try {
    const response = await fetcher(endpoint, {
      method: "OPTIONS",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    });
    if (!response.ok) return [];
    return parseIceServerLinks(response.headers.get("Link"));
  } catch (error) {
    if (signal?.aborted) throw error;
    // ICE discovery is an optional WHEP extension. Direct candidates and any
    // manually configured ICE servers remain usable when it is unavailable.
    return [];
  }
};

export const normalizeWhepEndpoint = (
  value: string,
  baseUrl: string,
): string => {
  const endpoint = new URL(value.trim(), baseUrl);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("The WHEP endpoint must use HTTP or HTTPS.");
  }
  endpoint.hash = "";
  return endpoint.toString();
};

export const deriveGatewayEndpoints = (
  videoStreamBaseUrl: string,
  browserBaseUrl: string,
  streamPath: string,
): { whep: string; rtsp: string } => {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(streamPath)) {
    throw new Error("The gateway stream path is invalid.");
  }
  const browser = new URL(browserBaseUrl);
  const video = new URL(videoStreamBaseUrl, browserBaseUrl);
  const proxyBacked =
    videoStreamBaseUrl.startsWith("/") || video.pathname === "/video_stream";
  if (proxyBacked) {
    return {
      whep: `/webrtc/${streamPath}/whep`,
      rtsp: `rtsp://${video.hostname || browser.hostname}:8554/${streamPath}`,
    };
  }

  const signaling = new URL(video.toString());
  signaling.protocol = video.protocol === "https:" ? "https:" : "http:";
  signaling.port = "8889";
  signaling.pathname = `/${streamPath}/whep`;
  signaling.search = "";
  signaling.hash = "";
  return {
    whep: signaling.toString(),
    rtsp: `rtsp://${video.hostname}:8554/${streamPath}`,
  };
};

export const deriveGatewayDiscoveryEndpoint = (
  videoStreamBaseUrl: string,
  browserBaseUrl: string,
): string => {
  const video = new URL(videoStreamBaseUrl, browserBaseUrl);
  if (
    videoStreamBaseUrl.startsWith("/") ||
    video.pathname === "/video_stream"
  ) {
    return "/webrtc/_discovery/paths";
  }

  const endpoint = new URL(video.toString());
  endpoint.protocol = video.protocol === "https:" ? "https:" : "http:";
  endpoint.port = "9997";
  endpoint.pathname = "/v3/paths/list";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
};

export const parseGatewayStreams = (value: unknown): GatewayStream[] => {
  if (!value || typeof value !== "object") return [];
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const streams = new Map<string, GatewayStream>();
  for (const candidate of items) {
    if (!candidate || typeof candidate !== "object") continue;
    const path = candidate as {
      name?: unknown;
      ready?: unknown;
      tracks?: unknown;
    };
    if (
      path.ready !== true ||
      typeof path.name !== "string" ||
      !/^[a-z0-9][a-z0-9_-]*$/i.test(path.name)
    )
      continue;
    const tracks = Array.isArray(path.tracks)
      ? path.tracks
          .filter((track): track is string => typeof track === "string")
          .slice(0, 16)
      : [];
    streams.set(path.name, { name: path.name, tracks });
  }
  return [...streams.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
};

export const discoverGatewayStreams = async (
  endpoint: string,
  signal?: AbortSignal,
  fetcher: PanelFetch = fetch,
): Promise<GatewayStream[]> => {
  const response = await fetcher(endpoint, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Stream discovery failed (${response.status}).`);
  }
  return parseGatewayStreams(await response.json());
};

export const parseIceServers = (value: string): RTCIceServer[] => {
  return value
    .split(/[,\n]/)
    .map((url) => url.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((url) => {
      if (!/^(stun|stuns|turn|turns):/i.test(url)) {
        throw new Error(`Unsupported ICE server URL: ${url}`);
      }
      return { urls: url };
    });
};

export const resolveSessionUrl = (
  endpoint: string,
  locationHeader: string | null,
): string | null => {
  return locationHeader ? new URL(locationHeader, endpoint).toString() : null;
};

export const waitForIceGatheringComplete = async (
  peer: RTCPeerConnection,
  timeoutMs = 10000,
): Promise<void> => {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
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

export const connectWhep = async (
  options: WhepConnectionOptions,
): Promise<WhepConnection> => {
  const discoveredIceServers = await discoverWhepIceServers(
    options.endpoint,
    options.token,
    options.signal,
    options.fetcher,
  );
  const peer = new RTCPeerConnection({
    iceServers: [...(options.iceServers ?? []), ...discoveredIceServers].slice(
      0,
      8,
    ),
  });
  let sessionUrl: string | null = null;
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

    const response = await (options.fetcher ?? fetch)(options.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/sdp",
        "Content-Type": "application/sdp",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: peer.localDescription.sdp,
      signal: options.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 240);
      throw new Error(
        `WHEP negotiation failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const answer = await response.text();
    if (!answer.trim())
      throw new Error("The WHEP server returned an empty SDP answer.");
    sessionUrl = resolveSessionUrl(
      options.endpoint,
      response.headers.get("Location"),
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
          await (options.fetcher ?? fetch)(sessionUrl, {
            method: "DELETE",
            headers: options.token
              ? { Authorization: `Bearer ${options.token}` }
              : {},
          });
        } catch {
          // The peer is already closed; session cleanup is best effort.
        }
      }
    },
  };
};
