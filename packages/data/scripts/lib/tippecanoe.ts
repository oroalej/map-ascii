import { spawnSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = 'ascii-atlas-data-tools';
const dockerDir = fileURLToPath(new URL('../../docker/', import.meta.url));

const available = (command: string, args: string[]) =>
  spawnSync(command, args, { stdio: 'ignore' }).status === 0;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

/**
 * Run tippecanoe with `args`, where `{in}` and `{out}` stand for `input` and `output`. Both
 * files must be in the same directory. Uses a native tippecanoe when it is on PATH, and
 * otherwise the Docker image built from `packages/data/docker/`.
 */
export function tippecanoe(input: string, output: string, args: string[]) {
  const workDir = dirname(input);
  if (dirname(output) !== workDir)
    throw new Error('tippecanoe input and output must share a folder');

  if (available('tippecanoe', ['--version'])) {
    run(
      'tippecanoe',
      args.map((a) => a.replace('{in}', input).replace('{out}', output)),
    );
    return;
  }

  if (!available('docker', ['info'])) {
    if (!available('docker', ['--version'])) {
      throw new Error(
        'tippecanoe is not installed and neither is Docker. Install Docker Desktop (or ' +
          'tippecanoe) and run the pipeline again; see packages/data/README.md.',
      );
    }
    console.log('  starting Docker Desktop…');
    if (!available('docker', ['desktop', 'start']) || !available('docker', ['info'])) {
      throw new Error(
        "Docker is installed but its engine isn't running. Start Docker Desktop and rerun " +
          'with `--from 05`; see packages/data/README.md.',
      );
    }
  }
  if (!available('docker', ['image', 'inspect', image])) {
    console.log(`  building the ${image} Docker image (first run only)…`);
    run('docker', ['build', '-t', image, dockerDir]);
  }
  const inContainer = (file: string) => `/data/${basename(file)}`;
  run('docker', [
    'run',
    '--rm',
    '-v',
    `${workDir}:/data`,
    image,
    'tippecanoe',
    ...args.map((a) => a.replace('{in}', inContainer(input)).replace('{out}', inContainer(output))),
  ]);
}
