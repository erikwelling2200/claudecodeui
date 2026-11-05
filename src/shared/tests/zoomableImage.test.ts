import assert from 'node:assert/strict';

import { test } from 'vitest';

import { clampPan, zoomAt } from '@/shared/ui/zoomTransform';

const viewport = { width: 800, height: 600 };
const image = { width: 400, height: 300 };

test('zoomAt keeps the pixel under the cursor in place', () => {
  const cursor = { x: 100, y: -50 };
  const start = { scale: 1, x: 0, y: 0 };
  const next = zoomAt(start, 3, cursor);

  // The image-local point under the cursor is (cursor - translate) / scale; it must not move.
  assert.deepEqual({ x: (cursor.x - start.x) / start.scale, y: (cursor.y - start.y) / start.scale }, { x: (cursor.x - next.x) / next.scale, y: (cursor.y - next.y) / next.scale });
});

test('zoomAt clamps the scale to the fit size and the maximum', () => {
  assert.equal(zoomAt({ scale: 2, x: 0, y: 0 }, 0.1, { x: 0, y: 0 }).scale, 1);
  assert.equal(zoomAt({ scale: 2, x: 0, y: 0 }, 999, { x: 0, y: 0 }).scale, 20);
});

test('clampPan snaps back to centre at fit size', () => {
  assert.deepEqual(clampPan({ scale: 1, x: 120, y: -40 }, image, viewport), { scale: 1, x: 0, y: 0 });
});

test('clampPan keeps a zoomed image covering the viewport', () => {
  // 4x makes the image 1600x1200, so it may shift at most (1600-800)/2 and (1200-600)/2.
  assert.deepEqual(clampPan({ scale: 4, x: 5000, y: -5000 }, image, viewport), { scale: 4, x: 400, y: -300 });
});

test('clampPan keeps a still-small image inside the viewport', () => {
  // 1.5x makes the image 600x450, leaving (800-600)/2 and (600-450)/2 of room.
  assert.deepEqual(clampPan({ scale: 1.5, x: -500, y: 500 }, image, viewport), { scale: 1.5, x: -100, y: 75 });
});
