// Vite's import.meta.glob, for tests that read city-pack files from disk. Vite resolves the literal
// pattern when it transforms the file, so `vitest related` and `--changed` select the test when
// one of the matched files changes. A lazy glob (no `eager`) loads nothing at run time.
interface ImportMeta {
  glob(
    pattern: string | string[],
    options?: { eager?: boolean; import?: string; query?: string },
  ): Record<string, unknown>;
}
