import { loadCityPacks } from './validate';

const { packs, errors } = await loadCityPacks();

if (errors.length > 0) {
  for (const { file, message } of errors) console.error(`✗ ${file}: ${message}`);
  console.error(`\nContent validation failed with ${errors.length} error(s).`);
  process.exit(1);
}

for (const { city, content } of packs) {
  const counts = Object.entries(content)
    .map(([name, records]) => `${records.length} ${name}`)
    .join(', ');
  console.log(`✓ ${city.slug}: ${counts}`);
}
console.log(`Content valid (${packs.length} ${packs.length === 1 ? 'city' : 'cities'}).`);
