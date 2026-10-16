# Operations and handoff

## Configuration

`scripts/setup.ps1` creates `.env` once and preserves an existing file. Keep the file private and backed up separately. `.env.example` documents the shape without credentials.

| Variable | Use |
| --- | --- |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Initial PostgreSQL database/account; password generated as random hex by setup |
| `APP_PORT` | Docker's loopback web port, default 8080 |
| `DATABASE_URL` | Native Node connection URL; Compose app supplies its internal URL automatically |
| `HOST`, `PORT` | Native server bind address/port; default 127.0.0.1:8080 |
| `PUBLIC_PORT` | Optional external port recognized in Host/Origin checks; Compose sets this from APP_PORT |
| `ALLOWED_ORIGINS` | Additional exact origins, comma-separated; needed for native Vite development |
| `DIST_DIR` | Optional native static build path |

Changing `.env`'s PostgreSQL password does **not** change the role password inside an existing volume. Coordinate password rotation through PostgreSQL and update all connection settings. Do not delete a data volume to fix a password mismatch. Arbitrary passwords need URL encoding in a connection URL; the generated hex passwords avoid that problem.

## Start, stop and update

```powershell
.\scripts\start.ps1 -NoBrowser
docker compose ps
docker compose logs --tail 100 app
docker compose stop
```

`START-DASHBOARD.cmd` also opens the browser. `STOP-DASHBOARD.cmd` stops both services without removing data. Compose waits for PostgreSQL's health check before starting the app, consistent with [Docker's startup-order guidance](https://docs.docker.com/compose/how-tos/startup-order/). The app migrates and initializes the workspace before listening.

Before updating, create a database backup. Then pull the reviewed source and run `docker compose up --build -d --wait`. Existing data is retained. Avoid running the native server and container app on the same port. Changing `APP_PORT` changes the browser URL; do not publish the port to all network interfaces to bypass the local boundary.

The named volume is `millplan_postgres_data` with the default project name. It survives container replacement. It is **not a backup**, and `down -v` deletes it.

## Backups

Portable workspace: Settings → Download backup. It includes visible records, settings and activity. Import requires a preview and replaces the active workspace; the preceding workspace is retained once. Download that recovery copy if it must be kept permanently.

Full database:

```powershell
.\scripts\backup.ps1
```

This uses `pg_dump -Fc` inside PostgreSQL and copies the binary dump to ignored `backups/millplan-<UTC time>.dump`. Do not redirect binary dump bytes through Windows PowerShell. The dump includes receipts, revision, recovery snapshots and migrations. Keep independent protected copies outside this PC and agree retention, frequency and restore responsibility with the company. No automated schedule is configured.

## Restore drill into a separate database

Test backups without overwriting the active database. The following creates a new validation database; use a fresh name if it already exists. Substitute the actual dump filename. Run from the project directory with `db` running.

```powershell
docker compose cp .\backups\millplan-YYYYMMDDTHHMMSSZ.dump db:/tmp/millplan-restore.dump
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" millplan_restore_check'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" --no-owner --exit-on-error -d millplan_restore_check /tmp/millplan-restore.dump'
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d millplan_restore_check -c "SELECT revision, updated_at FROM workspace; SELECT count(*) FROM jobs; SELECT count(*) FROM history_events;"'
docker compose exec -T db rm -f /tmp/millplan-restore.dump
```

Verify expected counts, planning data and recovery metadata. For a full application check, start an isolated native server against the restored database on another loopback port using a separate ignored environment file. Do not point integration tests at an active workspace.

To recover the service, first stop `app`, retain a dump of the current database, restore into a **new** database, verify it, and update `POSTGRES_DB`/native connection settings to the recovered database. Recreate `db` with the **same named volume** so its environment, health check and backup target all match the recovered database, then recreate `app`:

```powershell
docker compose up -d --force-recreate db --wait
docker compose up -d --force-recreate app --wait
.\scripts\backup.ps1
```

Verify the new backup targets the recovered database. Recreating only `app` leaves the old database name in the running `db` container, which would make later backups target the old database. Starting the application can run newer migrations, so match the source version to the backup before upgrading. Preserve the old database until recovery is accepted; do not use `down -v`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Docker unavailable | Start Docker Desktop; confirm Linux containers and `docker compose version` |
| Port 8080 occupied | Stop the competing native/app process, or choose an unused APP_PORT and reopen the matching URL |
| Database connection screen | `docker compose ps`; wait for DB health; inspect app logs; choose Retry connection |
| Save cannot be confirmed | Keep the form; restore connectivity; Retry connection resends the same command ID |
| Conflict after saving | Another client changed the workspace; review the retained draft, choose Reload latest, then re-enter the intended changes |
| Empty database but old file has records | Export JSON from the original offline file/browser and explicitly import it into the database UI |
| Invalid Host/Origin in development | Use 127.0.0.1/localhost, Vite proxy `changeOrigin`, and the matching ALLOWED_ORIGINS; do not disable checks |
| Authentication failed after changing .env | Existing volume still has its previous PostgreSQL password; rotate the DB credential properly |
| Static dashboard missing | Run `npm run build` for native serving, or rebuild the Docker app |

Useful checks: `GET /api/health`, `GET /api/workspace`, `docker compose logs --tail 100 app db`, and `docker compose ps`. Do not paste secrets or full connection URLs into issues.

## Before company-wide adoption

Confirm actual calendar/rates/changeover with the planner; agree backup ownership and retention; add login/roles, named audit actors and TLS; separate migration/runtime database roles; benchmark retained history; define data retention and SAP/stock integration requirements. Current Docker configuration is a loopback-only pilot, not an unattended company-server deployment.
