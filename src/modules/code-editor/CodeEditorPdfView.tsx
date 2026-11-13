import { useEffect, useRef, useState } from 'react';
import type * as PdfJsModule from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

type PdfJs = typeof PdfJsModule;

// Loaded on first use: pdf.js is large, and needs browser APIs that the test environment lacks.
let pdfJsPromise: Promise<PdfJs> | null = null;
const loadPdfJs = (): Promise<PdfJs> => {
  pdfJsPromise ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([pdfJs, worker]) => {
    pdfJs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfJs;
  });
  return pdfJsPromise;
};

const PAGE_GAP = 12;
const MAX_SCALE = 2;
// Pages within this distance of the viewport get their canvas drawn; the text layer is always present, so find counts every page.
const RENDER_MARGIN = '800px 0px';

type PdfPageProps = {
  pdfJs: PdfJs;
  page: PDFPageProxy;
  scale: number;
};

function PdfPage({ pdfJs, page, scale }: PdfPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const viewport = page.getViewport({ scale });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const observer = new IntersectionObserver(([entry]) => setIsNearViewport(entry.isIntersecting), { rootMargin: RENDER_MARGIN });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const textLayerElement = textLayerRef.current;
    if (!textLayerElement) return undefined;
    textLayerElement.replaceChildren();
    const textLayer = new pdfJs.TextLayer({ textContentSource: page.streamTextContent(), container: textLayerElement, viewport: page.getViewport({ scale }) });
    textLayer.render().catch((error: unknown) => {
      if (!(error instanceof Error && error.name === 'AbortException')) console.error('Failed to render PDF text layer:', error);
    });
    return () => textLayer.cancel();
  }, [page, pdfJs, scale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isNearViewport) return undefined;
    const pixelRatio = window.devicePixelRatio || 1;
    const renderViewport = page.getViewport({ scale: scale * pixelRatio });
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable for PDF rendering');
    const task = page.render({ canvasContext: context, viewport: renderViewport });
    task.promise.catch((error: unknown) => {
      if (!(error instanceof Error && error.name === 'RenderingCancelledException')) console.error('Failed to render PDF page:', error);
    });
    return () => task.cancel();
  }, [isNearViewport, page, scale]);

  return (
    <div
      ref={containerRef}
      className="pdf-page relative shrink-0 bg-white shadow-md"
      style={{ width: viewport.width, height: viewport.height, ['--scale-factor' as string]: scale }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div ref={textLayerRef} className="textLayer" />
    </div>
  );
}

type CodeEditorPdfViewProps = {
  url: string;
  title: string;
  errorLabel: string;
};

/**
 * Rendered by CodeEditorMediaPreview inside the code-editor module for PDF files. Draws the pages with pdf.js instead of
 * the browser's viewer, because that viewer is a closed plugin: the editor's find bar can only search a text layer it owns.
 */
export default function CodeEditorPdfView({ url, title, errorLabel }: CodeEditorPdfViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdfJs, setPdfJs] = useState<PdfJs | null>(null);
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const [error, setError] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let document: PDFDocumentProxy | null = null;
    setPages([]);
    setError(false);
    loadPdfJs()
      .then(async (loadedPdfJs) => {
        // pdf.js never evaluates code from the file with isEvalSupported off, so a PDF cannot run script in the app.
        document = await loadedPdfJs.getDocument({ url, isEvalSupported: false }).promise;
        const loadedPages = await Promise.all(Array.from({ length: document.numPages }, (_, index) => document!.getPage(index + 1)));
        if (cancelled) return;
        setPdfJs(loadedPdfJs);
        setPages(loadedPages);
      })
      .catch((loadError: unknown) => {
        console.error('Failed to load PDF:', loadError);
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      void document?.destroy();
    };
  }, [url]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setAvailableWidth(element.clientWidth - PAGE_GAP * 2));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Fit to width, in steps of 5% so a panel being dragged wider does not redraw every page on every pixel.
  const firstPageWidth = pages[0]?.getViewport({ scale: 1 }).width ?? 0;
  const scale = firstPageWidth > 0 && availableWidth > 0 ? Math.min(MAX_SCALE, Math.max(0.25, Math.floor((availableWidth / firstPageWidth) * 20) / 20)) : 0;

  return (
    <div ref={scrollRef} className="h-full w-full overflow-auto" role="document" aria-label={title}>
      {error && <p className="p-8 text-center text-sm text-muted-foreground">{errorLabel}</p>}
      {pdfJs && scale > 0 && (
        <div className="flex flex-col items-center" style={{ gap: PAGE_GAP, padding: PAGE_GAP }}>
          {pages.map((page) => <PdfPage key={page.pageNumber} pdfJs={pdfJs} page={page} scale={scale} />)}
        </div>
      )}
    </div>
  );
}
