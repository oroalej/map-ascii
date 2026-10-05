/** Decorate bounded filesystem cleanup failures with the same retry guidance. */
export function withCleanupError(
  path: string,
  verb: 'cleaned' | 'deleted',
  cleanup: () => void,
  recovery = '',
): void {
  try {
    cleanup();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
      throw new Error(
        `Partially ${verb} ${path}: a process is using it. Close it and rerun to finish.${recovery} (${code})`,
      );
    }
    throw error;
  }
}
