type CodeEditorBinaryFileProps = {
  title: string;
  message: string;
};

/** Rendered by CodeEditor inside the code-editor module as the body for a binary file that cannot be edited as text. */
export default function CodeEditorBinaryFile({ title, message }: CodeEditorBinaryFileProps) {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center bg-background p-8 text-muted-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <svg className="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <div>
          <h3 className="mb-2 text-lg font-medium text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
      </div>
    </div>
  );
}
