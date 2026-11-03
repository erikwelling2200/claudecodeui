import assert from 'node:assert/strict';

import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { test } from 'vitest';

import { ExpandThinkingContext } from '@/modules/chat/context/ExpandThinkingContext';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/modules/chat/transcript/Reasoning';

const renderSections = (expandAll: boolean) => (
  <ExpandThinkingContext.Provider value={expandAll}>
    <Reasoning defaultOpen={false}><ReasoningTrigger /><ReasoningContent>first</ReasoningContent></Reasoning>
    <Reasoning><ReasoningTrigger /><ReasoningContent>second</ReasoningContent></Reasoning>
  </ExpandThinkingContext.Provider>
);

const openCount = (container: HTMLElement) => container.querySelectorAll('button[data-state="open"]').length;

test('expand-all opens every thinking section on mount, even one that defaults closed', () => {
  const { container } = render(renderSections(true));
  assert.equal(openCount(container), 2);
});

test('flipping expand-all opens and closes every section, and each can still be toggled by hand', () => {
  const view = render(renderSections(false));
  assert.equal(openCount(view.container), 0);

  view.rerender(renderSections(true));
  assert.equal(openCount(view.container), 2);

  fireEvent.click(view.container.querySelectorAll('button')[0]);
  assert.equal(openCount(view.container), 1, 'one closed by hand');

  view.rerender(renderSections(false));
  assert.equal(openCount(view.container), 0);
});
