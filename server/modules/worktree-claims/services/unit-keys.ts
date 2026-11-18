import { AppError } from '@/shared/utils.js';

/** `group:<name>` / `repo:<path>`, as lock files and claims key a unit; it survives renaming the group. */
export function readUnitKey(unitKey: unknown): string {
  if (typeof unitKey !== 'string' || !/^(group|repo):.+$/.test(unitKey)) {
    throw new AppError(`"${String(unitKey)}" is not a worktree unit key`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return unitKey;
}

/** A worktree suffix, the `<x>` of `<repo>-<x>`; '' names the main checkout. */
export function readSuffix(value: unknown, name: string): string {
  const suffix = typeof value === 'string' ? value.trim() : null;
  if (suffix === null || (suffix !== '' && !/^[\w.-]+$/.test(suffix))) {
    throw new AppError(`${name} must be a worktree suffix of letters, digits, ".", "_" or "-"`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return suffix;
}
