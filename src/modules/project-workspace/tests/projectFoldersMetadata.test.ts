import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project } from '@/shared/types';
import { mergeProjectSelectionMetadata } from '@/modules/project-workspace/utils/projectSelectionMetadata';
import { getProjectFolderPaths } from '@/shared/utils';

/**
 * A project's extra folders arrive on the full project list only; the
 * `session_upserted` broadcast leaves them out. A realtime upsert must
 * therefore never wipe them from the selected project.
 */

const selectedProject: Project = {
  projectId: 'project-1',
  displayName: 'Operatie-OV',
  fullPath: '/workspace/Operatie-OV',
  path: '/workspace/Operatie-OV',
  isStarred: false,
  additionalFolders: ['/workspace/ChangefiedPackages'],
};

test('a realtime snapshot without additionalFolders keeps the current folders', () => {
  const result = mergeProjectSelectionMetadata(selectedProject, {
    projectId: selectedProject.projectId,
    displayName: selectedProject.displayName,
    fullPath: selectedProject.fullPath,
    path: selectedProject.path,
    isStarred: selectedProject.isStarred,
  });

  assert.equal(result, selectedProject);
  assert.deepEqual(result.additionalFolders, ['/workspace/ChangefiedPackages']);
});

test('a project list refresh replaces the folders, including clearing them', () => {
  const added = mergeProjectSelectionMetadata(selectedProject, {
    ...selectedProject,
    additionalFolders: ['/workspace/ChangefiedPackages', '/workspace/OV-Reizen-Companion'],
  });
  assert.deepEqual(added.additionalFolders, ['/workspace/ChangefiedPackages', '/workspace/OV-Reizen-Companion']);

  const cleared = mergeProjectSelectionMetadata(added, { ...added, additionalFolders: [] });
  assert.deepEqual(cleared.additionalFolders, []);
});

test('getProjectFolderPaths lists the primary first and skips a repeated primary', () => {
  assert.deepEqual(getProjectFolderPaths(selectedProject), [
    '/workspace/Operatie-OV',
    '/workspace/ChangefiedPackages',
  ]);
  assert.deepEqual(
    getProjectFolderPaths({ ...selectedProject, additionalFolders: ['/workspace/Operatie-OV'] }),
    ['/workspace/Operatie-OV'],
  );
  assert.deepEqual(getProjectFolderPaths({ ...selectedProject, additionalFolders: undefined }), [
    '/workspace/Operatie-OV',
  ]);
});
