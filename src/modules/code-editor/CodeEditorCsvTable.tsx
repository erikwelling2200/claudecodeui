import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, BetweenHorizontalEnd, BetweenVerticalEnd, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { copyTextToClipboard } from '@/shared/utils';
import {
  CSV_DELIMITERS,
  deleteColumn,
  deleteRow,
  detectDelimiter,
  getColumnCount,
  insertColumn,
  insertRow,
  parseCsv,
  serializeCsv,
  setCells,
} from '@/modules/code-editor/utils/csvDocument';
import type { CsvDocument } from '@/modules/code-editor/utils/csvDocument';

const ROW_HEIGHT = 28;
const OVERSCAN = 12;
const MIN_COLUMN_WIDTH = 64;
const MAX_COLUMN_WIDTH = 360;
const COLUMN_WIDTH_SAMPLE_ROWS = 500;
const UNDO_LIMIT = 200;

type CellPosition = { row: number; column: number };
type SortState = { column: number; direction: 'asc' | 'desc' };

const columnLetter = (index: number): string => {
  let letters = '';
  for (let remaining = index + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    letters = String.fromCharCode(65 + ((remaining - 1) % 26)) + letters;
  }
  return letters;
};

const displayText = (value: string): string => value.replace(/\r\n|\r|\n/g, ' ↵ ');

const compareCells = (left: string, right: string): number => {
  if (left === right) return 0;
  // Empty cells sort last in both directions' natural reading: they carry no value to order by.
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
};

type CodeEditorCsvTableProps = {
  content: string;
  onChange: (value: string) => void;
  fileName: string;
  fontSize: number;
  // The editor's layout buttons (pop out, expand), which CodeMirror's own toolbar shows in the text view.
  windowControls?: ReactNode;
};

/** Rendered by CodeEditorSurface inside the code-editor module as the spreadsheet view of a CSV/TSV file; edits write back into the text buffer. */
export default function CodeEditorCsvTable({ content, onChange, fileName, fontSize, windowControls = null }: CodeEditorCsvTableProps) {
  const { t } = useTranslation('codeEditor');

  // Detected once from the text; the user can override it when a file splits on the wrong character.
  const [delimiter, setDelimiter] = useState(() => detectDelimiter(content, fileName));
  // Whether row 0 is drawn as the sticky column header and kept out of filtering and sorting.
  const [hasHeader, setHasHeader] = useState(true);
  // The filter query; rows whose cells do not contain it are hidden from view, not removed from the file.
  const [filter, setFilter] = useState('');
  // The view's sort order; it never reorders the file.
  const [sort, setSort] = useState<SortState | null>(null);
  // The cell the keyboard acts on, by row index in the file (not on screen), so it survives sorting and filtering.
  const [selection, setSelection] = useState<CellPosition | null>(null);
  // The cell being typed into. Its text goes into the buffer live, so Ctrl+S mid-edit saves what is shown;
  // `startContent` is what Escape restores and what one undo step returns to.
  const [editing, setEditing] = useState<(CellPosition & { startContent: string }) | null>(null);
  // Scroll offset and viewport height, which decide the slice of rows that is actually rendered.
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Set and cleared together with `editing`, but synchronously: refocusing the table blurs the cell editor, whose blur
  // would otherwise finish the same edit a second time before the state update lands.
  const editingRef = useRef(false);
  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);

  const csv = useMemo(() => parseCsv(content, delimiter), [content, delimiter]);
  const columnCount = Math.max(getColumnCount(csv), 1);
  const headerRow = hasHeader && csv.rows.length > 0 ? 0 : null;

  const dataRows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    let indices: number[] = [];
    for (let index = headerRow === null ? 0 : 1; index < csv.rows.length; index++) {
      if (!query || csv.rows[index].cells.some((cell) => cell.toLowerCase().includes(query))) indices.push(index);
    }
    if (sort) {
      const direction = sort.direction === 'asc' ? 1 : -1;
      indices = indices.sort((left, right) => {
        const leftCell = csv.rows[left].cells[sort.column] ?? '';
        const rightCell = csv.rows[right].cells[sort.column] ?? '';
        if (!leftCell || !rightCell) return compareCells(leftCell, rightCell);
        return compareCells(leftCell, rightCell) * direction || left - right;
      });
    }
    return indices;
  }, [csv, filter, headerRow, sort]);

  // Row index in the file -> position on screen, for keyboard moves and scrolling a row into view.
  const dataRowPositions = useMemo(() => new Map(dataRows.map((row, position) => [row, position])), [dataRows]);

  const columnWidths = useMemo(() => {
    const characterWidth = fontSize * 0.6;
    const widths = Array.from({ length: columnCount }, (_, column) => columnLetter(column).length + 3);
    const sampled = csv.rows.slice(0, COLUMN_WIDTH_SAMPLE_ROWS);
    for (const row of sampled) {
      row.cells.forEach((cell, column) => {
        widths[column] = Math.max(widths[column], displayText(cell).length + (row === sampled[0] ? 3 : 0));
      });
    }
    return widths.map((characters) => Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, characters * characterWidth + 20)));
  }, [columnCount, csv.rows, fontSize]);
  const rowNumberWidth = Math.max(40, String(csv.rows.length).length * fontSize * 0.6 + 20);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const applyDocument = useCallback((next: CsvDocument, recordUndo = true) => {
    if (next === csv) return;
    if (recordUndo) {
      undoStackRef.current = [...undoStackRef.current.slice(-(UNDO_LIMIT - 1)), content];
      redoStackRef.current = [];
    }
    onChange(serializeCsv(next));
  }, [content, csv, onChange]);

  const focusTable = () => scrollRef.current?.focus({ preventScroll: true });

  const scrollRowIntoView = useCallback((row: number) => {
    const element = scrollRef.current;
    const position = dataRowPositions.get(row);
    if (!element || position === undefined) return;
    const top = position * ROW_HEIGHT;
    const visibleHeight = element.clientHeight - ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + visibleHeight) element.scrollTop = top + ROW_HEIGHT - visibleHeight;
  }, [dataRowPositions]);

  const moveSelection = useCallback((rowDelta: number, columnDelta: number) => {
    const navigableRows = headerRow === null ? dataRows : [headerRow, ...dataRows];
    if (navigableRows.length === 0) return;
    const current = selection ?? { row: navigableRows[0], column: 0 };
    const currentPosition = current.row === headerRow ? 0 : (dataRowPositions.get(current.row) ?? 0) + (headerRow === null ? 0 : 1);
    const position = Math.min(Math.max(currentPosition + rowDelta, 0), navigableRows.length - 1);
    const next = { row: navigableRows[position], column: Math.min(Math.max(current.column + columnDelta, 0), columnCount - 1) };
    setSelection(next);
    scrollRowIntoView(next.row);
  }, [columnCount, dataRowPositions, dataRows, headerRow, scrollRowIntoView, selection]);

  const startEditing = (cell: CellPosition, initialValue?: string) => {
    setSelection(cell);
    editingRef.current = true;
    setEditing({ ...cell, startContent: content });
    if (initialValue !== undefined) applyDocument(setCells(csv, cell.row, cell.column, [[initialValue]]), false);
  };

  const finishEditing = (rowDelta = 0, columnDelta = 0) => {
    if (!editing || !editingRef.current) return;
    editingRef.current = false;
    if (content !== editing.startContent) {
      undoStackRef.current = [...undoStackRef.current.slice(-(UNDO_LIMIT - 1)), editing.startContent];
      redoStackRef.current = [];
    }
    setEditing(null);
    if (rowDelta || columnDelta) moveSelection(rowDelta, columnDelta);
    focusTable();
  };

  const cancelEditing = () => {
    if (!editing || !editingRef.current) return;
    editingRef.current = false;
    if (content !== editing.startContent) onChange(editing.startContent);
    setEditing(null);
    focusTable();
  };

  const undo = (redo: boolean) => {
    const from = redo ? redoStackRef.current : undoStackRef.current;
    const previous = from.pop();
    if (previous === undefined) return;
    (redo ? undoStackRef.current : redoStackRef.current).push(content);
    onChange(previous);
  };

  const handleTableKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing || event.target !== event.currentTarget) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key;
    if (modifier && key.toLowerCase() === 'z') {
      event.preventDefault();
      undo(event.shiftKey);
      return;
    }
    if (modifier && key.toLowerCase() === 'y') {
      event.preventDefault();
      undo(true);
      return;
    }
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[key] && !modifier) {
      event.preventDefault();
      moveSelection(...moves[key]);
      return;
    }
    if (key === 'Tab') {
      event.preventDefault();
      moveSelection(0, event.shiftKey ? -1 : 1);
      return;
    }
    if (!selection) return;
    if (modifier && key.toLowerCase() === 'c') {
      event.preventDefault();
      void copyTextToClipboard(csv.rows[selection.row]?.cells[selection.column] ?? '');
      return;
    }
    if (key === 'Enter' || key === 'F2') {
      event.preventDefault();
      startEditing(selection);
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      applyDocument(setCells(csv, selection.row, selection.column, [['']]));
      return;
    }
    if (key.length === 1 && !modifier && !event.altKey) {
      event.preventDefault();
      startEditing(selection, key);
    }
  };

  // A block copied from a spreadsheet arrives tab-separated, one line per row; it fills the cells from the selection down and right.
  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !selection) return;
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const block = parseCsv(text, '\t').rows.map((row) => row.cells);
    applyDocument(setCells(csv, selection.row, selection.column, block));
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // Escape ends the edit only; it must not reach the editor's close shortcut.
      event.stopPropagation();
      event.preventDefault();
      cancelEditing();
    } else if (event.key === 'Enter' && event.altKey) {
      // Alt+Enter is a line break inside the cell, as in Excel; Shift+Enter already is one in a textarea.
      event.preventDefault();
      const target = event.currentTarget;
      const value = `${target.value.slice(0, target.selectionStart)}\n${target.value.slice(target.selectionEnd)}`;
      const caret = target.selectionStart + 1;
      applyDocument(setCells(csv, editing!.row, editing!.column, [[value]]), false);
      requestAnimationFrame(() => target.setSelectionRange(caret, caret));
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      finishEditing(1, 0);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      finishEditing(0, event.shiftKey ? -1 : 1);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      // The csv-level save shortcut still has to see this key; the cell's text is already in the buffer.
      finishEditing();
    }
  };

  const toggleSort = (column: number) => {
    setSort((current) => {
      if (current?.column !== column) return { column, direction: 'asc' };
      return current.direction === 'asc' ? { column, direction: 'desc' } : null;
    });
  };

  const selectedRowIsHeader = selection !== null && selection.row === headerRow;
  const runStructureEdit = (next: CsvDocument, nextSelection: CellPosition | null) => {
    applyDocument(next);
    setSelection(nextSelection);
    focusTable();
  };

  const firstRendered = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastRendered = Math.min(dataRows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const tableWidth = rowNumberWidth + columnWidths.reduce((sum, width) => sum + width, 0);

  const renderCell = (row: number, column: number, isHeader: boolean) => {
    const value = csv.rows[row]?.cells[column] ?? '';
    const isSelected = selection?.row === row && selection.column === column;
    const isEditing = editing?.row === row && editing.column === column;
    const Tag = isHeader ? 'th' : 'td';
    return (
      <Tag
        key={column}
        onMouseDown={(event) => {
          if (isEditing) return;
          // Refocusing the table blurs an open cell editor, which finishes that edit.
          event.preventDefault();
          setSelection({ row, column });
          focusTable();
        }}
        onDoubleClick={() => startEditing({ row, column })}
        className={`relative overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-border px-2 text-left ${
          isHeader ? 'font-semibold' : 'font-normal'
        } ${isSelected ? 'outline outline-2 -outline-offset-2 outline-blue-500' : ''}`}
        title={value.length > 40 ? value : undefined}
      >
        {isEditing ? (
          <textarea
            autoFocus
            value={value}
            onChange={(event) => applyDocument(setCells(csv, row, column, [[event.target.value]]), false)}
            onKeyDown={handleEditorKeyDown}
            onBlur={() => finishEditing()}
            onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
            rows={1}
            spellCheck={false}
            className="absolute inset-0 z-10 resize-none border-0 bg-background px-2 py-1 font-normal outline outline-2 -outline-offset-2 outline-blue-500"
            style={{ minHeight: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT - 8}px` }}
          />
        ) : displayText(value)}
        {isHeader && headerRow !== null && renderSortButton(column)}
      </Tag>
    );
  };

  const renderSortButton = (column: number) => {
    const isSorted = sort?.column === column;
    const Icon = !isSorted ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => toggleSort(column)}
        className={`absolute right-1 top-1/2 -translate-y-1/2 rounded bg-muted p-0.5 ${
          isSorted ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 opacity-0 hover:text-gray-700 group-hover:opacity-100 dark:hover:text-gray-200'
        }`}
        title={t('csv.sort', 'Sort')}
      >
        <Icon className="h-3 w-3" />
      </button>
    );
  };

  const toolbarButton = 'flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white';

  return (
    <div className="flex h-full flex-col bg-background text-foreground" style={{ fontSize }}>
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1 text-xs">
        <div className="flex min-w-40 flex-1 items-center gap-1 rounded-md border border-border px-2 py-0.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('csv.filter', 'Filter')}
            className="w-full bg-transparent py-0.5 outline-none"
          />
        </div>
        <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">
          {filter.trim()
            ? t('csv.filteredRows', '{{shown}} of {{count}} rows', { shown: dataRows.length, count: csv.rows.length - (headerRow === null ? 0 : 1) })
            : t('csv.rows', '{{count}} rows', { count: dataRows.length })}
          {' · '}
          {t('csv.columns', '{{count}} columns', { count: columnCount })}
        </span>
        <label className="flex items-center gap-1 whitespace-nowrap text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={hasHeader} onChange={(event) => setHasHeader(event.target.checked)} />
          {t('csv.headerRow', 'Header row')}
        </label>
        <select
          value={delimiter}
          onChange={(event) => setDelimiter(event.target.value)}
          className="rounded-md border border-border bg-background px-1 py-0.5"
          title={t('csv.delimiter', 'Delimiter')}
        >
          {CSV_DELIMITERS.map((candidate) => (
            <option key={candidate} value={candidate}>{candidate === '\t' ? 'Tab' : candidate}</option>
          ))}
        </select>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className={toolbarButton}
            onClick={() => {
              const at = selection && !selectedRowIsHeader ? selection.row + 1 : csv.rows.length;
              runStructureEdit(insertRow(csv, at), { row: at, column: selection?.column ?? 0 });
              requestAnimationFrame(() => scrollRowIntoView(at));
            }}
            title={t('csv.insertRow', 'Insert row below')}
          >
            <BetweenHorizontalEnd className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={toolbarButton}
            disabled={!selection || selectedRowIsHeader}
            onClick={() => selection && runStructureEdit(deleteRow(csv, selection.row), null)}
            title={t('csv.deleteRow', 'Delete row')}
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <span className="mx-1 h-4 w-px bg-border" />
          <button
            type="button"
            className={toolbarButton}
            onClick={() => {
              const at = selection ? selection.column + 1 : columnCount;
              runStructureEdit(insertColumn(csv, at), selection ? { row: selection.row, column: at } : null);
            }}
            title={t('csv.insertColumn', 'Insert column right')}
          >
            <BetweenVerticalEnd className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={toolbarButton}
            disabled={!selection}
            onClick={() => selection && runStructureEdit(deleteColumn(csv, selection.column), null)}
            title={t('csv.deleteColumn', 'Delete column')}
          >
            <Trash2 className="h-4 w-4 rotate-90" />
          </button>
        </div>
        {windowControls && <div className="ml-auto flex items-center gap-0.5">{windowControls}</div>}
      </div>

      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={handleTableKeyDown}
        onPaste={handlePaste}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-auto outline-none"
        data-testid="csv-table"
      >
        <table className="border-separate border-spacing-0" style={{ tableLayout: 'fixed', width: tableWidth }}>
          <colgroup>
            <col style={{ width: rowNumberWidth }} />
            {columnWidths.map((width, column) => <col key={column} style={{ width }} />)}
          </colgroup>
          <thead className="sticky top-0 z-20 bg-muted">
            <tr className="group" style={{ height: ROW_HEIGHT }}>
              <th className="sticky left-0 z-30 border-b border-r border-border bg-muted px-2 text-right text-xs font-normal text-gray-400">
                {headerRow === null ? '' : 1}
              </th>
              {Array.from({ length: columnCount }, (_, column) => (
                headerRow === null ? (
                  <th key={column} className="relative border-b border-r border-border px-2 text-left text-xs font-normal text-gray-500">
                    {columnLetter(column)}
                    {renderSortButton(column)}
                  </th>
                ) : renderCell(headerRow, column, true)
              ))}
            </tr>
          </thead>
          <tbody>
            {firstRendered > 0 && <tr style={{ height: firstRendered * ROW_HEIGHT }} />}
            {dataRows.slice(firstRendered, lastRendered).map((row) => (
              <tr key={row} style={{ height: ROW_HEIGHT }}>
                <td className="sticky left-0 z-10 border-b border-r border-border bg-muted px-2 text-right text-xs text-gray-400">
                  {row + 1}
                </td>
                {Array.from({ length: columnCount }, (_, column) => renderCell(row, column, false))}
              </tr>
            ))}
            {lastRendered < dataRows.length && <tr style={{ height: (dataRows.length - lastRendered) * ROW_HEIGHT }} />}
          </tbody>
        </table>
      </div>
    </div>
  );
}
