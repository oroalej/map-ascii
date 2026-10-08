// @vitest-environment node
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { loadRegistry } from '@/lib/cities';
import HomePage from './page';
vi.mock('@/lib/cities', () => ({ loadRegistry: vi.fn() }));
it('emits a server redirect with a query/hash-preserving script for the only city', async () => {
  vi.mocked(loadRegistry).mockResolvedValue([
    { city: { slug: 'example', name: { en: 'Example' } } },
  ] as never);
  const html = renderToStaticMarkup(await HomePage());
  expect(html).toContain('http-equiv="refresh"');
  expect(html).toContain('0;url=/example');
  expect(html).toContain('Opening');
  const location = { search: '?lat=1&lng=2&z=17', hash: '#place', replace: vi.fn() };
  // Execute the tiny redirect independently of React hydration.
  runInNewContext(/<script>(.*?)<\/script>/.exec(html)![1]!, { location });
  expect(location.replace).toHaveBeenCalledWith('/example?lat=1&lng=2&z=17#place');
});
it('renders a multi-city list without a redirect', async () => {
  vi.mocked(loadRegistry).mockResolvedValue(
    ['first', 'second'].map((slug) => ({ city: { slug, name: { en: slug } } })) as never,
  );
  const html = renderToStaticMarkup(await HomePage());
  expect(html).toContain('aria-label="Cities"');
  expect(html).toContain('href="/second"');
  expect(html).not.toContain('refresh');
  expect(html).not.toContain('<script');
});
