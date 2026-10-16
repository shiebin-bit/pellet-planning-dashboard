import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import { parseCommand } from "../src/domain/commands";
import { ApiError, badRequest } from "./errors";
import type { WorkspaceStore } from "./store";

export interface AppOptions {
  store: WorkspaceStore;
  hostPorts: ReadonlySet<number>;
  distDir: string;
  allowedOrigins: ReadonlySet<string>;
}

export function createApp(options: AppOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const requestId = randomUUID();
    response.locals.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);
    if (!allowedHost(request.headers.host, options.hostPorts)) {
      next(new ApiError(400, "INVALID_HOST", "The request Host is not allowed."));
      return;
    }
    if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", asyncRoute(async (_request, response) => {
    await options.store.health();
    response.json({ status: "ok" });
  }));

  app.get("/api/workspace", asyncRoute(async (_request, response) => {
    response.json(await options.store.getWorkspace());
  }));

  app.post(
    "/api/commands",
    mutationBoundary(options.allowedOrigins),
    requireJson,
    express.json({ limit: "10mb", strict: true }),
    asyncRoute(async (request, response) => {
      const body = commandRequest(request.body);
      const command = parseApiCommand(body.command);
      response.json(await options.store.execute(body.expectedRevision, body.commandId, command));
    }),
  );

  app.use("/api", (_request, _response, next) => next(new ApiError(404, "NOT_FOUND", "API endpoint not found.")));

  if (existsSync(options.distDir)) {
    app.use(express.static(options.distDir, { index: false, fallthrough: true }));
    app.get("/{*path}", (_request, response, next) => {
      response.sendFile(path.join(options.distDir, "index.html"), error => { if (error) next(error); });
    });
  }

  app.use(errorHandler);
  return app;
}

function mutationBoundary(allowedOrigins: ReadonlySet<string>) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const fetchSite = request.get("Sec-Fetch-Site")?.toLowerCase();
    if (fetchSite === "cross-site") {
      next(new ApiError(403, "CROSS_SITE_REQUEST", "Cross-site mutations are not allowed."));
      return;
    }
    const origin = request.get("Origin");
    if (origin) {
      let normalized: string;
      try { normalized = new URL(origin).origin; } catch {
        next(new ApiError(403, "INVALID_ORIGIN", "The request Origin is not allowed."));
        return;
      }
      if (normalized !== origin || !allowedOrigins.has(normalized)) {
        next(new ApiError(403, "INVALID_ORIGIN", "The request Origin is not allowed."));
        return;
      }
    }
    next();
  };
}

function requireJson(request: Request, _response: Response, next: NextFunction): void {
  if (!request.is("application/json")) {
    next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json."));
    return;
  }
  next();
}

function commandRequest(value: unknown): { expectedRevision: number; commandId: string; command: unknown } {
  if (!plainObject(value)) throw badRequest("Request body must be a JSON object.");
  const allowed = new Set(["expectedRevision", "commandId", "command"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw badRequest(`Request field ${key} is not supported.`);
  for (const key of allowed) if (!Object.prototype.hasOwnProperty.call(value, key)) throw badRequest(`Request field ${key} is required.`);
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    throw badRequest("expectedRevision must be a non-negative safe integer.");
  }
  if (typeof value.commandId !== "string" || !value.commandId.trim() || value.commandId.length > 200) {
    throw badRequest("commandId must be nonblank text of 200 characters or fewer.");
  }
  return { expectedRevision: value.expectedRevision as number, commandId: value.commandId, command: value.command };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowedHost(hostHeader: string | undefined, ports: ReadonlySet<number>): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.toLowerCase();
  return [...ports].some(port => value === `localhost:${port}` || value === `127.0.0.1:${port}` || value === `[::1]:${port}`);
}

function parseApiCommand(value: unknown) {
  try { return parseCommand(value); }
  catch (error) {
    throw badRequest(error instanceof Error ? error.message : "Command is invalid.", "INVALID_COMMAND");
  }
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const requestId = String(response.locals.requestId ?? "unknown");
  let apiError: ApiError;
  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof SyntaxError && "status" in error && error.status === 400) {
    apiError = badRequest("Request body contains malformed JSON.", "MALFORMED_JSON");
  } else if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
    apiError = new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the 10 MB limit.");
  } else if (isDatabaseUnavailable(error)) {
    apiError = new ApiError(503, "DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");
  } else {
    process.stderr.write(`[${requestId}] Internal server error.\n`);
    apiError = new ApiError(500, "INTERNAL_ERROR", "The server could not complete the request.");
  }
  response.status(apiError.status).json({
    error: { code: apiError.code, message: apiError.message, requestId },
    ...(apiError.workspace ? { workspace: apiError.workspace } : {}),
  });
};

function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (code.startsWith("08") || code.startsWith("57P0") || [
    "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "57014",
  ].includes(code)) return true;
  return error instanceof Error && /timeout exceeded when trying to connect|connection terminated (unexpectedly|due to connection timeout)/i.test(error.message);
}
