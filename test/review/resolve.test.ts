import { describe, expect, it, vi } from 'vitest';
import { parseItadRef, resolveSlug } from '../../src/review/resolve.ts';

const ID = '018d937f-6cf3-72a3-9926-b559d55a4268';

describe('parseItadRef', () => {
  it('accepts game URLs, slugs and ids', () => {
    expect(parseItadRef('https://isthereanydeal.com/game/octodad-student-edition/info/')).toEqual({ kind: 'slug', slug: 'octodad-student-edition' });
    expect(parseItadRef('https://isthereanydeal.com/game/octodad-student-edition/history/')).toEqual({ kind: 'slug', slug: 'octodad-student-edition' });
    expect(parseItadRef('  octodad-student-edition ')).toEqual({ kind: 'slug', slug: 'octodad-student-edition' });
    expect(parseItadRef(ID.toUpperCase())).toEqual({ kind: 'id', id: ID });
  });

  it('rejects other input', () => {
    expect(parseItadRef('https://example.com/game/octodad/info/')).toBeUndefined();
    expect(parseItadRef('https://isthereanydeal.com/deals/')).toBeUndefined();
    expect(parseItadRef('two words')).toBeUndefined();
    expect(parseItadRef('')).toBeUndefined();
  });
});

describe('resolveSlug', () => {
  const result = (slug: string, id = `id-${slug}`) => ({ id, slug, title: slug, type: 'game' });

  it('picks the search result with exactly that slug', async () => {
    const api = { search: vi.fn(async () => [result('octodad'), result('octodad-student-edition', ID)]) };
    expect(await resolveSlug(api, 'octodad-student-edition')).toEqual({ id: ID, slug: 'octodad-student-edition', title: 'octodad-student-edition' });
    expect(api.search).toHaveBeenCalledWith('octodad student edition', 100);
  });

  it('retries without a numeric suffix for duplicate-name slugs', async () => {
    const api = { search: vi.fn(async (q: string) => (q === 'same name' ? [result('same-name'), result('same-name-2')] : [])) };
    expect((await resolveSlug(api, 'same-name-2'))?.id).toBe('id-same-name-2');
    expect(api.search).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when nothing matches', async () => {
    expect(await resolveSlug({ search: async () => [result('other')] }, 'missing')).toBeUndefined();
  });
});
