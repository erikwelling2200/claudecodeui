import assert from 'node:assert/strict';

import { test } from 'vitest';

import { findSkillByReference } from '@/modules/skills/hooks/useSkillReferenceOpener';
import type { ProviderSkill } from '@/shared/types';

const skill = (command: string, name: string): ProviderSkill => ({
  provider: 'claude',
  name,
  description: '',
  command,
  scope: 'user',
  sourcePath: `/skills/${name}/SKILL.md`,
});

const SKILLS = [skill('/find-worktree', 'find-worktree'), skill('/changefied:planner', 'planner')];

test('a reference matches a skill by command or name, ignoring the slash and surrounding punctuation', () => {
  assert.equal(findSkillByReference(SKILLS, '/find-worktree')?.name, 'find-worktree');
  assert.equal(findSkillByReference(SKILLS, '`find-worktree`.')?.name, 'find-worktree');
  assert.equal(findSkillByReference(SKILLS, '/changefied:planner')?.name, 'planner');
  assert.equal(findSkillByReference(SKILLS, 'planner')?.name, 'planner');
  assert.equal(findSkillByReference(SKILLS, 'worktree'), null);
  assert.equal(findSkillByReference(SKILLS, '/'), null);
});
