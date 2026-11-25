export type CommandResult = {
  exitCode: number | null;
  output: string;
};

type ServerUpdateDependencies = {
  // Runs one program without a shell, in the checkout the server runs from, and resolves with its combined stdout and stderr.
  runCommand(program: string, args: string[]): Promise<CommandResult>;
  // The commit the served frontend (dist/) was built from, or null when there is no build or it carries no stamp.
  readClientBuildCommit(): string | null;
  logInfo(message: string): void;
};

export type ServerUpdateStep = 'fetch' | 'merge' | 'install' | 'build';

export type ServerUpdateResult =
  | { success: true; previousHead: string; head: string; commits: number; installed: boolean; built: boolean }
  | { success: false; step: ServerUpdateStep | 'branch'; error: string };

// The frontend that /dist serves is built from these; a change anywhere else needs no client build.
const CLIENT_BUILD_INPUT = /^(src\/|public\/|index\.html$|vite\.config\.|tailwind\.config\.|postcss\.config\.|tsconfig\.json$)/;
const DEPENDENCY_MANIFEST = /^(package\.json|package-lock\.json)$/;

class StepFailure extends Error {
  constructor(readonly step: ServerUpdateStep | 'branch', message: string) {
    super(message);
  }
}

/** True when a changed path is an input of the client build. Exported for the tests. */
export function needsClientBuild(changedPath: string): boolean {
  return CLIENT_BUILD_INPUT.test(changedPath);
}

/**
 * Creates the "Update" workflow behind POST /api/system/update-and-restart: fast-forwards the checkout's current
 * branch to its upstream, reinstalls dependencies when the manifest changed and rebuilds the client when its sources
 * changed since dist/ was built. The restart itself is left to the caller, so a failed step never takes the server down.
 */
export function createServerUpdateService(dependencies: ServerUpdateDependencies) {
  // Guards against a second request while the first update is still running.
  let updateRunning = false;

  async function run(step: ServerUpdateStep | 'branch', program: string, args: string[]): Promise<string> {
    dependencies.logInfo(`Update: ${program} ${args.join(' ')}`);
    const result = await dependencies.runCommand(program, args);
    if (result.exitCode !== 0) throw new StepFailure(step, result.output.trim() || `${program} exited with code ${result.exitCode}`);
    return result.output.trim();
  }

  // Compares against the commit dist/ was built from rather than the pre-update HEAD, so a pull made by hand still rebuilds.
  async function isClientBuildStale(head: string): Promise<boolean> {
    const builtFrom = dependencies.readClientBuildCommit();
    if (!builtFrom) return true;
    if (builtFrom === head) return false;
    const diff = await dependencies.runCommand('git', ['diff', '--name-only', builtFrom, head]);
    if (diff.exitCode !== 0) return true;
    return diff.output.split('\n').filter(Boolean).some(needsClientBuild);
  }

  async function update(): Promise<ServerUpdateResult> {
    const upstream = await dependencies.runCommand('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (upstream.exitCode !== 0) {
      const branch = await run('branch', 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
      throw new StepFailure('branch', `Branch ${branch} has no upstream to update from.`);
    }

    await run('fetch', 'git', ['fetch', '--quiet']);
    const previousHead = await run('merge', 'git', ['rev-parse', 'HEAD']);
    await run('merge', 'git', ['merge', '--ff-only', '@{u}']);
    const head = await run('merge', 'git', ['rev-parse', 'HEAD']);

    const changedPaths = previousHead === head
      ? []
      : (await run('merge', 'git', ['diff', '--name-only', previousHead, head])).split('\n').filter(Boolean);
    const commits = previousHead === head
      ? 0
      : Number.parseInt(await run('merge', 'git', ['rev-list', '--count', `${previousHead}..${head}`]), 10);

    const installed = changedPaths.some((changedPath) => DEPENDENCY_MANIFEST.test(changedPath));
    if (installed) await run('install', 'npm', ['install']);

    const built = installed || await isClientBuildStale(head);
    if (built) await run('build', 'npm', ['run', 'build:client']);

    return { success: true, previousHead, head, commits, installed, built };
  }

  return {
    /** Runs the update; resolves with what changed, or with the step that failed and its output. */
    async update(): Promise<ServerUpdateResult> {
      if (updateRunning) return { success: false, step: 'fetch', error: 'An update is already running.' };
      updateRunning = true;
      try {
        return await update();
      } catch (error) {
        if (error instanceof StepFailure) return { success: false, step: error.step, error: error.message };
        throw error;
      } finally {
        updateRunning = false;
      }
    },
  };
}
