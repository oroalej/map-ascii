import { loadContent } from './validate';

const { content, errors } = await loadContent();

if (errors.length > 0) {
  for (const { file, message } of errors) console.error(`✗ ${file}: ${message}`);
  console.error(`\nContent validation failed with ${errors.length} error(s).`);
  process.exit(1);
}

const counts = Object.entries(content)
  .map(([name, records]) => `${records.length} ${name}`)
  .join(', ');
console.log(`✓ Content valid (${counts}).`);
