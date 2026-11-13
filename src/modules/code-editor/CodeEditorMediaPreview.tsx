import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';

import { api } from '@/shared/api';
import { ZoomableImage } from '@/shared/ui';
import type { CodeEditorFile,PreviewKind } from '@/shared/types';
import { getPreviewMimeType } from '@/modules/code-editor/utils/previewableFile';
import CodeEditorPdfView from '@/modules/code-editor/CodeEditorPdfView';
import CodeEditorHeaderActions from '@/modules/code-editor/CodeEditorHeaderActions';
import { headerButtonClassName } from '@/modules/code-editor/utils/headerActionsSlot';

type CodeEditorMediaPreviewProps = {
  file: CodeEditorFile;
  kind: PreviewKind;
  // DB projectId used to build the raw-content URL; falls back to projectPath
  // for older callers, mirroring useCodeEditorDocument.
  projectId?: string;
  labels: {
    loading: string;
    error: string;
    openInNewTab: string;
  };
};

// Reject a "PDF" whose bytes aren't actually a PDF, so a mislabeled HTML/SVG file
// opened through the new-tab link can't run in the app origin.
const PDF_HEADER_SCAN_BYTES = 1024;

const looksLikePdf = async (blob: Blob): Promise<boolean> => {
  const header = await blob.slice(0, PDF_HEADER_SCAN_BYTES).arrayBuffer();
  // PDFs must contain the "%PDF-" marker at the very start of the file.
  return new TextDecoder('latin1').decode(header).includes('%PDF-');
};

/** Rendered by CodeEditor inside the code-editor module as the body that previews image, PDF, audio and video files instead of opening them as text. */
export default function CodeEditorMediaPreview({
  file,
  kind,
  projectId,
  labels,
}: CodeEditorMediaPreviewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Identifies which file the current `url` was loaded for. Rendering is gated on
  // this so a blob from a previously-opened file can never show under the new
  // file (the editor reuses this component instance across files).
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const sourceKey = `${projectId ?? ''}:${file.path}:${kind}`;

  useEffect(() => {
    if (!projectId) {
      setUrl(null);
      setLoadedKey(null);
      setError(labels.error);
      setLoading(false);
      return;
    }

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const loadMedia = async () => {
      try {
        setLoading(true);
        setError(null);
        setUrl(null);

        // The content endpoint requires the auth header, so we fetch the bytes
        // ourselves and hand the media element a blob URL instead of a bare src.
        // Fetching a blob (rather than streaming) also lets <video>/<audio> seek.
        const response = await api.readFileBlob(projectId, file.path, { signal: controller.signal });

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const blob = await response.blob();

        // Pick the MIME type to expose to the browser. Preserve a valid
        // Content-Type from the server, but supply an extension-specific
        // default when it is missing or generic (application/octet-stream),
        // otherwise formats like webm/ogg/flac/svg won't render.
        const fallbackMime = getPreviewMimeType(file.name);
        const isGenericType = !blob.type || blob.type === 'application/octet-stream';
        const isMislabeledVideo = kind === 'video' && Boolean(fallbackMime) && !blob.type.startsWith('video/');
        let outType = isGenericType || isMislabeledVideo ? (fallbackMime ?? blob.type) : blob.type;

        if (kind === 'pdf') {
          // The new-tab link opens this blob in the app's origin, so verify the
          // bytes are really a PDF and pin the type to application/pdf. That
          // forces the browser's PDF handler and prevents a mislabeled HTML/SVG
          // file from executing scripts there.
          if (!(await looksLikePdf(blob))) {
            throw new Error('File is not a valid PDF');
          }
          outType = 'application/pdf';
        }

        const typed = outType && outType !== blob.type ? new Blob([blob], { type: outType }) : blob;
        objectUrl = URL.createObjectURL(typed);

        // The cleanup may have already run (deps changed during an await), in
        // which case it revoked nothing because objectUrl was still null. Don't
        // publish a URL the cleanup will never revoke — drop it ourselves.
        if (controller.signal.aborted) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          return;
        }

        setUrl(objectUrl);
        setLoadedKey(sourceKey);
      } catch (loadError: unknown) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return;
        }
        console.error('Error loading preview:', loadError);
        setError(labels.error);
      } finally {
        setLoading(false);
      }
    };

    loadMedia();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [file.path, file.name, projectId, kind, sourceKey, labels.error]);

  // Only expose the blob once it matches the file currently being shown, so a
  // stale URL from the previous file is never rendered during a switch.
  const currentUrl = url && loadedKey === sourceKey ? url : null;

  // SVGs render safely inline via <img> (scripts don't execute there), but the
  // open-in-new-tab link is a top-level navigation. A blob URL inherits the
  // app's origin, so a user-controlled SVG with an embedded <script> would run
  // as same-origin script. Withhold the new-tab action for SVGs.
  const isSvg = getPreviewMimeType(file.name) === 'image/svg+xml';
  const canOpenInNewTab = Boolean(currentUrl) && !isSvg;

  const renderMedia = () => {
    if (!currentUrl) return null;
    switch (kind) {
      case 'image':
        return (
          <ZoomableImage src={currentUrl} alt={file.name} className="h-full w-full" />
        );
      case 'pdf':
        return <CodeEditorPdfView url={currentUrl} title={file.name} errorLabel={labels.error} />;
      case 'video':
        return (
          <video src={currentUrl} controls className="max-h-full max-w-full" autoPlay={false}>
            {labels.error}
          </video>
        );
      case 'audio':
        return (
          <div className="flex w-full max-w-xl flex-col items-center gap-4 px-6">
            <p className="max-w-full truncate text-sm text-muted-foreground">{file.name}</p>
            <audio src={currentUrl} controls className="w-full">
              {labels.error}
            </audio>
          </div>
        );
      default:
        return null;
    }
  };

  const previewBody = (
    <div className="relative flex min-h-0 w-full flex-1 flex-col items-center justify-center bg-muted/30 p-2">
      {loading && (
        <div className="text-sm text-muted-foreground">{labels.loading}</div>
      )}

      {!loading && currentUrl && renderMedia()}

      {!loading && !currentUrl && (
        <div className="flex flex-col items-center gap-3 p-8 text-center text-muted-foreground">
          <p className="text-sm">{error || labels.error}</p>
          <p className="break-all text-xs">{file.path}</p>
        </div>
      )}
    </div>
  );

  return (
    <>
      {canOpenInNewTab && currentUrl && (
        <CodeEditorHeaderActions>
          <a href={currentUrl} target="_blank" rel="noopener noreferrer" className={headerButtonClassName} aria-label={labels.openInNewTab} title={labels.openInNewTab}>
            <ExternalLink className="h-4 w-4" />
          </a>
        </CodeEditorHeaderActions>
      )}
      {previewBody}
    </>
  );
}
