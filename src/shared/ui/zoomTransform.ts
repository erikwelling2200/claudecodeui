// Pure zoom/pan math for ZoomableImage, kept apart so the component file only exports components.

export const MIN_SCALE = 1;
export const MAX_SCALE = 20;
export const DOUBLE_CLICK_SCALE = 2.5;
// Per pixel of wheel delta; a mouse notch is ~100px, so one notch zooms ~22%.
export const WHEEL_ZOOM_SPEED = 0.002;
// Pointer travel below this still counts as a click, not a drag.
export const DRAG_THRESHOLD_PX = 3;

export type ZoomTransform = { scale: number; x: number; y: number };

type Size = { width: number; height: number };

export const IDENTITY: ZoomTransform = { scale: 1, x: 0, y: 0 };

/**
 * Keeps the scaled image from being dragged out of view: an image larger than
 * the viewport must keep covering it, a smaller one must stay inside it.
 */
export function clampPan(transform: ZoomTransform, image: Size, viewport: Size): ZoomTransform {
  if (transform.scale <= MIN_SCALE) {
    return IDENTITY;
  }
  const boundX = Math.abs(transform.scale * image.width - viewport.width) / 2;
  const boundY = Math.abs(transform.scale * image.height - viewport.height) / 2;
  return {
    scale: transform.scale,
    x: Math.min(boundX, Math.max(-boundX, transform.x)),
    y: Math.min(boundY, Math.max(-boundY, transform.y)),
  };
}

/**
 * Rescales around `point` (relative to the viewport centre, where the unscaled
 * image is centred), so the pixel under the cursor stays under the cursor.
 */
export function zoomAt(transform: ZoomTransform, nextScale: number, point: { x: number; y: number }): ZoomTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
  const ratio = scale / transform.scale;
  return {
    scale,
    x: point.x - ratio * (point.x - transform.x),
    y: point.y - ratio * (point.y - transform.y),
  };
}
