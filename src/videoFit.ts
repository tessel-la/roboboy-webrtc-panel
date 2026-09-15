export type VideoFit = "auto" | "contain" | "cover" | "fill";

/**
 * Auto follows the normal image viewer's contain behavior. The browser then scales the video
 * uniformly inside its 100%-sized element whenever the panel changes size.
 */
export const resolveVideoFit = (
  fit: VideoFit,
): Exclude<VideoFit, "auto"> => (fit === "auto" ? "contain" : fit);
