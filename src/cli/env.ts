/** Reads required environment variables, exiting with a helpful message if any are missing. */
export function requireEnv<K extends string>(...names: K[]): Record<K, string> {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    console.error(`Missing environment variables (put them in .env): ${missing.join(', ')}`);
    process.exit(1);
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n]!])) as Record<K, string>;
}
