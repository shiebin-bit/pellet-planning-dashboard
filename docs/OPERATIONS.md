# Operations and handoff

## Windows desktop installation

Install the supplied **Millplan Setup** executable as the Windows user who will operate the dashboard. It includes Electron, the built interface/API and PostgreSQL 16. A company PC needs no separate database, Node.js or container software installation. First launch creates an empty database. Real company workbooks, credentials and existing records are never included in the installer.

The default executable is `%LOCALAPPDATA%\Programs\Millplan\Millplan.exe`. Open its desktop/Start menu shortcut. Closing the window keeps the application in the system tray; **Quit** closes the API and then PostgreSQL. The tray process must remain running for local browser or tunnel access. Startup refuses occupied ports rather than terminating unknown processes.

The application and database run as the current user, not a Windows service. They stop on logout/shutdown. Separate Windows accounts have separate workspaces and encrypted credentials. This is a local pilot installation, not an unattended shared server.

## Data and configuration

All mutable files live under `%LOCALAPPDATA%\FFM\MillPlan`, outside the installation directory:

| Path | Contents |
| --- | --- |
| `config/desktop.json` | Desktop ports, exact allowed origins and Windows-encrypted database credential |
| `postgres/data/` | PostgreSQL cluster; do not edit, move or delete while running |
| `backups/automatic/` | Managed portable V7 snapshots |
| `backups/database/` | Full database dumps |
| `logs/` | Desktop and PostgreSQL startup/shutdown diagnostics |

Default HTTP is **127.0.0.1:8080** and PostgreSQL is **127.0.0.1:5434**, preserving DataGrip's port. Desktop configuration is separate from a developer checkout's `.env`. Stop Millplan before changing desktop configuration. Never paste the encrypted credential, connection URLs or logs containing company information into public issues.

`desktop.json` uses version 1 with `httpPort`, `postgresPort`, `allowedOrigins`, `closeToTrayExplained`, and `database` (`user`, `name`, `encryptedPassword`). Use `allowedOrigins` only for additional exact HTTP(S) origins. Changing the stored credential alone does not rotate PostgreSQL's role password. Do not copy another user's encrypted credentials to a different PC.

For standalone web/server deployment, use `.env.example` as the private `.env` template. `DATABASE_URL` selects an existing native PostgreSQL database; `HOST` and `PORT` select the API binding. `DIST_DIR` and `MIGRATIONS_DIR` can supply absolute packaged paths. `ALLOWED_ORIGINS` contains exact additional browser origins. `AUTOMATIC_BACKUP_ENABLED`, `AUTOMATIC_BACKUP_DIR`, `AUTOMATIC_BACKUP_INTERVAL_HOURS` and `AUTOMATIC_BACKUP_RETENTION_COUNT` control snapshots. Desktop supplies these paths itself and enables snapshots.

## Start, stop and update

Use the installed shortcut or tray menu for normal operation: open **Millplan** to start, close its window to keep it in the tray, and choose **Quit** to stop the application and PostgreSQL. No separate launch/stop scripts are required.

For desktop source development on a Windows build machine:

```powershell
npm ci
npm run desktop:dev
```

The development command prepares PostgreSQL and application assets before opening Electron. The former CMD launchers and duplicate PowerShell start/stop/setup wrappers have been removed. Retained tools and their callers are listed in [Maintainer scripts](../scripts/README.md). The legacy `file:` build remains a separate planning-only localStorage workspace and does not share the PostgreSQL inventory ledger.

Before updating, save a full database dump and a workspace JSON. Quit Millplan, run the replacement installer, then reopen it. Updates replace program resources, not the private data directory. Normal uninstall preserves company data and backups; reinstall reuses the retained compatible cluster. Do not manually delete the data directory as an update or password-repair step.

PostgreSQL stays on major version 16. A future major upgrade requires a separate verified database migration. SQL migrations run transactionally under an advisory lock. An older application may not understand newer data; rollback requires the matching pre-update dump and compatible application version.

## Backups

**Portable workspace:** Settings → Backup & recovery → Download backup. V7 includes planning, settings, products, source orders/versions, import reviews, stock ledger, collection records, progress samples/resets, retained daily history, accepted SAP batches and continuation plans. It omits database migration history, command receipts, revision metadata, recovery copies and browser-only drafts. Restoration previews and replaces the workspace rather than merging. V1–V6 remain readable with warnings about absent sections; old orders without acceptance metadata do not automatically enter the new-demand queue.

**Automatic snapshots:** the desktop API creates V7 JSON snapshots every 24 hours by default and retains 14 successful managed copies. The first enabled start queues a copy immediately. On later starts, a missed interval produces one catch-up copy. Settings displays success/failure and the next attempt. The process must be running; there are no backups while the PC is off. Existing validated V5/V6 snapshots remain discoverable. Writes use exclusive temporary files, sync and atomic rename before managed-file pruning. Manual files are not pruned. Failures retain earlier backups and retry after 15 minutes.

**Full PostgreSQL dump:** includes all database tables, receipts, recovery metadata and migrations. Use the desktop database-backup action or this source-checkout helper:

```powershell
.\scripts\backup.ps1
# Optional new destination filename:
.\scripts\backup.ps1 -OutputPath 'E:\Protected backups\millplan-before-update.dump'
```

The helper requests the desktop backup operation and waits for its private status sidecar. It works with a running desktop process or starts the database temporarily for a backup. Existing output files are not intentionally overwritten. Keep protected copies outside this PC and verify restoration periodically. A PostgreSQL data directory is persistent storage, not a backup.

## Restore rehearsal and recovery

Never test restoration by replacing the active company workspace. Retain the current dump, then restore into a new isolated PostgreSQL 16 database using the bundled tools under the installed `resources/pgsql/bin` directory. Supply credentials privately through a password file or environment, never a public command line:

```powershell
createdb --host 127.0.0.1 --port 5434 --username millplan millplan_restore_test
pg_restore --host 127.0.0.1 --port 5434 --username millplan --dbname millplan_restore_test --no-owner --no-privileges --exit-on-error --single-transaction 'E:\Protected backups\millplan.dump'
```

Run a matching standalone API on a different loopback port against the restored database. Compare complete portable sections, workspace revision, migration versions and table contents/counts. Only after verification and a coordinated write freeze should a maintainer switch the active database. Retain the preceding recovery source. Do not direct mutation test suites at company data.

For the former container installation, the maintenance migration freezes old writes, creates a custom-format dump, restores into an isolated native cluster, compares all persisted rows and the V7 workspace, and verifies a second dump/restore before removing the project's old containers/volume. Re-importing spreadsheets is not an equivalent migration: receipts, audits and historical progress must survive.

## Cloudflare Tunnel

The desktop app preserves the existing same-origin API, so a Windows `cloudflared` connector can continue routing to **HTTP 127.0.0.1:8080** while Millplan remains running. Set the route's **HTTP Host Header** to `127.0.0.1:8080`. Add the exact public HTTPS origin to `desktop.json`'s `allowedOrigins`, then restart Millplan. Preserve other routes and origins.

Keep HTTP and PostgreSQL bound to loopback; route only the web application. Check public health, page loading and read-only preview validation. The application has no built-in login/roles and an unprotected hostname exposes full operations; exact-origin checks are not access control. Cloudflare Access can restrict a later shared deployment. Separate server deployment remains possible with the same API and native PostgreSQL.

## Building and verification

On Windows with Node.js 24, npm and Visual Studio C++ x64 redistributable files, run `npm ci`, then `npm run desktop:dist`. The vendor step downloads the pinned [EDB PostgreSQL ZIP](https://www.enterprisedb.com/download-postgresql-binaries), checks its official SHA-256, and retains runtime libraries/resources and notices. The [PostgreSQL Windows page](https://www.postgresql.org/download/windows/) describes this archive for application embedding. The build copies the required Microsoft CRT DLLs from the licensed Visual Studio Redist directory into PostgreSQL's executable folder following [Microsoft's application-local deployment guidance](https://learn.microsoft.com/en-us/cpp/windows/walkthrough-deploying-a-visual-cpp-application-to-an-application-local-folder?view=msvc-170). Builders can set `MILLPLAN_VC_RUNTIME_DIR` to that x64 `Microsoft.VC*.CRT` directory. Destination PCs do not need C++ Build Tools. Installers contain no company records and make no database download at first launch.

Local installers are unsigned unless signing credentials are configured. Test the installer on a clean Windows 10/11 x64 company PC before wider distribution, including standard-user first launch, update/reinstall persistence, printing, Excel import/export and shutdown. Existing-machine smoke checks cannot prove every corporate antivirus or application-control policy will permit it.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| App not visible after closing | Open its tray menu or desktop shortcut |
| Port 8080/5434 occupied | Close the known competing service or choose unused desktop ports; do not kill unknown processes |
| Startup/database error | Read the private `logs/` files and confirm the same Windows account/data directory |
| Credential cannot be decrypted | Use the original Windows account or recover an approved backup into a new installation; do not delete the cluster |
| Save cannot be confirmed | Keep the form; restore connectivity and retry the original request |
| Version conflict | Review the retained draft against the latest workspace and regenerate if required |
| Missing former browser draft | Drafts are profile/origin-local; reopen the original browser to recover them |
| Remote address unavailable | Host, Millplan tray process and tunnel must all run; check exact allowed origin and Host Header |
| Backup failure | Check private destination permissions/free space and Settings status; preserve earlier backups |

Before company-wide/cloud adoption, agree ownership of backups, credentials, access controls and operating hours. Desktop packaging does not add named audit actors, account login or direct SAP synchronization.
