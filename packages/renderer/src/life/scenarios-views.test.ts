import { it } from 'vitest';
import { checkViewRevival } from './testing/view-revival';

// eslint-disable-next-line no-restricted-syntax -- 100 complete view cycles
it('seed 1: view changes revive tiles and respawn deterministically after expiry', () => {
  checkViewRevival(1);
}, 30_000);
