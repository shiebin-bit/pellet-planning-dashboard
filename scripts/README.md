# Maintainer scripts

Company users install Millplan from [GitHub Releases](https://github.com/shiebin-bit/pellet-planning-dashboard/releases/latest) and open its desktop or Start menu shortcut. Start/stop/setup wrappers are not required. Use the tray menu to quit or back up the database.

The scripts below support source development, packaging and maintenance. They are retained in the repository; company users do not need to copy this directory.

| File | Purpose | Entry point |
| --- | --- | --- |
| `desktop-dev.mjs` | Prepare the PostgreSQL runtime and application assets, then open Electron | `npm run desktop:dev` |
| `build-desktop.mjs` | Build the UI/API, copy SQL migrations and apply the packaged UI content security policy | `npm run desktop:prepare`; also called by development and packaging |
| `desktop-package.mjs` | Prepare resources and produce the Windows unpacked app or installer; publishing is disabled | `npm run desktop:pack` / `npm run desktop:dist` |
| `prepare-postgres.ps1` | Download and verify the pinned PostgreSQL archive, prepare runtime files and notices | Called by desktop development/packaging |
| `backup.ps1` | Request a full database dump through Millplan and wait for its result | Optional maintenance/automation command below |
| `desktop-command.ps1` | Find the installed desktop executable or source-development Electron entry | Internal helper used by `backup.ps1` |
| `seed-demo-history.ts` | Explicitly seed fictional demonstration history | `npm run seed:demo-history`; use a dedicated demo database |

## Source development and packaging

On a Windows build computer with Node.js 24 and the documented C++ runtime files:

```powershell
npm ci
npm run desktop:dev
```

Quit the development app before packaging. Use `npm run desktop:dist` to create the installer. See [Operations](../docs/OPERATIONS.md#building-and-verification) for prerequisites and verification.

## Optional database backup automation

Normal desktop users can choose **Back up database…** in the tray menu. Maintainers can also run:

```powershell
.\scripts\backup.ps1
.\scripts\backup.ps1 -OutputPath 'E:\Protected backups\millplan-before-update.dump'
```

Use a new filename and retain the backup privately. The helper uses the installed app when available; source development requires dependencies and prepared desktop resources. For recovery procedures, see [Operations](../docs/OPERATIONS.md#backups).

SQL migrations remain under `server/migrations/`. Standalone API development and `npm run db:migrate` remain available through `package.json`; they are separate from the installed desktop application's automatic startup.
