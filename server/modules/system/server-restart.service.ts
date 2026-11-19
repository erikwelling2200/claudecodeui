type ServerRestartDependencies = {
  // True when a supervisor (the autostart loop) starts the server again after it exits, so exiting is the whole restart.
  isSupervised: boolean;
  // Starts a detached copy of this server that takes the port over once this process has released it.
  spawnReplacement(): void;
  // The server's graceful shutdown; it ends the process.
  shutdown(): Promise<void>;
  logInfo(message: string): void;
};

/**
 * Creates the restart workflow behind POST /api/system/restart. Used by the system module and its tests.
 * Without a supervisor the replacement is spawned before the shutdown, so the port changes hands without a gap
 * in which nothing could be started.
 */
export function createServerRestartService(dependencies: ServerRestartDependencies) {
  // Guards against a second request while the first restart is already shutting the process down.
  let restartStarted = false;

  return {
    /** What the UI may expect from a restart, so it can say where the server comes back from. */
    describe() {
      return { supervised: dependencies.isSupervised };
    },

    /** Begins the restart. Resolves once the shutdown has been handed off; the response must already be sent. */
    async restart() {
      if (restartStarted) return;
      restartStarted = true;

      if (dependencies.isSupervised) {
        dependencies.logInfo('Restart requested: exiting so the supervisor starts the server again.');
      } else {
        dependencies.logInfo('Restart requested: starting a replacement server, then shutting down.');
        dependencies.spawnReplacement();
      }
      await dependencies.shutdown();
    },
  };
}
