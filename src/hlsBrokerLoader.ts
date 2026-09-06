import type { RoboBoyPanelNetwork } from "@tessel-la/roboboy-panel-sdk";

/**
 * Routes hls.js's own requests through the panel host.
 *
 * A panel is forbidden from reaching the network directly -- its sandbox sets `connect-src 'none'`
 * -- and hls.js fetches its playlists and every segment itself. Handing it a loader that goes
 * through the host keeps the one way out a panel has, so the stream endpoint stays as enforced as
 * every other request the panel makes.
 */
const newStats = () => ({
  aborted: false,
  loaded: 0,
  retry: 0,
  total: 0,
  chunkCount: 0,
  bwEstimate: 0,
  loading: { start: 0, first: 0, end: 0 },
  parsing: { start: 0, end: 0 },
  buffering: { start: 0, first: 0, end: 0 },
});

export const createHlsBrokerLoader = (network: RoboBoyPanelNetwork) =>
  class HlsBrokerLoader {
    context: unknown = null;
    stats = newStats();
    private controller: AbortController | null = null;

    destroy(): void {
      this.abort();
      this.context = null;
    }

    abort(): void {
      this.stats.aborted = true;
      this.controller?.abort();
      this.controller = null;
    }

    load(
      context: { url: string; responseType?: string },
      _config: unknown,
      callbacks: {
        onSuccess(response: { url: string; data: string | ArrayBuffer }, stats: unknown, context: unknown, networkDetails: unknown): void;
        onError(error: { code: number; text: string }, context: unknown, networkDetails: unknown, stats: unknown): void;
      }
    ): void {
      this.context = context;
      const stats = this.stats;
      const controller = new AbortController();
      this.controller = controller;
      stats.loading.start = performance.now();

      void (async () => {
        try {
          const response = await network.fetch(context.url, {
            cache: "no-store",
            signal: controller.signal,
          });
          stats.loading.first = performance.now();
          if (!response.ok) {
            throw Object.assign(new Error(response.statusText || `HTTP ${response.status}`), {
              code: response.status,
            });
          }
          // Playlists are text; segments are bytes, and decoding those would corrupt them.
          const data =
            context.responseType === "arraybuffer" ? await response.arrayBuffer() : await response.text();
          stats.loading.end = performance.now();
          const size = typeof data === "string" ? data.length : data.byteLength;
          stats.loaded = size;
          stats.total = size;
          if (this.controller !== controller) return;
          this.controller = null;
          callbacks.onSuccess({ url: context.url, data }, stats, context, null);
        } catch (error) {
          if (stats.aborted) return;
          this.controller = null;
          const code = (error as { code?: number }).code ?? 0;
          callbacks.onError({ code, text: error instanceof Error ? error.message : String(error) }, context, null, stats);
        }
      })();
    }
  };
