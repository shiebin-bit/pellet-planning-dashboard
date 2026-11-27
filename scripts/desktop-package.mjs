import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const target = process.argv[2] === "dir" ? "dir" : "nsis";
const preparePostgres = path.join(projectRoot, "scripts", "prepare-postgres.ps1").replace(/'/g, "''");
await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Import-Module Microsoft.PowerShell.Utility; & '${preparePostgres}'`], "PostgreSQL runtime preparation");
await run(process.execPath, [npmCli(), "run", "desktop:prepare"], "desktop preparation");
await run(process.execPath, [path.join(projectRoot, "node_modules", "electron-builder", "cli.js"), "--win", target], "desktop packaging");

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", windowsHide: true });
    child.once("error", error => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`${label} failed with exit code ${code}.`)));
  });
}

function npmCli() {
  return process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
}
