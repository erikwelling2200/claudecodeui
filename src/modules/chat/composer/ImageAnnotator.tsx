import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Check, Pencil, RectangleHorizontal, Trash2, Type, Undo2, X } from 'lucide-react';

type AnnotationTool = 'pen' | 'arrow' | 'rect' | 'text';

type Point = { x: number; y: number };

type StrokeAnnotation = {
  tool: 'pen' | 'arrow' | 'rect';
  color: string;
  width: number;
  points: Point[];
};

type TextAnnotation = {
  tool: 'text';
  color: string;
  fontSize: number;
  at: Point;
  text: string;
};

type Annotation = StrokeAnnotation | TextAnnotation;

/** A text box being typed, not yet part of the drawing. */
type TextDraft = { id: number; at: Point; value: string };

type View = { zoom: number; x: number; y: number };

type ImageAnnotatorProps = {
  file: File;
  onCancel: () => void;
  onSave: (annotated: File) => void;
};

const COLORS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#ffffff', '#000000'];

const TOOLS: Array<{ id: AnnotationTool; icon: typeof Pencil; labelKey: string }> = [
  { id: 'pen', icon: Pencil, labelKey: 'annotate.pen' },
  { id: 'arrow', icon: ArrowUpRight, labelKey: 'annotate.arrow' },
  { id: 'rect', icon: RectangleHorizontal, labelKey: 'annotate.rectangle' },
  { id: 'text', icon: Type, labelKey: 'annotate.text' },
];

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;
const DEFAULT_VIEW: View = { zoom: 1, x: 0, y: 0 };
const TEXT_LINE_HEIGHT = 1.2;
const TEXT_FONT = 'bold {size}px ui-sans-serif, system-ui, sans-serif';

const fontFor = (size: number) => TEXT_FONT.replace('{size}', String(size));

// A dark outline keeps light text readable on light screenshots, and vice versa for black.
const outlineFor = (color: string) => (color === '#000000' ? '#ffffff' : '#000000');

const drawAnnotation = (context: CanvasRenderingContext2D, annotation: Annotation) => {
  if (annotation.tool === 'text') {
    const { at, color, fontSize, text } = annotation;
    context.font = fontFor(fontSize);
    context.textBaseline = 'top';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(2, fontSize / 7);
    context.strokeStyle = outlineFor(color);
    context.fillStyle = color;
    text.split('\n').forEach((line, index) => {
      const y = at.y + index * fontSize * TEXT_LINE_HEIGHT;
      context.strokeText(line, at.x, y);
      context.fillText(line, at.x, y);
    });
    return;
  }

  const { points, tool, color, width } = annotation;
  if (points.length === 0) return;

  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();

  const start = points[0];
  const end = points[points.length - 1];

  if (tool === 'pen') {
    context.moveTo(start.x, start.y);
    // A single click still leaves a visible dot.
    if (points.length === 1) context.lineTo(start.x + 0.01, start.y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  } else if (tool === 'rect') {
    context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
  } else {
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const headLength = width * 4;
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - headLength * Math.cos(angle - Math.PI / 7), end.y - headLength * Math.sin(angle - Math.PI / 7));
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - headLength * Math.cos(angle + Math.PI / 7), end.y - headLength * Math.sin(angle + Math.PI / 7));
  }

  context.stroke();
};

const toPngName = (name: string) => `${name.replace(/\.[^.]+$/, '') || 'image'}.png`;

/**
 * Fullscreen editor for drawing on a pending image attachment (pen, arrow,
 * rectangle, text) before it is sent. Mouse wheel zooms, middle-drag pans.
 * Saving flattens the drawing into a new PNG.
 *
 * Used by chat's ComposerAttachment when an attached image thumbnail is opened.
 */
export function ImageAnnotator({ file, onCancel, onSave }: ImageAnnotatorProps) {
  const { t } = useTranslation('chat');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const draftRef = useRef<StrokeAnnotation | null>(null);
  const textDraftRef = useRef<TextDraft | null>(null);
  const textDraftIdRef = useRef(0);
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [textDraft, setTextDraftState] = useState<TextDraft | null>(null);
  const [tool, setTool] = useState<AnnotationTool>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [panning, setPanning] = useState(false);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [displayWidth, setDisplayWidth] = useState(0);
  const [saving, setSaving] = useState(false);

  const setTextDraft = (next: TextDraft | null) => {
    textDraftRef.current = next;
    setTextDraftState(next);
  };

  const drawAll = useCallback((list: Annotation[]) => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !image || !context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    for (const annotation of list) drawAnnotation(context, annotation);
    if (draftRef.current) drawAnnotation(context, draftRef.current);
  }, []);

  const redraw = useCallback(() => drawAll(annotations), [annotations, drawAll]);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      imageRef.current = image;
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (imageSize) redraw();
  }, [imageSize, redraw]);

  // Tracks the canvas's on-screen width before zoom, which sizes the text box to match the drawn text.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setDisplayWidth(canvas.clientWidth));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const imageDiagonal = imageSize ? Math.hypot(imageSize.width, imageSize.height) : 1000;
  const fontSize = Math.max(18, Math.round(imageDiagonal / 45));

  const textAnnotationFrom = (draft: TextDraft): TextAnnotation | null => (
    draft.value.trim() ? { tool: 'text', color, fontSize, at: draft.at, text: draft.value } : null
  );

  /** Adds the open text box to the drawing; `id` limits it to that box, so a late blur cannot commit a newer one. */
  const commitTextDraft = (id?: number): TextAnnotation | null => {
    const draft = textDraftRef.current;
    if (!draft || (id !== undefined && draft.id !== id)) return null;
    setTextDraft(null);
    const annotation = textAnnotationFrom(draft);
    if (annotation) setAnnotations((previous) => [...previous, annotation]);
    return annotation;
  };

  const undo = useCallback(() => setAnnotations((previous) => previous.slice(0, -1)), []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (textDraftRef.current) setTextDraft(null);
        else onCancel();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !textDraftRef.current) {
        event.preventDefault();
        event.stopPropagation();
        undo();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onCancel, undo]);

  // Registered natively: React's wheel listener is passive, so it cannot stop the page from scrolling.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const stage = stageRef.current;
      if (!stage) return;
      const bounds = stage.getBoundingClientRect();
      setView((current) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * Math.exp(-event.deltaY * 0.0015)));
        const factor = 1 - zoom / current.zoom;
        // Keeps the image point under the cursor where it is.
        return { zoom, x: current.x + (event.clientX - bounds.left) * factor, y: current.y + (event.clientY - bounds.top) * factor };
      });
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, []);

  const handleViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    // Stops the browser's middle-click autoscroll.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
    setPanning(true);
  };

  const handleViewportPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.lastX;
    const dy = event.clientY - pan.lastY;
    pan.lastX = event.clientX;
    pan.lastY = event.clientY;
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  const handleViewportPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    setPanning(false);
  };

  // The canvas is drawn at the image's native size and scaled by CSS and the zoom, so pointer positions are mapped back.
  const toImagePoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const point = toImagePoint(event);

    if (tool === 'text') {
      // Keeps focus where it is, so the open text box is committed here rather than by its blur.
      event.preventDefault();
      commitTextDraft();
      textDraftIdRef.current += 1;
      setTextDraft({ id: textDraftIdRef.current, at: point, value: '' });
      return;
    }

    commitTextDraft();
    const canvas = event.currentTarget;
    canvas.setPointerCapture(event.pointerId);
    draftRef.current = { tool, color, width: Math.max(3, imageDiagonal / 300), points: [point] };
    redraw();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current;
    if (!draft) return;
    const point = toImagePoint(event);
    draft.points = draft.tool === 'pen' ? [...draft.points, point] : [draft.points[0], point];
    redraw();
  };

  const handlePointerUp = () => {
    const draft = draftRef.current;
    if (!draft) return;
    draftRef.current = null;
    setAnnotations((previous) => [...previous, draft]);
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    const pendingText = textDraftRef.current ? textAnnotationFrom(textDraftRef.current) : null;
    const finalAnnotations = pendingText ? [...annotations, pendingText] : annotations;
    if (!canvas || finalAnnotations.length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    drawAll(finalAnnotations);
    canvas.toBlob((blob) => {
      if (!blob) throw new Error('Could not encode the annotated image');
      onSave(new File([blob], toPngName(file.name), { type: 'image/png', lastModified: Date.now() }));
    }, 'image/png');
  };

  // CSS pixels per image pixel before the zoom transform, which the stage applies to the text box itself.
  const displayScale = imageSize && displayWidth > 0 ? displayWidth / imageSize.width : 1;
  const hasContent = annotations.length > 0 || Boolean(textDraft?.value.trim());

  const toolbarButton = 'rounded-md p-2 text-white transition-colors hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-transparent';
  const canvasCursor = panning ? 'cursor-grabbing' : tool === 'text' ? 'cursor-text' : 'cursor-crosshair';

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center gap-3 bg-black/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('annotate.title', { name: file.name })}
    >
      <div className="z-10 flex flex-wrap items-center justify-center gap-1 rounded-xl bg-neutral-800/95 p-1.5">
        {TOOLS.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTool(id)}
            aria-label={t(labelKey)}
            title={t(labelKey)}
            aria-pressed={tool === id}
            className={`${toolbarButton} ${tool === id ? 'bg-white/25' : ''}`}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
        <div className="mx-1 h-6 w-px bg-white/20" />
        {COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            onClick={() => setColor(swatch)}
            aria-label={swatch}
            aria-pressed={color === swatch}
            className={`m-1 h-6 w-6 rounded-full border-2 ${color === swatch ? 'border-white ring-2 ring-white/50' : 'border-white/30'}`}
            style={{ backgroundColor: swatch }}
          />
        ))}
        <div className="mx-1 h-6 w-px bg-white/20" />
        <button type="button" onClick={undo} disabled={annotations.length === 0} aria-label={t('annotate.undo')} title={t('annotate.undo')} className={toolbarButton}>
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            setAnnotations([]);
            setTextDraft(null);
          }}
          disabled={!hasContent}
          aria-label={t('annotate.clear')}
          title={t('annotate.clear')}
          className={toolbarButton}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setView(DEFAULT_VIEW)}
          title={t('annotate.resetZoom')}
          className="min-w-14 rounded-md px-2 py-1.5 text-xs tabular-nums text-white transition-colors hover:bg-white/20"
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <div className="mx-1 h-6 w-px bg-white/20" />
        <button type="button" onClick={onCancel} aria-label={t('annotate.cancel')} title={t('annotate.cancel')} className={toolbarButton}>
          <X className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Check className="h-4 w-4" />
          {t('annotate.done')}
        </button>
      </div>
      <div
        ref={viewportRef}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerUp}
        onPointerCancel={handleViewportPointerUp}
        className={`relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden ${panning ? 'cursor-grabbing' : ''}`}
      >
        <div
          ref={stageRef}
          className="relative"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: '0 0' }}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={`block max-h-[calc(100vh-7rem)] max-w-[calc(100vw-2rem)] touch-none rounded-lg shadow-2xl ${canvasCursor} ${imageSize ? '' : 'invisible'}`}
          />
          {textDraft && imageSize && (
            <textarea
              key={textDraft.id}
              autoFocus
              rows={1}
              value={textDraft.value}
              placeholder={t('annotate.textPlaceholder')}
              onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
              onBlur={() => commitTextDraft(textDraft.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  commitTextDraft(textDraft.id);
                }
              }}
              className="absolute m-0 resize-none overflow-hidden whitespace-pre border border-dashed border-white/70 bg-black/20 p-0 font-bold outline-none placeholder:text-white/50"
              style={{
                left: `${(textDraft.at.x / imageSize.width) * 100}%`,
                top: `${(textDraft.at.y / imageSize.height) * 100}%`,
                color,
                fontSize: `${fontSize * displayScale}px`,
                lineHeight: TEXT_LINE_HEIGHT,
                fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                fieldSizing: 'content',
                minWidth: '2ch',
              } as CSSProperties}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
