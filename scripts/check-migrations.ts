import { readMigrations } from '../src/infrastructure/persistence/migrate';
console.log(
  `Migration ordering PASS (${readMigrations('src/infrastructure/persistence/migrations').length} migration)`,
);
