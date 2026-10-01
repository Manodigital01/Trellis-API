# Database identifier decision and migration runbook

## Decision

The existing database identifiers remain the default for the compatibility
window. A database name is part of the deployment contract: changing a
default does not rename an existing PostgreSQL database or Docker volume, and
silently changing it would make a deployment appear to have lost its data.

All environments now accept `DB_DATABASE`. This lets an operator migrate one
environment at a time without changing application code, while fresh
deployments can choose the new identifier.

## Controlled rename

1. Back up the source database and record the current volume/database name.
2. Schedule downtime or stop writes; database renames are not online schema
   migrations.
3. Either run `ALTER DATABASE old_name RENAME TO new_name` as a privileged
   PostgreSQL operator, or restore the dump into a new database. The latter is
   preferred when the database is managed or the name is referenced by a
   connection pool.
4. Set `DB_DATABASE=new_name` (and update `DATABASE_URL` if it embeds the
   database name) before deploying the application.
5. Run migrations and health checks, then verify representative reads and
   writes before reopening traffic.
6. Do not delete the old Docker volume until the backup and rollback window
   have expired. Docker volumes retain the old database regardless of the
   `POSTGRES_DB` value in a later compose run.

Rollback is the same process in reverse: stop writes, restore the old
identifier in `DB_DATABASE`/`DATABASE_URL`, and redeploy the prior version.
