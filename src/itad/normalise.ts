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
