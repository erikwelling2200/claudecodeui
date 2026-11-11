import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Check, Pencil, RectangleHorizontal, Trash2, Undo2, X } from 'lucide-react';

type AnnotationTool = 'pen' | 'arrow' | 'rect';

type Point = { x: number; y: number };

type Annotation = {
  tool: AnnotationTool;
  color: string;
  width: number;
  points: Point[];
};

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
];

const drawAnnotation = (context: CanvasRenderingContext2D, annotation: Annotation) => {
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
 * rectangle) before it is sent. Saving flattens the drawing into a new PNG.
 *
 * Used by chat's ComposerAttachment when an attached image thumbnail is opened.
 */
export function ImageAnnotator({ file, onCancel, onSave }: ImageAnnotatorProps) {
  const { t } = useTranslation('chat');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const draftRef = useRef<Annotation | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<AnnotationTool>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !image || !context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    for (const annotation of annotations) drawAnnotation(context, annotation);
    if (draftRef.current) drawAnnotation(context, draftRef.current);
  }, [annotations]);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      imageRef.current = image;
      setLoaded(true);
    };
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (loaded) redraw();
  }, [loaded, redraw]);

  const undo = useCallback(() => setAnnotations((previous) => previous.slice(0, -1)), []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.stopPropagation();
        undo();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onCancel, undo]);

  // The canvas is drawn at the image's native size and scaled down by CSS, so pointer positions are mapped back.
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
    const canvas = event.currentTarget;
    canvas.setPointerCapture(event.pointerId);
    const width = Math.max(3, Math.hypot(canvas.width, canvas.height) / 300);
    draftRef.current = { tool, color, width, points: [toImagePoint(event)] };
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
    if (!canvas || annotations.length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    canvas.toBlob((blob) => {
      if (!blob) throw new Error('Could not encode the annotated image');
      onSave(new File([blob], toPngName(file.name), { type: 'image/png', lastModified: Date.now() }));
    }, 'image/png');
  };

  const toolbarButton = 'rounded-md p-2 text-white transition-colors hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-transparent';

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-black/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('annotate.title', { name: file.name })}
    >
      <div className="flex flex-wrap items-center justify-center gap-1 rounded-xl bg-white/10 p-1.5">
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
        <button type="button" onClick={() => setAnnotations([])} disabled={annotations.length === 0} aria-label={t('annotate.clear')} title={t('annotate.clear')} className={toolbarButton}>
          <Trash2 className="h-4 w-4" />
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
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={`max-h-[calc(100vh-7rem)] max-w-full cursor-crosshair touch-none rounded-lg shadow-2xl ${loaded ? '' : 'invisible'}`}
      />
    </div>,
    document.body,
  );
}
