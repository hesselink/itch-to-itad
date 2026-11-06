// Pure helpers for comparing itch and ITAD titles and company names.

// Drop ™/®/© first: NFKD would otherwise turn ™ into the letters "TM".
const stripDiacritics = (s: string) =>
  s.replace(/[™®©℠]/g, ' ').normalize('NFKD').replace(/\p{M}+/gu, '');

/** Lowercase alphanumeric words, for comparing titles loosely. */
export function titleTokens(title: string): string[] {
  return stripDiacritics(title)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '') // "Don't" → "dont"
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export const normaliseTitle = (title: string) => titleTokens(title).join(' ');

/** Jaccard similarity of the title word sets (1 = same words). */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / (ta.size + tb.size - common);
}

export const TITLE_SIMILARITY_THRESHOLD = 0.9;

export function titlesMatch(a: string, b: string): boolean {
  return normaliseTitle(a) === normaliseTitle(b) || titleSimilarity(a, b) >= TITLE_SIMILARITY_THRESHOLD;
}

// Only qualifiers that name the same game. Demo, prototype, early access,
// alpha/beta and jam versions are deliberately NOT stripped: on itch those are
// usually separate, different builds (e.g. "Dorfromantik (Prototype)" is not
// the full Steam game).
const TRAILING_QUALIFIERS =
  /\s*[-–—:]?\s*[([]?\s*(?:deluxe edition|definitive edition|complete edition|director'?s cut|pc version|windows version)\s*[)\]]?\s*$/i;

/**
 * Title variants to try with ITAD's exact-title lookup: the original, one
 * without trademark symbols / fancy quotes, and one without trailing
 * edition qualifiers like "- Deluxe Edition".
 */
export function titleVariants(title: string): string[] {
  const cleaned = title
    .replace(/[™®©]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  const variants = [title.trim(), cleaned];
  let stripped = cleaned;
  for (let prev = ''; prev !== stripped; ) {
    prev = stripped;
    stripped = stripped.replace(TRAILING_QUALIFIERS, '').trim();
  }
  if (stripped.length > 0) variants.push(stripped);
  return [...new Set(variants.filter(Boolean))];
}

const COMPANY_NOISE = new Set([
  'the', 'games', 'game', 'gaming', 'studio', 'studios', 'interactive', 'entertainment', 'ltd', 'limited',
  'llc', 'inc', 'gmbh', 'co', 'corp', 'corporation', 'team', 'productions', 'production', 'software',
  'publishing', 'digital', 'media', 'labs', 'lab', 'srl', 'sas', 'ab', 'bv', 'oy', 'pty', 'kk',
]);

/** "ISOMETRICORP Games Ltd." → "isometricorp"; "Finji" → "finji". */
export function normaliseCompany(name: string): string {
  const words = stripDiacritics(name)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const meaningful = words.filter((w) => !COMPANY_NOISE.has(w));
  return (meaningful.length > 0 ? meaningful : words).join('');
}

const MIN_CONTAINS_LENGTH = 4;

/** True if any itch-side name matches any ITAD developer/publisher name. */
export function companiesMatch(itchNames: readonly string[], itadNames: readonly string[]): boolean {
  const a = itchNames.map(normaliseCompany).filter(Boolean);
  const b = itadNames.map(normaliseCompany).filter(Boolean);
  return a.some((x) =>
    b.some(
      (y) =>
        x === y ||
        (Math.min(x.length, y.length) >= MIN_CONTAINS_LENGTH && (x.includes(y) || y.includes(x))),
    ),
  );
}

/** "https://finji.itch.io" → "finji". */
export function itchSubdomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.itch.io') ? host.slice(0, -'.itch.io'.length) : undefined;
  } catch {
    return undefined;
  }
}

export type DistinctiveReason = 'symbols' | 'words' | 'long-words' | 'long-word';

/**
 * Whether a title is unusual enough that an identical title on ITAD is
 * almost certainly the same game, even without developer data:
 * - several symbols (",,,softfriends,,,", "[EN/ESP] The Tail Makes the Fox")
 * - three or more words with at least 12 letters ("My Nuclear Octopus")
 * - two long words (14+ letters, "Imperishable Memories")
 * - one long word (12+ letters, "NeuraQuarium")
 * Short or generic titles ("Octodad", "birdsong", "Cube") don't qualify.
 */
export function distinctiveTitle(title: string): DistinctiveReason | undefined {
  return symbolDistinctive(title) ?? wordDistinctive(title);
}

function symbolDistinctive(title: string): 'symbols' | undefined {
  const letters = titleTokens(title).join('').length;
  const symbols = [...title].filter((c) => !/[\p{L}\p{N}\s]/u.test(c)).length;
  return symbols >= 2 && letters >= 6 ? 'symbols' : undefined;
}

function wordDistinctive(title: string): Exclude<DistinctiveReason, 'symbols'> | undefined {
  const tokens = titleTokens(title);
  const letters = tokens.join('').length;
  if (tokens.length >= 3 && letters >= 12) return 'words';
  if (tokens.length === 2 && letters >= 14) return 'long-words';
  if (tokens.length === 1 && letters >= 12) return 'long-word';
  return undefined;
}

const exactish = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Accepts an itch/ITAD title pair as an unambiguous match when the itch title
 * is distinctive and the titles are identical. When the symbols are what makes
 * a title distinctive they must match exactly; word-based distinctiveness
 * allows punctuation and ™ differences ("Pyramidal Break™" = "Pyramidal Break").
 */
export function distinctiveTitleMatch(itchTitle: string, itadTitle: string): DistinctiveReason | undefined {
  if (exactish(itchTitle) === exactish(itadTitle)) return distinctiveTitle(itchTitle);
  if (normaliseTitle(itchTitle) === normaliseTitle(itadTitle)) return wordDistinctive(itchTitle);
  return undefined;
}
