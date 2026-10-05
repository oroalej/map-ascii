import { it } from 'vitest';
import { priorityReplay } from './testing/priority-replay';
it('replays complete priority state exactly at 60 Hz through expiry and people closure', () =>
  priorityReplay(60));
