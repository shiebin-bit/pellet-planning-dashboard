import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const projectRoot = path.resolve(import.meta.dirname, "..");
const desktopOutput = path.join(projectRoot, "output", "desktop");
const serverOutput = path.join(desktopOutput, "server");

await run(process.execPath, [npmCli(), "run", "build"], "web application build");
await rm(desktopOutput, { recursive: true, force: true });
await mkdir(serverOutput, { recursive: true });

await build({
  entryPoints: [path.join(projectRoot, "server", "index.ts")],
  outfile: path.join(serverOutput, "index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  legalComments: "linked",
  logLevel: "info",
});
await cp(path.join(projectRoot, "server", "migrations"), path.join(serverOutput, "migrations"), { recursive: true });
await applyPackagedContentSecurityPolicy(path.join(projectRoot, "dist", "index.html"));
process.stdout.write(`Desktop application assets prepared in ${desktopOutput}.\n`);

async function applyPackagedContentSecurityPolicy(indexFile) {
  let html = await readFile(indexFile, "utf8");
  const scriptHashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  if (!scriptHashes.length) throw new Error("The single-file UI contains no inline script to authorize.");
  const policy = [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
  html = html.replace(/<head>/i, match => `${match}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
  await writeFile(indexFile, html, "utf8");
}

function npmCli() {
  return process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
}

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", windowsHide: true });
    child.once("error", error => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`${label} failed with exit code ${code}.`)));
  });
}
