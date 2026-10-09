// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import payloads from './__fixtures__/ui-payloads.json';
import { assertPublishedTourGroups } from './published-tour-groups';

const read = vi.fn<(path: string, encoding: 'utf8') => Promise<string>>();
const city = {
  slug: 'fixture',
  tour_groups: [{ id: 'heritage', label: { en: 'Heritage' } }],
};
const first = { ...payloads.tours[0]!, id: 'tour/first', group: 'heritage' };
beforeEach(() => read.mockReset());

it('accepts matching published assignments and reads the served sidecar', async () => {
  read.mockResolvedValue(JSON.stringify([first]));
  await expect(assertPublishedTourGroups(city, read)).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledWith(
    join(process.cwd(), 'public', 'tiles', 'fixture.tours.json'),
    'utf8',
  );
});

it.each([undefined, 'old-group'])(
  'rejects a stale non-first tour assignment %s with an actionable city/tour error',
  async (group) => {
    read.mockResolvedValue(JSON.stringify([first, { ...first, id: 'tour/later', group }]));
    await expect(assertPublishedTourGroups(city, read)).rejects.toThrow(
      `Published tour tour/later in fixture has group ${group === undefined ? '<missing>' : '"old-group"'}`,
    );
    await expect(assertPublishedTourGroups(city, read)).rejects.toThrow('Regenerate and publish');
  },
);

it('accepts ungrouped published tours for an ungrouped city', async () => {
  read.mockResolvedValue(JSON.stringify([{ ...first, group: undefined }]));
  await expect(assertPublishedTourGroups({ slug: city.slug }, read)).resolves.toBeUndefined();
});

it('rejects a grouped sidecar for an ungrouped city', async () => {
  read.mockResolvedValue(JSON.stringify([first]));
  await expect(assertPublishedTourGroups({ slug: city.slug }, read)).rejects.toThrow(
    'Published tour tour/first in fixture has group "heritage"; expected no group',
  );
});

it('rejects a malformed tour sidecar', async () => {
  read.mockResolvedValue('{}');
  await expect(assertPublishedTourGroups(city, read)).rejects.toThrow(
    'Invalid published tours for fixture',
  );
});
