import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useSkillReferenceClick } from '@/modules/chat/hooks/useSkillReferenceClick';

const openSkillReference = vi.fn((reference: string) => reference === '/changefied:planner');
vi.mock('@/modules/skills', () => ({ useSkillReferenceOpener: () => openSkillReference }));

test('ctrl+click on a skill in the transcript opens it and swallows the click', () => {
  const rowClick = vi.fn();

  function Transcript() {
    const onClickCapture = useSkillReferenceClick('claude', null);
    return (
      <div onClickCapture={onClickCapture}>
        <button type="button" onClick={rowClick}><code>/changefied:planner</code></button>
        <button type="button" onClick={rowClick}><code>npm test</code></button>
      </div>
    );
  }

  const view = render(<Transcript />);
  const [skillCode, otherCode] = Array.from(view.container.querySelectorAll('code'));

  fireEvent.click(skillCode);
  assert.equal(openSkillReference.mock.calls.length, 0, 'a plain click is left alone');
  assert.equal(rowClick.mock.calls.length, 1);

  fireEvent.click(skillCode, { ctrlKey: true });
  assert.equal(openSkillReference.mock.results.at(-1)?.value, true);
  assert.equal(rowClick.mock.calls.length, 1, 'the row does not also toggle');

  fireEvent.click(otherCode, { ctrlKey: true });
  assert.equal(rowClick.mock.calls.length, 2, 'a ctrl+click that names no skill passes through');
});
