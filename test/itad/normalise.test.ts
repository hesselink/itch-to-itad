import { describe, expect, it } from 'vitest';
import {
  companiesMatch,
  itchSubdomain,
  normaliseCompany,
  normaliseTitle,
  titlesMatch,
  titleVariants,
} from '../../src/itad/normalise.ts';

describe('titles', () => {
  it('normalises case, punctuation, diacritics and symbols', () => {
    expect(normaliseTitle('TUNIC')).toBe('tunic');
    expect(normaliseTitle('Pokémon™: Don’t Starve & Co.')).toBe('pokemon dont starve and co');
    expect(normaliseTitle('(Not Escape Room)')).toBe('not escape room');
  });

  it('matches equivalent titles but not different ones', () => {
    expect(titlesMatch('TUNIC', 'Tunic')).toBe(true);
    expect(titlesMatch('Celeste™', 'Celeste')).toBe(true);
    expect(titlesMatch('Ghost', 'Ghostrunner')).toBe(false);
    expect(titlesMatch('Ghost', 'Ghost of a Tale')).toBe(false);
  });

  it('produces lookup variants without symbols and trailing qualifiers', () => {
    expect(titleVariants('Celeste™')).toEqual(['Celeste™', 'Celeste']);
    expect(titleVariants('Some Game - Deluxe Edition')).toEqual(['Some Game - Deluxe Edition', 'Some Game']);
    expect(titleVariants("Some Game (Director's Cut)")).toEqual(["Some Game (Director's Cut)", 'Some Game']);
    expect(titleVariants('Plain')).toEqual(['Plain']);
    // A title that is only a qualifier is kept as is
    expect(titleVariants('Deluxe Edition')).toEqual(['Deluxe Edition']);
  });

  it('keeps demo/prototype/early access qualifiers, since those are different builds', () => {
    for (const t of ['Dorfromantik (Prototype)', 'Some Game (Demo)', 'Some Game - Early Access', 'Some Game [Jam Version]', 'Some Game Beta']) {
      expect(titleVariants(t)).toEqual([t]);
    }
  });
});

describe('companies', () => {
  it('strips corporate noise words', () => {
    expect(normaliseCompany('ISOMETRICORP Games Ltd.')).toBe('isometricorp');
    expect(normaliseCompany('Finji')).toBe('finji');
    expect(normaliseCompany('The Games Studio')).toBe('thegamesstudio'); // all noise → keep everything
  });

  it('matches itch account names against ITAD developers/publishers', () => {
    expect(companiesMatch(['Finji', 'finji'], ['ISOMETRICORP Games Ltd.', 'TUNIC Team', 'Finji'])).toBe(true);
    expect(companiesMatch(['isometricorp'], ['ISOMETRICORP Games Ltd.'])).toBe(true);
    expect(companiesMatch(['Mega Crit'], ['MegaCrit Games'])).toBe(true);
    expect(companiesMatch(['guysfromandromeda'], ['Guys From Andromeda LLC'])).toBe(true);
    expect(companiesMatch(['someone'], ['Ubisoft'])).toBe(false);
    // Very short names must match exactly, not by substring
    expect(companiesMatch(['ea'], ['Bear Games'])).toBe(false);
    expect(companiesMatch([], ['Finji'])).toBe(false);
  });

  it('extracts the itch subdomain', () => {
    expect(itchSubdomain('https://finji.itch.io')).toBe('finji');
    expect(itchSubdomain('https://example.com')).toBeUndefined();
    expect(itchSubdomain(undefined)).toBeUndefined();
  });
});
