import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '@/modules/command-palette';
import { useProviderSkills } from '@/modules/skills/hooks/useProviderSkills';
import { useSelectedProvider } from '@/shared/hooks/useSelectedProvider';
import { Input, Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { Project, ProviderSkill, SkillsScope } from '@/shared/types';

type SidebarSkillsListProps = {
  selectedProject: Project | null;
  searchQuery: string;
};

const SCOPE_ORDER: SkillsScope[] = ['user', 'project', 'repo', 'plugin', 'admin', 'system'];

// The folder name a new skill gets, which is also the name it is invoked by.
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

const getSkillDirectoryName = (skill: ProviderSkill): string =>
  skill.sourcePath.replace(/\\/g, '/').split('/').slice(-2, -1)[0] ?? '';

const buildSkillTemplate = (name: string): string => [
  '---',
  `name: ${name}`,
  'description: Describe what this skill does and when to use it.',
  '---',
  '',
  `# ${name}`,
  '',
].join('\n');

/**
 * Used by the sidebar module as the body of its Skills tab: lists the selected provider's skills for the open
 * project, opens one in the code editor on click, creates a new user skill and deletes user skills.
 */
export default function SidebarSkillsList({ selectedProject, searchQuery }: SidebarSkillsListProps) {
  const { t } = useTranslation('sidebar');
  const provider = useSelectedProvider();
  const { openFileInEditor } = usePaletteOps();
  const currentProjects = useMemo(() => (selectedProject ? [selectedProject] : []), [selectedProject]);
  const { skills, isLoading, loadError, addSkills, removeSkill, refreshSkills } = useProviderSkills({
    selectedProvider: provider,
    currentProjects,
  });
  // The name typed into the new-skill row; null while that row is closed.
  const [newSkillName, setNewSkillName] = useState<string | null>(null);
  // The last create or delete failure, shown above the list until the next action.
  const [actionError, setActionError] = useState<string | null>(null);
  // The source path of the skill being created or deleted, so its row shows a spinner and repeat clicks are ignored.
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const groupedSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const visible = query
      ? skills.filter((skill) => [skill.command, skill.name, skill.description, skill.pluginName]
        .some((value) => value?.toLowerCase().includes(query)))
      : skills;
    return SCOPE_ORDER
      .map((scope) => ({ scope, skills: visible.filter((skill) => skill.scope === scope) }))
      .filter((group) => group.skills.length > 0);
  }, [searchQuery, skills]);

  const createSkill = async (event: FormEvent) => {
    event.preventDefault();
    const name = (newSkillName ?? '').trim();
    if (!SKILL_NAME_PATTERN.test(name)) {
      setActionError(t('skills.invalidName'));
      return;
    }
    // Saving a skill replaces its whole folder, so an existing one must never be "created" over.
    if (skills.some((skill) => skill.managed && getSkillDirectoryName(skill).toLowerCase() === name.toLowerCase())) {
      setActionError(t('skills.nameTaken', { name }));
      return;
    }

    setBusyPath(name);
    setActionError(null);
    try {
      const [created] = await addSkills({ entries: [{ content: buildSkillTemplate(name), directoryName: name }] });
      setNewSkillName(null);
      if (created) openFileInEditor(created.sourcePath);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPath(null);
    }
  };

  const deleteSkill = async (skill: ProviderSkill) => {
    if (!window.confirm(t('skills.confirmRemove', { name: skill.command }))) return;
    setBusyPath(skill.sourcePath);
    setActionError(null);
    try {
      await removeSkill(skill);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <div className="space-y-3 px-2 pb-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            setNewSkillName((current) => (current === null ? '' : null));
            setActionError(null);
          }}
          className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('skills.new')}
        </button>
        <Tooltip content={t('skills.refresh')} position="top">
          <button
            type="button"
            aria-label={t('skills.refresh')}
            onClick={() => void refreshSkills({ force: true })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </button>
        </Tooltip>
      </div>

      {newSkillName !== null && (
        <form onSubmit={(event) => void createSkill(event)} className="px-1">
          <Input
            autoFocus
            value={newSkillName}
            disabled={busyPath !== null}
            placeholder={t('skills.namePlaceholder')}
            aria-label={t('skills.namePlaceholder')}
            onChange={(event) => setNewSkillName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setNewSkillName(null);
            }}
            className="h-8 font-mono text-xs"
          />
        </form>
      )}

      {(actionError || loadError) && (
        <div className="mx-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
          {actionError || loadError}
        </div>
      )}

      {isLoading && skills.length === 0 && (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}

      {!isLoading && groupedSkills.length === 0 && (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          <Sparkles className="mx-auto mb-2 h-5 w-5" />
          {skills.length === 0 ? t('skills.empty') : t('skills.noMatch')}
        </div>
      )}

      {groupedSkills.map((group) => (
        <section key={group.scope} className="space-y-0.5">
          <div className="flex items-center justify-between px-2 py-0.5">
            <h3 className="text-[11px] font-medium text-muted-foreground">{t(`skills.scopes.${group.scope}`)}</h3>
            <span className="text-[10px] tabular-nums text-muted-foreground/70">{group.skills.length}</span>
          </div>

          {group.skills.map((skill) => (
            <div
              key={`${skill.command}:${skill.sourcePath}`}
              className="group flex min-w-0 items-center rounded-lg transition-colors hover:bg-accent/60"
            >
              <button
                type="button"
                title={skill.sourcePath}
                onClick={() => openFileInEditor(skill.sourcePath)}
                className="min-w-0 flex-1 px-2 py-1.5 text-left"
              >
                <div className="truncate font-mono text-xs text-foreground">{skill.command}</div>
                {skill.description && (
                  <div className="truncate text-[11px] text-muted-foreground">{skill.description}</div>
                )}
              </button>
              {skill.managed && (
                <button
                  type="button"
                  aria-label={t('skills.remove', { name: skill.command })}
                  title={t('skills.remove', { name: skill.command })}
                  disabled={busyPath !== null}
                  onClick={() => void deleteSkill(skill)}
                  className={cn(
                    'mr-1 flex-none rounded-md p-1.5 text-muted-foreground transition-opacity hover:bg-red-500/10 hover:text-red-600',
                    busyPath === skill.sourcePath ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100',
                  )}
                >
                  {busyPath === skill.sourcePath
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
