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
| `ALLOWED_ORIGINS` | Additional exact origins, comma-separated; forwarded to the Docker app too. Required for Vite development and any HTTPS reverse-proxy hostname |
| `DIST_DIR` | Optional native static build path |
| `COMPOSE_FILE`, `COMPOSE_PATH_SEPARATOR` | Optional persistent Compose file selection; on Windows use `compose.yml;compose.dev.yml` and `;` to retain DataGrip port 5434 through normal startup |

Changing `.env`'s PostgreSQL password does **not** change the role password inside an existing volume. Coordinate password rotation through PostgreSQL and update all connection settings. Do not delete a data volume to fix a password mismatch. Arbitrary passwords need URL encoding in a connection URL; the generated hex passwords avoid that problem.

## Cloudflare Tunnel

For a `cloudflared` connector running on this Windows PC, route the chosen hostname to **HTTP `127.0.0.1:8080`** (or the configured `APP_PORT`). Under the route's additional HTTP settings, set **HTTP Host Header** to **`127.0.0.1:8080`**. This lets the existing loopback Host validation work behind the tunnel. Add the exact public origin, for example `https://planning.example.com`, to `.env`'s `ALLOWED_ORIGINS`, preserving existing origins. Recreate only the app with `docker compose up -d --no-deps --wait app`; an environment-only change does not require an image rebuild.

Keep web port 8080 and DataGrip port 5434 bound to `127.0.0.1`. Route only the web application through the tunnel. Verify the public health endpoint and preview request validation as well as loading the page: loading HTML alone does not prove that the HTTPS origin can save/import.

The dashboard provides full planning and stock operations without an application login. An unprotected published hostname makes these operations reachable by anyone who discovers the URL; it does not provide view-only access. Use Cloudflare Access with an explicit allow policy for restricted remote use. Do not overwrite other tunnel routes. Removing this application's route/DNS and its exact allowed origin rolls back external access while preserving the local dashboard and database.

## Start, stop and update

```powershell
.\scripts\start.ps1 -NoBrowser
docker compose ps
docker compose logs --tail 100 app
docker compose stop
```

`OPEN-DASHBOARD.cmd` and `START-DASHBOARD.cmd` both start the Docker services and open the PostgreSQL-backed application in the browser. `OPEN-OFFLINE-DASHBOARD.cmd` is the explicitly separate localStorage build. `STOP-DASHBOARD.cmd` stops both Docker services without removing data. Compose waits for PostgreSQL's health check before starting the app, consistent with [Docker's startup-order guidance](https://docs.docker.com/compose/how-tos/startup-order/). The app migrates and initializes a new workspace with empty jobs and activity before listening.

Before updating, create a database backup. Then pull the reviewed source and run `docker compose up --build -d --wait`. Existing data is retained. Avoid running the native server and container app on the same port. Changing `APP_PORT` changes the browser URL; do not publish the port to all network interfaces to bypass the local boundary.

If DataGrip uses `127.0.0.1:5434`, keep `compose.dev.yml` enabled during every update/start. Either pass `-f compose.yml -f compose.dev.yml`, or put `COMPOSE_FILE=compose.yml;compose.dev.yml` and `COMPOSE_PATH_SEPARATOR=;` in the private Windows `.env`. The override publishes only loopback PostgreSQL; database/user remain `millplan` with the existing private password. Do not paste the password into documentation.

The efficiency update adds migration 003 (`workspace.catalog` JSONB) without replacing existing jobs. Before deploying, retain a dump and a workspace JSON, then compare all pre-existing job payloads after startup. Seed the eight fictional `-DEMO` catalog entries only when the existing workspace is marked Demo and its catalog is empty; do not reset its production data. Ordinary workspaces stay empty. New backups and newly saved recovery/Undo snapshots use version 2; rolling back to a binary that only reads version 1 requires a matching pre-upgrade database backup.

The pause/history update adds optional `jobs.payload.pauseIntervals` and `history_events.payload.changes` fields without SQL changes or automatic backfills. Back up both PostgreSQL and the workspace JSON before deploying, then verify that the revision, complete job payloads, settings, catalog and existing activity match the predeployment snapshot. The existing DataGrip port remains 5434. Once new fields have been written, **an older binary's strict reader cannot read them**; rollback requires the matching predeployment dump plus the previous application image/source, not just an old image. Restore that dump into a separate verified database and coordinate any newer records before switching the service.

The named volume is `millplan_postgres_data` with the default project name. It survives container replacement. It is **not a backup**, and `down -v` deletes it.

## Backups

Portable workspace: Settings → Download backup. The database application exports version 3, including planning, catalog, activity, imported orders and their source versions. Offline exports remain planning-only version 2. Import requires a preview and replaces the active workspace. Legacy versions 1/2 omit Data and trigger a warning; version 1 also restores an empty catalog. The preceding complete workspace is retained once. Download that recovery copy if it must be kept permanently.

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


## Excel Data / shift rollout

Before upgrading, save a PostgreSQL dump and current workspace JSON. Record the latest production count, IDs/payloads, catalog and execution timestamps; use the fresh count rather than an older demonstration count. Migrations 004–007 add source tables, source links/recovery and canonical identity indexes. These migrations do not reset jobs or activate a new calendar. Intermediate development databases from unreleased 004–006 builds are disposable; use a clean test database if semantic-digest backfill finds collisions.

After independent tests pass, rebuild only the app with the existing Compose project and volume. Retain `compose.dev.yml` / localhost **5434** for DataGrip. Call the revision-checked `settings.activateCalendar` command once with `effectiveFrom` equal to the server's current MYT date, `dayStart: "07:00"`, `availableHours: 12`. The server verifies the date, freezes missing legacy execution segments, records the prior calendar and validates the entire candidate schedule atomically. Repeat identical activation is safe; different activation values are rejected. Shift controls are locked afterward. If validation fails, leave existing data intact and resolve the reported schedule before retrying.

Re-read the workspace and compare every pre-existing job. Status, actual times/quantities, source values and record IDs must be unchanged; only missing locked segments on already-started/completed legacy jobs may be added. Pending computed times may change for today/future dates. Check Data and its empty initial state without inserting fictional company records, then verify health and the 5434 mapping. Portable version 3 backups include source data and full recovery; generated JSON is bounded to 64 MB and larger workspaces require the PostgreSQL dump path. Restore must use a matching application version.
