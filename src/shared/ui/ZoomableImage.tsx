import { type MouseEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/shared/utils';
import {
  DOUBLE_CLICK_SCALE,
  DRAG_THRESHOLD_PX,
  IDENTITY,
  MIN_SCALE,
  WHEEL_ZOOM_SPEED,
  type ZoomTransform,
  clampPan,
  zoomAt,
} from '@/shared/ui/zoomTransform';

type ZoomableImageProps = {
  src: string;
  alt: string;
  /** Classes for the viewport, which must have a size of its own (e.g. `h-full w-full`). */
  className?: string;
  imageClassName?: string;
  onImageClick?: (event: MouseEvent<HTMLImageElement>) => void;
};

/**
 * An image that zooms toward the cursor on scroll and pans by dragging once
 * zoomed. Double-click toggles between fit and a close-up. Clicks that end a
 * drag do not reach the caller, so a drag never closes a surrounding lightbox.
 * Used by chat's ImageLightbox, file-tree's ImageViewer and the code editor's
 * media preview.
 */
export function ZoomableImage({ src, alt, className, imageClassName, onImageClick }: ZoomableImageProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // Keyed by src so a new image opens at fit size without resetting state from an effect.
  const [stored, setStored] = useState<{ src: string; transform: ZoomTransform }>({ src, transform: IDENTITY });
  const transform = stored.src === src ? stored.transform : IDENTITY;
  const setTransform = useCallback((next: ZoomTransform | ((current: ZoomTransform) => ZoomTransform)) => {
    setStored((previous) => {
      const current = previous.src === src ? previous.transform : IDENTITY;
      return { src, transform: typeof next === 'function' ? next(current) : next };
    });
  }, [src]);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  const clampToElements = useCallback((next: ZoomTransform): ZoomTransform => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image) {
      return next;
    }
    // offsetWidth is the laid-out size before the CSS transform is applied.
    return clampPan(next, { width: image.offsetWidth, height: image.offsetHeight }, { width: viewport.clientWidth, height: viewport.clientHeight });
  }, []);

  const pointFromCentre = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) };
  }, []);

  // React registers wheel listeners as passive, which cannot preventDefault the page scroll or the browser's pinch zoom.
  useEffect(() => {
    const viewport = viewportRef.current!;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = pointFromCentre(event.clientX, event.clientY);
      setTransform((current) => clampToElements(zoomAt(current, current.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED), point)));
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [clampToElements, pointFromCentre, setTransform]);

  const zoomed = transform.scale > MIN_SCALE;

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!zoomed || event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: transform.x, originY: transform.y, moved: false };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
      return;
    }
    drag.moved = true;
    setDragging(true);
    setTransform((current) => clampToElements({ scale: current.scale, x: drag.originX + dx, y: drag.originY + dy }));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    setDragging(false);
  };

  const handleClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.stopPropagation();
    }
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (zoomed) {
      setTransform(IDENTITY);
      return;
    }
    const point = pointFromCentre(event.clientX, event.clientY);
    setTransform((current) => clampToElements(zoomAt(current, DOUBLE_CLICK_SCALE, point)));
  };

  return (
    <div
      ref={viewportRef}
      className={cn(
        'relative flex select-none items-center justify-center overflow-hidden',
        zoomed && 'touch-none',
        zoomed && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={handleClickCapture}
      onDoubleClick={handleDoubleClick}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        onClick={onImageClick}
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
        className={cn('max-h-full max-w-full object-contain', !dragging && 'transition-transform duration-75 ease-out', imageClassName)}
      />
    </div>
  );
}
