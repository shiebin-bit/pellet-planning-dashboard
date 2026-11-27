import path from "node:path";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

const projectRoot = path.resolve(import.meta.dirname, "..");
try {
  await access(path.join(projectRoot, "output", "vendor", "pgsql", "bin", "postgres.exe"));
} catch {
  const script = path.join(projectRoot, "scripts", "prepare-postgres.ps1").replace(/'/g, "''");
  await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Import-Module Microsoft.PowerShell.Utility; & '${script}'`], "PostgreSQL runtime preparation");
}
await run(process.execPath, [npmCli(), "run", "desktop:prepare"], "desktop preparation");
await run(path.join(projectRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron"), [path.join(projectRoot, "desktop", "main.cjs"), ...process.argv.slice(2)], "Electron");

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", windowsHide: false });
    child.once("error", error => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`${label} failed with exit code ${code}.`)));
  });
}

function npmCli() {
  return process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
}
