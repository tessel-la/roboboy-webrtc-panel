import assert from "node:assert/strict";
import test from "node:test";
import { resolveVideoFit } from "../src/videoFit.ts";

test("honours an explicit choice unchanged", () => {
  for (const fit of ["contain", "cover", "fill"] as const) {
    assert.equal(resolveVideoFit(fit), fit);
  }
});

test("always contains the whole picture in auto mode", () => {
  assert.equal(resolveVideoFit("auto"), "contain");
});
