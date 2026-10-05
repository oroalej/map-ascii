/**
 * Run a TypeScript script under a machine-wide heavy slot (scripts/heavy-slot.ts):
 *   tsx scripts/heavy.ts [--exclusive] <script.ts> [args...]
 */
import { spawn } from 'node:child_process';
import { withHeavySlot } from './heavy-slot';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const exclusive = args[0] === '--exclusive';
const [script, ...rest] = exclusive ? args.slice(1) : args;
if (!script) {
  console.error('usage: tsx scripts/heavy.ts [--exclusive] <script.ts> [args...]');
  process.exit(2);
}
try {
  process.exitCode = await withHeavySlot(
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', import.meta.resolve('tsx'), script, ...rest],
          {
            stdio: 'inherit',
          },
        );
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }),
    { exclusive },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
