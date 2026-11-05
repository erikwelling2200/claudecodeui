import assert from 'node:assert/strict';
import test from 'node:test';

import { compareVersions } from '@/modules/csharp-language/roslyn-installer.js';

test('orders server package versions numerically, prerelease parts included', () => {
  const versions = ['4.8.0-7.26453.6', '5.4.0-2.26179.14', '5.4.0-2.26080.13', '5.10.0-1.1'];

  assert.deepEqual([...versions].sort(compareVersions), ['4.8.0-7.26453.6', '5.4.0-2.26080.13', '5.4.0-2.26179.14', '5.10.0-1.1']);
});
