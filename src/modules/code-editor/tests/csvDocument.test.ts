import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  deleteColumn,
  deleteRow,
  detectDelimiter,
  insertColumn,
  insertRow,
  parseCsv,
  serializeCsv,
  setCells,
} from '@/modules/code-editor/utils/csvDocument';

test('quoted fields keep delimiters, quotes and line breaks', () => {
  const csv = parseCsv('name,quote\r\n"Doe, J","said ""hi""\nthen left"\r\n', ',');
  assert.deepEqual(csv.rows.map((row) => row.cells), [['name', 'quote'], ['Doe, J', 'said "hi"\nthen left']]);
  assert.equal(csv.newline, '\r\n');
});

test('an untouched file serializes back byte for byte', () => {
  const samples = ['a,b\n1,2\n', 'a,b\r\n"1",  2 \r\n', 'x;y\n\n3;4', '', 'only\n', '"open quote\n'];
  for (const text of samples) assert.equal(serializeCsv(parseCsv(text, text.includes(';') ? ';' : ',')), text);
});

test('editing one cell rewrites only that row', () => {
  const text = '"a",b\r\n"1",2\r\n"3",4\r\n';
  const edited = serializeCsv(setCells(parseCsv(text, ','), 1, 1, [['two, quoted']]));
  assert.equal(edited, '"a",b\r\n1,"two, quoted"\r\n"3",4\r\n');
});

test('setting a cell to its current value returns the same document', () => {
  const csv = parseCsv('a,b\n', ',');
  assert.equal(setCells(csv, 0, 0, [['a']]), csv);
});

test('rows and columns are inserted and removed without losing the final newline state', () => {
  const noTrailing = parseCsv('a,b\n1,2', ',');
  assert.equal(serializeCsv(insertRow(noTrailing, 2)), 'a,b\n1,2\n');
  assert.equal(serializeCsv(deleteRow(parseCsv('a\nb\n', ','), 1)), 'a\n');
  assert.equal(serializeCsv(deleteRow(parseCsv('a\nb', ','), 1)), 'a');
  assert.equal(serializeCsv(insertColumn(parseCsv('a,b\n\n1,2\n', ','), 1)), 'a,,b\n\n1,,2\n');
  assert.equal(serializeCsv(deleteColumn(parseCsv('a,b\n1,2\n', ','), 0)), 'b\n2\n');
});

test('pasting a block past the end adds rows', () => {
  const csv = setCells(parseCsv('a,b\n', ','), 1, 0, [['1', '2'], ['3', '4']]);
  assert.equal(serializeCsv(csv), 'a,b\n1,2\n3,4\n');
});

test('the delimiter is detected from the content or the extension', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.equal(detectDelimiter('a,b\n"x;y",2\n'), ',');
  assert.equal(detectDelimiter('a,b\n', 'data.tsv'), '\t');
  assert.equal(detectDelimiter('single column\n'), ',');
});
