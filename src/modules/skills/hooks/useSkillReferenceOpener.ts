import { useCallback, useMemo } from 'react';

import { usePaletteOps } from '@/modules/command-palette';
import { useProviderSkills } from '@/modules/skills/hooks/useProviderSkills';
import type { Project, ProviderSkill, SkillsProvider } from '@/shared/types';

// Quotes, brackets and sentence punctuation around a skill name in prose, plus the `/` or `$` that invokes it.
const REFERENCE_EDGE_PATTERN = /^[/$`'"([]+|[`'"),.;:!?\]]+$/g;

/**
 * The skill a piece of chat text names, or null. A full command (`/plugin:skill`, `$skill`) wins over a bare
 * name; `skills` is ordered user scope first, so a bare name shared by several scopes picks the user's own.
 */
export const findSkillByReference = (skills: ProviderSkill[], reference: string): ProviderSkill | null => {
  const token = reference.trim().replace(REFERENCE_EDGE_PATTERN, '').toLowerCase();
  if (!token) return null;

  return skills.find((skill) => skill.command.replace(/^[/$]/, '').toLowerCase() === token)
    ?? skills.find((skill) => skill.name.toLowerCase() === token)
    ?? null;
};

/**
 * Used by the chat module to open a skill named in the transcript in the editor. Returns a function that opens
 * the skill `reference` names and reports whether it found one, so the caller only swallows clicks that hit.
 */
export function useSkillReferenceOpener(provider: SkillsProvider, project: Project | null) {
  const { openFileInEditor } = usePaletteOps();
  const currentProjects = useMemo(() => (project ? [project] : []), [project]);
  const { skills } = useProviderSkills({ selectedProvider: provider, currentProjects });

  return useCallback((reference: string): boolean => {
    const skill = findSkillByReference(skills, reference);
    if (!skill) return false;
    openFileInEditor(skill.sourcePath);
    return true;
  }, [openFileInEditor, skills]);
}
