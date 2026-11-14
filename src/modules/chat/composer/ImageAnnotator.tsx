import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Check, Pencil, RectangleHorizontal, Slash, Trash2, Type, Undo2, X } from 'lucide-react';

type AnnotationTool = 'pen' | 'line' | 'arrow' | 'rect' | 'text';

type Point = { x: number; y: number };

type Box = { x: number; y: number; width: number; height: number };

type StrokeAnnotation = {
  tool: 'pen' | 'line' | 'arrow' | 'rect';
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

/** A text box being typed, not yet part of the drawing. `editIndex` is set when it reopens an existing text. */
type TextDraft = { id: number; at: Point; value: string; color: string; fontSize: number; editIndex?: number };

/** The drawing plus every earlier version of it, newest last, for undo. */
type DrawingHistory = { annotations: Annotation[]; past: Annotation[][] };

type Corner = 'nw' | 'ne' | 'sw' | 'se';

/** A move or proportional resize of one text, measured from where the pointer went down. */
type TextDrag = {
  pointerId: number;
  index: number;
  original: TextAnnotation;
  startX: number;
  startY: number;
  corner?: Corner;
  recorded: boolean;
};

type View = { zoom: number; x: number; y: number };

type ImageAnnotatorProps = {
  file: File;
  onCancel: () => void;
  onSave: (annotated: File) => void;
};

const COLORS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#ffffff', '#000000'];

const TOOLS: Array<{ id: AnnotationTool; icon: typeof Pencil; labelKey: string }> = [
  { id: 'pen', icon: Pencil, labelKey: 'annotate.pen' },
  { id: 'line', icon: Slash, labelKey: 'annotate.line' },
  { id: 'arrow', icon: ArrowUpRight, labelKey: 'annotate.arrow' },
  { id: 'rect', icon: RectangleHorizontal, labelKey: 'annotate.rectangle' },
  { id: 'text', icon: Type, labelKey: 'annotate.text' },
];

const CORNERS: Array<{ id: Corner; style: CSSProperties; cursor: string }> = [
  { id: 'nw', style: { left: 0, top: 0 }, cursor: 'nwse-resize' },
  { id: 'ne', style: { right: 0, top: 0 }, cursor: 'nesw-resize' },
  { id: 'sw', style: { left: 0, bottom: 0 }, cursor: 'nesw-resize' },
  { id: 'se', style: { right: 0, bottom: 0 }, cursor: 'nwse-resize' },
];

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;
const MIN_FONT_SIZE = 8;
const DEFAULT_VIEW: View = { zoom: 1, x: 0, y: 0 };
const TEXT_LINE_HEIGHT = 1.2;
const TEXT_FONT = 'bold {size}px ui-sans-serif, system-ui, sans-serif';
const SELECTION_HANDLE_PX = 12;

const fontFor = (size: number) => TEXT_FONT.replace('{size}', String(size));

// A dark outline keeps light text readable on light screenshots, and vice versa for black.
const outlineFor = (color: string) => (color === '#000000' ? '#ffffff' : '#000000');

let measureContext: CanvasRenderingContext2D | null = null;

/** The area a text covers in image pixels, outline included. */
const textBox = (annotation: TextAnnotation): Box => {
  measureContext ??= document.createElement('canvas').getContext('2d');
  if (!measureContext) throw new Error('Canvas 2D context is unavailable');
  measureContext.font = fontFor(annotation.fontSize);
  const lines = annotation.text.split('\n');
  const width = Math.max(...lines.map((line) => measureContext!.measureText(line).width));
  const pad = annotation.fontSize * 0.15;
  return {
    x: annotation.at.x - pad,
    y: annotation.at.y - pad,
    width: width + pad * 2,
    height: lines.length * annotation.fontSize * TEXT_LINE_HEIGHT + pad * 2,
  };
};

const boxContains = (box: Box, point: Point) => (
  point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height
);

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
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    if (tool === 'arrow') {
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const headLength = width * 4;
      context.moveTo(end.x, end.y);
      context.lineTo(end.x - headLength * Math.cos(angle - Math.PI / 7), end.y - headLength * Math.sin(angle - Math.PI / 7));
      context.moveTo(end.x, end.y);
      context.lineTo(end.x - headLength * Math.cos(angle + Math.PI / 7), end.y - headLength * Math.sin(angle + Math.PI / 7));
    }
  }

  context.stroke();
};

/** Moves a text by an image-pixel offset, or scales it about the corner opposite the dragged one. */
const dragText = (drag: TextDrag, dx: number, dy: number): TextAnnotation => {
  const { original, corner } = drag;
  if (!corner) return { ...original, at: { x: original.at.x + dx, y: original.at.y + dy } };

  const box = textBox(original);
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;
  const dragged = { x: corner.endsWith('w') ? left : right, y: corner.startsWith('n') ? top : bottom };
  const anchor = { x: corner.endsWith('w') ? right : left, y: corner.startsWith('n') ? bottom : top };
  const diagonal = { x: dragged.x - anchor.x, y: dragged.y - anchor.y };
  const pointer = { x: dragged.x + dx - anchor.x, y: dragged.y + dy - anchor.y };
  // Projecting the pointer onto the box's diagonal keeps the aspect ratio fixed.
  const projected = (pointer.x * diagonal.x + pointer.y * diagonal.y) / (diagonal.x ** 2 + diagonal.y ** 2);
  const scale = Math.max(MIN_FONT_SIZE / original.fontSize, projected);
  return {
    ...original,
    fontSize: original.fontSize * scale,
    at: { x: anchor.x + (original.at.x - anchor.x) * scale, y: anchor.y + (original.at.y - anchor.y) * scale },
  };
};

const toPngName = (name: string) => `${name.replace(/\.[^.]+$/, '') || 'image'}.png`;

/**
 * Fullscreen editor for drawing on a pending image attachment (pen, line, arrow,
 * rectangle, text) before it is sent. Mouse wheel zooms, middle-drag pans;
 * with the text tool a placed text can be moved, resized and edited.
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
  const textDragRef = useRef<TextDrag | null>(null);
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const [history, setHistory] = useState<DrawingHistory>({ annotations: [], past: [] });
  const [textDraft, setTextDraftState] = useState<TextDraft | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [tool, setTool] = useState<AnnotationTool>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [panning, setPanning] = useState(false);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [displayWidth, setDisplayWidth] = useState(0);
  const [saving, setSaving] = useState(false);
  const { annotations } = history;

  const setTextDraft = (next: TextDraft | null) => {
    textDraftRef.current = next;
    setTextDraftState(next);
  };

  /** Changes the drawing as one undoable step. */
  const changeAnnotations = useCallback((update: (previous: Annotation[]) => Annotation[]) => {
    setHistory((current) => ({ annotations: update(current.annotations), past: [...current.past, current.annotations] }));
  }, []);

  const undo = useCallback(() => {
    setHistory((current) => (current.past.length === 0 ? current : { annotations: current.past[current.past.length - 1], past: current.past.slice(0, -1) }));
  }, []);

  const drawAll = useCallback((list: Annotation[], hiddenIndex?: number) => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !image || !context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    list.forEach((annotation, index) => {
      if (index !== hiddenIndex) drawAnnotation(context, annotation);
    });
    if (draftRef.current) drawAnnotation(context, draftRef.current);
  }, []);

  // A text being re-edited is hidden on the canvas, since its text box shows it.
  const editIndex = textDraft?.editIndex;
  const redraw = useCallback(() => drawAll(annotations, editIndex), [annotations, drawAll, editIndex]);

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

  // Tracks the canvas's on-screen width before zoom, which places the text overlays over the drawn text.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setDisplayWidth(canvas.clientWidth));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const imageDiagonal = imageSize ? Math.hypot(imageSize.width, imageSize.height) : 1000;
  const defaultFontSize = Math.max(18, Math.round(imageDiagonal / 45));
  // CSS pixels per image pixel before the zoom transform, which the stage applies to its overlays itself.
  const displayScale = imageSize && displayWidth > 0 ? displayWidth / imageSize.width : 1;
  const selectedText = selectedIndex !== null && annotations[selectedIndex]?.tool === 'text' ? annotations[selectedIndex] as TextAnnotation : null;

  const textAnnotationFrom = (draft: TextDraft): TextAnnotation | null => (
    draft.value.trim() ? { tool: 'text', color: draft.color, fontSize: draft.fontSize, at: draft.at, text: draft.value } : null
  );

  /** The drawing with the open text box applied: appended, or replacing (or, emptied, removing) the text it edits. */
  const withTextDraft = (list: Annotation[], draft: TextDraft): Annotation[] => {
    const annotation = textAnnotationFrom(draft);
    if (draft.editIndex === undefined) return annotation ? [...list, annotation] : list;
    return annotation
      ? list.map((current, index) => (index === draft.editIndex ? annotation : current))
      : list.filter((_, index) => index !== draft.editIndex);
  };

  /** Adds the open text box to the drawing and selects it; `id` limits it to that box, so a late blur cannot commit a newer one. */
  const commitTextDraft = (id?: number) => {
    const draft = textDraftRef.current;
    if (!draft || (id !== undefined && draft.id !== id)) return;
    setTextDraft(null);
    const kept = Boolean(textAnnotationFrom(draft));
    const unchanged = draft.editIndex !== undefined && kept && (annotations[draft.editIndex] as TextAnnotation).text === draft.value;
    if (!unchanged) changeAnnotations((previous) => withTextDraft(previous, draft));
    if (!kept) setSelectedIndex(null);
    else setSelectedIndex(draft.editIndex ?? annotations.length);
  };

  const openTextDraft = (draft: Omit<TextDraft, 'id'>) => {
    textDraftIdRef.current += 1;
    setTextDraft({ ...draft, id: textDraftIdRef.current });
    setSelectedIndex(null);
  };

  const deleteSelected = useCallback(() => {
    if (selectedIndex === null) return;
    changeAnnotations((previous) => previous.filter((_, index) => index !== selectedIndex));
    setSelectedIndex(null);
  }, [changeAnnotations, selectedIndex]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (textDraftRef.current) setTextDraft(null);
        else if (selectedIndex !== null) setSelectedIndex(null);
        else onCancel();
        return;
      }
      // Keys typed into the text box belong to it.
      if (textDraftRef.current) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(null);
        undo();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        deleteSelected();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [deleteSelected, onCancel, selectedIndex, undo]);

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
      if (textDraftRef.current) {
        commitTextDraft();
        return;
      }
      // Topmost first, so overlapping texts pick the one drawn last.
      let hitIndex = -1;
      for (let index = annotations.length - 1; index >= 0 && hitIndex === -1; index -= 1) {
        const annotation = annotations[index];
        if (annotation.tool === 'text' && boxContains(textBox(annotation), point)) hitIndex = index;
      }
      if (hitIndex !== -1) setSelectedIndex(hitIndex);
      else if (selectedIndex !== null) setSelectedIndex(null);
      else openTextDraft({ at: point, value: '', color, fontSize: defaultFontSize });
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
    changeAnnotations((previous) => [...previous, draft]);
  };

  const startTextDrag = (event: ReactPointerEvent<HTMLElement>, corner?: Corner) => {
    if (event.button !== 0 || selectedIndex === null || !selectedText) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    textDragRef.current = {
      pointerId: event.pointerId,
      index: selectedIndex,
      original: selectedText,
      startX: event.clientX,
      startY: event.clientY,
      corner,
      recorded: false,
    };
  };

  const handleTextDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = textDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const pixelsPerImagePixel = displayScale * view.zoom;
    const moved = dragText(drag, (event.clientX - drag.startX) / pixelsPerImagePixel, (event.clientY - drag.startY) / pixelsPerImagePixel);
    const replace = (list: Annotation[]) => list.map((annotation, index) => (index === drag.index ? moved : annotation));
    // The first movement is the undo step; later ones refine it in place.
    if (!drag.recorded) {
      drag.recorded = true;
      changeAnnotations(replace);
    } else {
      setHistory((current) => ({ ...current, annotations: replace(current.annotations) }));
    }
  };

  const endTextDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (textDragRef.current?.pointerId === event.pointerId) textDragRef.current = null;
  };

  const handleColorPick = (swatch: string) => {
    setColor(swatch);
    if (selectedText && selectedIndex !== null && selectedText.color !== swatch) {
      changeAnnotations((previous) => previous.map((annotation, index) => (index === selectedIndex ? { ...selectedText, color: swatch } : annotation)));
    }
  };

  const handleToolPick = (next: AnnotationTool) => {
    setTool(next);
    if (next !== 'text') setSelectedIndex(null);
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    const finalAnnotations = textDraftRef.current ? withTextDraft(annotations, textDraftRef.current) : annotations;
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

  /** Places an overlay over an image-pixel box, in the stage's unzoomed CSS pixels. */
  const overlayStyle = (box: Box): CSSProperties => (imageSize ? {
    left: `${(box.x / imageSize.width) * 100}%`,
    top: `${(box.y / imageSize.height) * 100}%`,
    width: `${(box.width / imageSize.width) * 100}%`,
    height: `${(box.height / imageSize.height) * 100}%`,
  } : {});

  const hasContent = annotations.length > 0 || Boolean(textDraft?.value.trim());
  const handleSize = SELECTION_HANDLE_PX / view.zoom;
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
            onClick={() => handleToolPick(id)}
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
            onClick={() => handleColorPick(swatch)}
            aria-label={swatch}
            aria-pressed={color === swatch}
            className={`m-1 h-6 w-6 rounded-full border-2 ${color === swatch ? 'border-white ring-2 ring-white/50' : 'border-white/30'}`}
            style={{ backgroundColor: swatch }}
          />
        ))}
        <div className="mx-1 h-6 w-px bg-white/20" />
        <button
          type="button"
          onClick={() => {
            setSelectedIndex(null);
            undo();
          }}
          disabled={history.past.length === 0}
          aria-label={t('annotate.undo')}
          title={t('annotate.undo')}
          className={toolbarButton}
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            changeAnnotations(() => []);
            setTextDraft(null);
            setSelectedIndex(null);
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
          {tool === 'text' && selectedText && !textDraft && (
            <div
              title={t('annotate.textSelectionHint')}
              onPointerDown={(event) => startTextDrag(event)}
              onPointerMove={handleTextDragMove}
              onPointerUp={endTextDrag}
              onPointerCancel={endTextDrag}
              onDoubleClick={() => openTextDraft({
                at: selectedText.at,
                value: selectedText.text,
                color: selectedText.color,
                fontSize: selectedText.fontSize,
                editIndex: selectedIndex ?? undefined,
              })}
              className="absolute cursor-move touch-none"
              style={{ ...overlayStyle(textBox(selectedText)), outline: `${1.5 / view.zoom}px dashed rgba(255,255,255,0.9)`, boxShadow: `0 0 0 ${1.5 / view.zoom}px rgba(0,0,0,0.6)` }}
            >
              {CORNERS.map(({ id, style, cursor }) => (
                <div
                  key={id}
                  onPointerDown={(event) => startTextDrag(event, id)}
                  className="absolute rounded-sm border border-black/60 bg-white"
                  style={{ ...style, cursor, width: handleSize, height: handleSize, margin: -handleSize / 2 }}
                />
              ))}
            </div>
          )}
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
                color: textDraft.color,
                fontSize: `${textDraft.fontSize * displayScale}px`,
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
