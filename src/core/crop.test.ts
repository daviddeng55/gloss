import assert from "node:assert/strict";
import { test } from "node:test";
import { cropFor } from "./crop.ts";

const screen = { x: 0, y: 0, w: 1470, h: 956 };

test("a circled area is cropped to its bounding box plus padding", () => {
  const path = [{ x: 400, y: 300 }, { x: 600, y: 280 }, { x: 640, y: 420 }, { x: 420, y: 450 }, { x: 400, y: 300 }];
  const r = cropFor(path, { x: 400, y: 300 }, screen);
  assert.equal(r.circled, true);
  assert.deepEqual(r.rect, { x: 376, y: 256, w: 288, h: 218 });
});

test("no circle (cursor barely moved): 900×700 around the cursor", () => {
  const r = cropFor([{ x: 700, y: 500 }, { x: 705, y: 503 }], { x: 705, y: 503 }, screen);
  assert.equal(r.circled, false);
  assert.deepEqual(r.rect, { x: 255, y: 153, w: 900, h: 700 });
});

test("crops stay on the screen, near edges and on a second display", () => {
  assert.deepEqual(cropFor([], { x: 20, y: 20 }, screen).rect, { x: 0, y: 0, w: 900, h: 700 });
  assert.deepEqual(cropFor([], { x: 1460, y: 950 }, screen).rect, { x: 570, y: 256, w: 900, h: 700 });
  const second = { x: 1470, y: -200, w: 1920, h: 1080 };
  assert.deepEqual(cropFor([], { x: 1500, y: -150 }, second).rect, { x: 1470, y: -200, w: 900, h: 700 });
  const tiny = { x: 0, y: 0, w: 800, h: 600 };
  assert.deepEqual(cropFor([], { x: 400, y: 300 }, tiny).rect, { x: 0, y: 0, w: 800, h: 600 });
});
