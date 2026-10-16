import { fileURLToPath } from "node:url";

export interface ServerConfig {
  host: string;
  port: number;
  hostPorts: ReadonlySet<number>;
  databaseUrl: string;
  distDir: string;
  allowedOrigins: ReadonlySet<string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = integer(env.PORT ?? "8080", "PORT", 1, 65_535);
  const publicPort = integer(env.PUBLIC_PORT ?? String(port), "PUBLIC_PORT", 1, 65_535);
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const hostPorts = new Set([port, publicPort]);
  const defaults = [...hostPorts].flatMap(candidate => [
    `http://localhost:${candidate}`,
    `http://127.0.0.1:${candidate}`,
    `http://[::1]:${candidate}`,
  ]);
  const configured = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const allowedOrigins = new Set([...defaults, ...configured].map(normalizeOrigin));
  return {
    host,
    port,
    hostPorts,
    databaseUrl,
    distDir: env.DIST_DIR?.trim() || fileURLToPath(new URL("../dist", import.meta.url)),
    allowedOrigins,
  };
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error(`Invalid ALLOWED_ORIGINS entry: ${JSON.stringify(value)}.`);
  }
}

function integer(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return parsed;
}
