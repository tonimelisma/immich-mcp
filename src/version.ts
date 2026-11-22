import { createRequire } from 'node:module';

/** From package.json (next to src/ and dist/), so the version is written in one place. */
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string })
  .version;
