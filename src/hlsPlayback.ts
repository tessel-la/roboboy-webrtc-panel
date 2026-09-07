import type { RoboBoyPanelNetwork } from "@tessel-la/roboboy-panel-sdk";

/**
 * Plays a low-latency HLS stream by feeding Media Source Extensions directly.
 *
 * A panel runs in a frame with an opaque origin, so the object URL a player would normally make for
 * its MediaSource comes back as blob:null/... and a media element refuses to load it. Attaching the
 * source itself needs no URL, and every request goes through the host, as a panel's requests must.
 * The gateway publishes one variant of video-only H.264 with whole-file parts, which is what keeps
 * this small; a stream with variants, byte ranges or audio would need more than this.
 */
export interface HlsPlaybackHandle {
  close(): void;
}

interface HlsPlaybackOptions {
  playlistUrl: string;
  video: HTMLVideoElement;
  network: RoboBoyPanelNetwork;
  onPlaying(): void;
  onFailure(reason: string): void;
}

/** Seconds of played-out video to keep behind the playhead. */
const BUFFER_BEHIND_SECONDS = 20;
const POLL_INTERVAL_MS = 500;

const resolve = (uri: string, base: string) => new URL(uri, base).toString();

const attribute = (line: string, name: string): string | null => {
  const quoted = new RegExp(`${name}="([^"]*)"`).exec(line);
  if (quoted) return quoted[1];
  const bare = new RegExp(`${name}=([^,]*)`).exec(line);
  return bare ? bare[1] : null;
};

/** The first variant's playlist and codecs. The gateway publishes exactly one. */
export const parseMasterPlaylist = (
  text: string,
  baseUrl: string,
): { url: string; codecs: string } => {
  const lines = text.split("\n").map((line) => line.trim());
  const index = lines.findIndex((line) => line.startsWith("#EXT-X-STREAM-INF:"));
  const uri = index >= 0 ? lines.slice(index + 1).find((line) => line && !line.startsWith("#")) : undefined;
  if (index < 0 || !uri) throw new Error("the playlist lists no stream");
  return {
    url: resolve(uri, baseUrl),
    codecs: attribute(lines[index], "CODECS") || "avc1.42c00d",
  };
};

export interface MediaPlaylist {
  initUrl: string | null;
  mediaSequence: number;
  segments: string[];
}

export const parseMediaPlaylist = (text: string, baseUrl: string): MediaPlaylist => {
  const playlist: MediaPlaylist = { initUrl: null, mediaSequence: 0, segments: [] };
  for (const line of text.split("\n").map((entry) => entry.trim())) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = attribute(line, "URI");
      if (uri) playlist.initUrl = resolve(uri, baseUrl);
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      playlist.mediaSequence = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length)) || 0;
    } else if (line && !line.startsWith("#")) {
      // A gap is a segment the gateway could not produce; it still occupies a sequence number.
      playlist.segments.push(line === "gap.mp4" ? "" : resolve(line, baseUrl));
    }
  }
  return playlist;
};

export const playHlsStream = (options: HlsPlaybackOptions): HlsPlaybackHandle => {
  const { playlistUrl, video, network, onPlaying, onFailure } = options;
  const controller = new AbortController();
  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  let objectUrl: string | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    sourceBuffer = null;
    mediaSource = null;
  };

  const fetchBytes = async (url: string): Promise<ArrayBuffer> => {
    const response = await network.fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
    return response.arrayBuffer();
  };

  const fetchText = async (url: string): Promise<string> => {
    const response = await network.fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
    return response.text();
  };

  /** Appends one buffer, resolving when the source buffer is ready for the next. */
  const append = (bytes: ArrayBuffer) =>
    new Promise<void>((resolveAppend, rejectAppend) => {
      const buffer = sourceBuffer;
      if (!buffer || closed) return resolveAppend();
      const done = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        resolveAppend();
      };
      const failed = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        rejectAppend(new Error("the media buffer rejected a segment"));
      };
      buffer.addEventListener("updateend", done);
      buffer.addEventListener("error", failed);
      try {
        buffer.appendBuffer(bytes);
      } catch (error) {
        failed();
        rejectAppend(error instanceof Error ? error : new Error(String(error)));
      }
    });

  /** Drops what has already played, so a long session cannot grow without bound. */
  const trim = async () => {
    const buffer = sourceBuffer;
    if (!buffer || buffer.updating || buffer.buffered.length === 0) return;
    const start = buffer.buffered.start(0);
    const until = video.currentTime - BUFFER_BEHIND_SECONDS;
    if (until <= start) return;
    await new Promise<void>((resolveTrim) => {
      const done = () => {
        buffer.removeEventListener("updateend", done);
        resolveTrim();
      };
      buffer.addEventListener("updateend", done);
      buffer.remove(start, until);
    });
  };

  const run = async () => {
    const master = parseMasterPlaylist(await fetchText(playlistUrl), playlistUrl);
    const mime = `video/mp4; codecs="${master.codecs}"`;
    if (!MediaSource.isTypeSupported(mime)) throw new Error(`${mime} is not playable here`);

    const source = new MediaSource();
    mediaSource = source;
    const opened = new Promise<void>((resolveOpen) =>
      source.addEventListener("sourceopen", () => resolveOpen(), { once: true })
    );
    try {
      video.srcObject = source as unknown as MediaProvider;
    } catch {
      objectUrl = URL.createObjectURL(source);
      video.src = objectUrl;
    }
    void video.play().catch(() => {});
    await opened;
    if (closed) return;

    sourceBuffer = source.addSourceBuffer(mime);
    sourceBuffer.mode = "segments";

    let initialised = false;
    let nextSequence = -1;
    let started = false;

    while (!closed) {
      const playlist = parseMediaPlaylist(await fetchText(master.url), master.url);
      if (closed) return;

      if (!initialised && playlist.initUrl) {
        await append(await fetchBytes(playlist.initUrl));
        initialised = true;
      }
      // Start at the live edge rather than replaying the window the gateway still holds.
      if (nextSequence < 0) nextSequence = playlist.mediaSequence + Math.max(playlist.segments.length - 2, 0);

      for (let offset = 0; offset < playlist.segments.length; offset += 1) {
        const sequence = playlist.mediaSequence + offset;
        if (sequence < nextSequence || closed) continue;
        const url = playlist.segments[offset];
        nextSequence = sequence + 1;
        if (!url) continue;
        await append(await fetchBytes(url));
        if (!started && sourceBuffer && sourceBuffer.buffered.length > 0) {
          started = true;
          // Segments carry the gateway's own timeline, so the buffer begins nowhere near zero and
          // the playhead would sit in a hole waiting for data that will never come.
          video.currentTime = sourceBuffer.buffered.start(0);
          onPlaying();
          void video.play().catch(() => {});
        }
      }

      await trim();
      await new Promise((wait) => setTimeout(wait, POLL_INTERVAL_MS));
    }
  };

  run().catch((error: unknown) => {
    if (closed || controller.signal.aborted) return;
    close();
    onFailure(error instanceof Error ? error.message : String(error));
  });

  return { close };
};
