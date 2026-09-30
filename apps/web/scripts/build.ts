import { parseArgs } from 'node:util';
import { prepareExport } from './static-export';

try {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { force: { type: 'boolean', default: false } },
  });
  await prepareExport({ force: values.force });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
