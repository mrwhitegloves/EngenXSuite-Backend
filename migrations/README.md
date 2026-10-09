# Database migrations

One file per change to existing data or structure. Each file runs exactly once per database
(recorded in the `migrations_changelog` collection). The server runs pending migrations when it
starts; a failing migration stops the start.

## When a migration is needed

- Renaming or removing a field that existing documents have.
- Filling a new required field on existing documents.
- Correcting wrong data.
- Removing or changing an index.

Not needed for a new collection, a new optional field or a new index: Mongoose creates indexes
from the schemas when the server starts.

## Commands (run inside `server/`)

```text
npm run migrate -- create <name>    New empty migration, e.g. create rename-stage-field
npm run migrate -- status           Which migrations ran, and when
npm run migrate                     Run the pending ones now (the server also does this at start)
npm run migrate -- down             Undo the most recent one
```

They use the development database unless `NODE_ENV=production` is set.

## Rules

- Never edit the database by hand, and never edit a migration that already ran on production:
  write a new one.
- A migration must be safe on any amount of data, and `down` must undo `up`.
- Use the plain driver (`db.collection('name')`), not the Mongoose models.
- Take a backup first for anything that deletes or rewrites data (`npm run backup`).
