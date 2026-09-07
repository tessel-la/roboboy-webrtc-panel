export type VideoFit = "auto" | "contain" | "cover" | "fill";

/** What fraction of the picture `cover` would crop away. */
const croppedFraction = (containerAspect: number, videoAspect: number): number =>
  1 - Math.min(containerAspect, videoAspect) / Math.max(containerAspect, videoAspect);

/**
 * How much of the picture may be cropped before showing all of it matters more than filling the
 * panel. A camera can have something important at the edge of frame, so the trade only goes one
 * way: fill the panel when the shapes nearly agree, and never hide much to do it.
 *
 * Set so a 4:3 camera fills a 16:9 panel, which costs a quarter of the height and is the shape
 * most panels end up, while a wide split -- where filling would hide half the frame -- does not.
 */
export const AUTO_CROP_LIMIT = 0.3;

export const resolveVideoFit = (
  fit: VideoFit,
  container: { width: number; height: number },
  video: { width: number; height: number },
): Exclude<VideoFit, "auto"> => {
  if (fit !== "auto") return fit;
  if (!container.width || !container.height || !video.width || !video.height) return "contain";
  const cropped = croppedFraction(container.width / container.height, video.width / video.height);
  return cropped <= AUTO_CROP_LIMIT ? "cover" : "contain";
};
