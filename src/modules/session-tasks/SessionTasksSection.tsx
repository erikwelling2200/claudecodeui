import { Check, CircleDashed, Loader2, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SessionTask, SessionTaskStatus } from '@/shared/types';

const STATUS_ICON: Record<SessionTaskStatus, typeof Check> = {
  pending: CircleDashed,
  in_progress: Loader2,
  completed: Check,
};

const STATUS_CLASS: Record<SessionTaskStatus, string> = {
  pending: 'text-muted-foreground',
  in_progress: 'text-primary',
  completed: 'text-muted-foreground line-through',
};

/** The chat's task list, rendered in the sidebar beside its worktree claims. */
export function SessionTasksSection({ tasks }: { tasks: SessionTask[] }) {
  const { t } = useTranslation();
  const open = tasks.filter((task) => task.status !== 'completed').length;

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('sessionTasks.title')}
        {open > 0 && <span className="ml-1 font-normal normal-case">{t('sessionTasks.open', { count: open })}</span>}
      </h2>
      <ul className="mt-2 space-y-1">
        {tasks.map((task) => {
          const Icon = STATUS_ICON[task.status];
          const label = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject;
          return (
            <li key={task.id} className="flex items-start gap-2 text-xs" title={task.description || task.subject}>
              <Icon className={`mt-0.5 h-3 w-3 flex-shrink-0 ${task.status === 'in_progress' ? 'animate-spin' : ''} ${STATUS_CLASS[task.status]}`} />
              <span className={`min-w-0 flex-1 ${STATUS_CLASS[task.status]}`}>
                {label}
                {task.blockedBy.length > 0 && (
                  <span className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground" title={t('sessionTasks.blockedBy', { ids: task.blockedBy.join(', ') })}>
                    <Lock className="h-3 w-3" />
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
