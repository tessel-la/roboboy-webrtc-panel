import assert from "node:assert/strict";
import test from "node:test";
import { resolveVideoFit } from "../src/videoFit.ts";

const camera = { width: 320, height: 240 }; // 4:3

test("honours an explicit choice unchanged", () => {
  for (const fit of ["contain", "cover", "fill"] as const) {
    assert.equal(resolveVideoFit(fit, { width: 1600, height: 400 }, camera), fit);
  }
});

test("fills the panel when its shape nearly matches the picture", () => {
  // 16:9 against 4:3 crops a quarter of the height -- worth it to use the whole panel.
  assert.equal(resolveVideoFit("auto", { width: 1280, height: 720 }, camera), "cover");
  assert.equal(resolveVideoFit("auto", { width: 640, height: 480 }, camera), "cover");
});

test("shows the whole picture when filling would hide too much of it", () => {
  // A wide split, which is where the letterboxing was worst -- but cropping here would cut
  // half the frame away, and a camera's edges can be the point.
  assert.equal(resolveVideoFit("auto", { width: 1900, height: 500 }, camera), "contain");
  assert.equal(resolveVideoFit("auto", { width: 400, height: 1200 }, camera), "contain");
});

test("shows the whole picture until both shapes are known", () => {
  assert.equal(resolveVideoFit("auto", { width: 0, height: 0 }, camera), "contain");
  assert.equal(resolveVideoFit("auto", { width: 800, height: 600 }, { width: 0, height: 0 }), "contain");
});
