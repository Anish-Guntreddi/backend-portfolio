import { pathToFileURL } from 'node:url';
import { createLogger } from '@portfolio/shared';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { NullCache } from './cache.ts';
import { createFlag } from './repo/flagsRepo.ts';
import type { FlagDefinition } from '@portfolio/flagforge-core';

const SEEDS: FlagDefinition[] = [
  {
    key: 'maintenance-mode',
    type: 'boolean',
    enabled: false,
    variations: [
      { key: 'off', value: false, name: 'Off' },
      { key: 'on', value: true, name: 'On' },
    ],
    offVariation: 'off',
    fallthrough: { kind: 'fixed', variation: 'off' },
    targets: [],
    rules: [],
    salt: 'maintenance-mode-v1',
  },
  {
    key: 'new-checkout-flow',
    type: 'boolean',
    enabled: true,
    variations: [
      { key: 'control', value: false, name: 'Control' },
      { key: 'treatment', value: true, name: 'Treatment' },
    ],
    offVariation: 'control',
    fallthrough: {
      kind: 'rollout',
      weights: [
        { variation: 'control', weight: 80 },
        { variation: 'treatment', weight: 20 },
      ],
    },
    targets: [],
    rules: [],
    salt: 'checkout-v1',
  },
  {
    key: 'button-color',
    type: 'string',
    enabled: true,
    variations: [
      { key: 'blue', value: 'blue', name: 'Blue' },
      { key: 'green', value: 'green', name: 'Green' },
      { key: 'red', value: 'red', name: 'Red' },
    ],
    offVariation: 'blue',
    fallthrough: {
      kind: 'rollout',
      weights: [
        { variation: 'blue', weight: 50 },
        { variation: 'green', weight: 30 },
        { variation: 'red', weight: 20 },
      ],
    },
    targets: [{ variation: 'green', values: ['vip-user-1', 'designer-alice'] }],
    rules: [
      {
        id: 'internal-users',
        description: 'Internal employees always get green',
        clauses: [{ attribute: 'team', op: 'in', values: ['engineering', 'design'], negate: false }],
        serve: { kind: 'fixed', variation: 'green' },
      },
    ],
    salt: 'button-color-v1',
  },
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = createLogger('flagforge:seed');
  const cfg = loadConfig();
  const { db, pool } = createDb(cfg.DATABASE_URL);
  const cache = new NullCache();

  let seeded = 0;
  for (const def of SEEDS) {
    try {
      await createFlag(db, cache, def, 'seed-script');
      seeded += 1;
      log.info({ key: def.key }, 'seeded flag');
    } catch (err: unknown) {
      // Skip if already exists (Conflict)
      if (err instanceof Error && err.message.includes('already exists')) {
        log.info({ key: def.key }, 'flag already exists, skipping');
      } else {
        log.error({ err, key: def.key }, 'seed failed');
      }
    }
  }

  await pool.end();
  log.info({ seeded }, 'seed complete');
  process.exit(0);
}
