import assert from "node:assert/strict";
import test from "node:test";
import { parseMasterPlaylist, parseMediaPlaylist } from "../src/hlsPlayback.ts";

const BASE = "http://gateway.local:8888/wrist_camera/index.m3u8";

test("reads the variant and its codecs from a master playlist", () => {
  const master = parseMasterPlaylist(
    [
      "#EXTM3U",
      "#EXT-X-VERSION:10",
      '#EXT-X-STREAM-INF:BANDWIDTH=108760,CODECS="avc1.42c00d",RESOLUTION=320x240',
      "video1_stream.m3u8?session=abc",
    ].join("\n"),
    BASE,
  );

  assert.equal(master.url, "http://gateway.local:8888/wrist_camera/video1_stream.m3u8?session=abc");
  assert.equal(master.codecs, "avc1.42c00d");
});

test("refuses a master playlist that lists no stream", () => {
  assert.throws(() => parseMasterPlaylist("#EXTM3U\n", BASE), /lists no stream/);
});

test("reads the init segment, sequence and segments of a media playlist", () => {
  const media = parseMediaPlaylist(
    [
      "#EXTM3U",
      "#EXT-X-MEDIA-SEQUENCE:41040",
      '#EXT-X-MAP:URI="abc_video1_init.mp4?session=xyz"',
      "#EXTINF:1.2,",
      "abc_video1_seg41040.mp4?session=xyz",
      "#EXTINF:1.2,",
      "abc_video1_seg41041.mp4?session=xyz",
    ].join("\n"),
    "http://gateway.local:8888/wrist_camera/video1_stream.m3u8",
  );

  assert.equal(media.mediaSequence, 41040);
  assert.equal(media.initUrl, "http://gateway.local:8888/wrist_camera/abc_video1_init.mp4?session=xyz");
  assert.deepEqual(media.segments, [
    "http://gateway.local:8888/wrist_camera/abc_video1_seg41040.mp4?session=xyz",
    "http://gateway.local:8888/wrist_camera/abc_video1_seg41041.mp4?session=xyz",
  ]);
});

// A gap still occupies a sequence number, so dropping the line would misalign every later segment.
test("keeps a gap's place in the sequence without giving it a URL", () => {
  const media = parseMediaPlaylist(
    ["#EXT-X-MEDIA-SEQUENCE:5", "#EXT-X-GAP", "#EXTINF:1.2,", "gap.mp4", "#EXTINF:1.2,", "seg6.mp4"].join("\n"),
    "http://gateway.local:8888/wrist_camera/video1_stream.m3u8",
  );

  assert.equal(media.segments.length, 2);
  assert.equal(media.segments[0], "");
  assert.equal(media.segments[1], "http://gateway.local:8888/wrist_camera/seg6.mp4");
});
