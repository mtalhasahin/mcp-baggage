#!/usr/bin/env node
/**
 * The entry point, and nothing else.
 *
 * `cli.ts` holds the argument parsing and the run so that both can be tested
 * without a process; this file is the part that cannot be — it takes the exit
 * code and ends.
 */

import { main } from './cli.ts';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
