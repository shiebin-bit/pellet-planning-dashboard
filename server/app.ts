import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import { parseCommand } from "../src/domain/commands";
import { ApiError, badRequest } from "./errors";
import type { WorkspaceStore } from "./store";
import type { InventoryDraftRequest } from "../src/domain/inventoryTypes";
import type { SourceImportInput, SourceImportPreviewContext } from "../src/domain/sourceTypes";

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

  app.get("/api/data", asyncRoute(async (request, response) => {
    const query = new URL(request.originalUrl, "http://localhost").searchParams;
    response.json(await options.store.listSourceOrders(query));
  }));

  app.get("/api/data/imports", asyncRoute(async (_request, response) => {
    response.json(await options.store.listSourceImports());
  }));

  app.get("/api/inventory", asyncRoute(async (_request, response) => {
    response.json(await options.store.getInventory());
  }));
  app.get("/api/inventory/jobs/:id/production", asyncRoute(async (request,response)=>{
    const id=request.params.id;if(typeof id!=="string"||!id||id.length>200)throw badRequest("Invalid production card id.");
    response.json(await options.store.getJobProduction(id));
  }));

  app.get("/api/inventory/orders", asyncRoute(async (_request, response) => {
    response.json(await options.store.getInventoryOrders());
  }));

  app.get("/api/inventory/daily", asyncRoute(async (request, response) => {
    const query = new URL(request.originalUrl, "http://localhost").searchParams;
    for (const [name] of query) if (name !== "date") throw badRequest(`Inventory daily filter ${name} is not supported.`);
    if (query.getAll("date").length > 1) throw badRequest("Inventory daily date may only be supplied once.");
    const date = query.get("date") ?? undefined;
    if (date && !validDate(date)) throw badRequest("Inventory daily date must be a valid YYYY-MM-DD date.");
    response.json(await options.store.getInventoryDaily(date));
  }));

  app.get("/api/inventory/ledger", asyncRoute(async (request, response) => {
    const query = new URL(request.originalUrl, "http://localhost").searchParams;
    for (const [name] of query) if (name !== "limit" && name !== "itemId") throw badRequest(`Inventory ledger filter ${name} is not supported.`);
    const value = query.get("limit");
    const limit = value === null ? undefined : Number(value);
    if (value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(limit))) throw badRequest("Inventory ledger limit must be an integer.");
    const itemId = query.get("itemId") ?? undefined;
    if (itemId !== undefined && (!itemId.trim() || itemId.length > 200)) throw badRequest("Inventory ledger itemId is invalid.");
    response.json(await options.store.getInventoryLedger(limit, itemId));
  }));

  app.get("/api/inventory/orders/:id/journal", asyncRoute(async (request, response) => {
    const id = request.params.id;
    if (typeof id !== "string" || !id || id.length > 200) throw badRequest("Inventory order id is invalid.");
    response.json(await options.store.getInventoryOrderJournal(id));
  }));

  app.get("/api/backup", asyncRoute(async (_request, response) => {
    response.setHeader("Content-Disposition", `attachment; filename="millplan-backup-v4.json"`);
    response.json(await options.store.getPortableBackup());
  }));

  app.get("/api/backup/previous", asyncRoute(async (_request, response) => {
    const backup = await options.store.getPreviousPortableBackup();
    if (!backup) throw new ApiError(404, "PREVIOUS_BACKUP_NOT_FOUND", "No recovery backup is available.");
    response.setHeader("Content-Disposition", `attachment; filename="millplan-previous-backup-v4.json"`);
    response.json(backup);
  }));

  app.get("/api/data/:id", asyncRoute(async (request, response) => {
    const id = request.params.id;
    if (typeof id !== "string" || !id || id.length > 200) throw badRequest("Source order id is invalid.");
    const order = await options.store.getSourceOrder(id);
    if (!order) throw new ApiError(404, "SOURCE_NOT_FOUND", "Source order not found.");
    response.json(order);
  }));

  app.post(
    "/api/data/preview",
    mutationBoundary(options.allowedOrigins),
    requireJson,
    express.json({ limit: "10mb", strict: true }),
    asyncRoute(async (request, response) => {
      const parsed = sourcePreviewRequest(request.body);
      response.json(await options.store.previewSourceImport(parsed.input, parsed.context));
    }),
  );

  app.post(
    "/api/inventory/draft",
    mutationBoundary(options.allowedOrigins),
    requireJson,
    express.json({ limit: "1mb", strict: true }),
    asyncRoute(async (request, response) => {
      response.json(await options.store.previewInventoryDraft(inventoryDraftRequest(request.body)));
    }),
  );

  app.post(
    "/api/commands",
    mutationBoundary(options.allowedOrigins),
    requireJson,
    express.json({ limit: "66mb", strict: true }),
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

function sourcePreviewRequest(value: unknown): { input: SourceImportInput; context?: SourceImportPreviewContext } {
  let inputValue = value;
  let context: SourceImportPreviewContext | undefined;
  if (plainObject(value) && (Object.prototype.hasOwnProperty.call(value, "input") || Object.prototype.hasOwnProperty.call(value, "context"))) {
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes("input") || !keys.includes("context")) throw badRequest("Import preview wrapper requires only input and context.");
    inputValue = value.input;
    context = sourcePreviewContext(value.context);
  }
  const parsed = parseApiCommand({ type: "data.import", input: inputValue });
  if (parsed.type !== "data.import") throw badRequest("Import preview is invalid.");
  return { input: parsed.input, ...(context ? { context } : {}) };
}

function sourcePreviewContext(value: unknown): SourceImportPreviewContext {
  if (!plainObject(value)) throw badRequest("Import preview context must be an object.");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("includeBaseline") || !keys.includes("annotations")) throw badRequest("Import preview context requires only includeBaseline and annotations.");
  if (typeof value.includeBaseline !== "boolean") throw badRequest("Import preview includeBaseline must be boolean.");
  if (!Array.isArray(value.annotations) || value.annotations.length > 10_000) throw badRequest("Import preview annotations must contain at most 10000 rows.");
  const seen = new Set<string>();
  const annotations = value.annotations.map((entry, index) => {
    if (!plainObject(entry)) throw badRequest(`Import preview annotation ${index + 1} must be an object.`);
    const expected = ["doNo", "materialCode", "remark", "medication", "fmrOmed"];
    if (Object.keys(entry).length !== expected.length || expected.some(key => !Object.prototype.hasOwnProperty.call(entry, key))) throw badRequest(`Import preview annotation ${index + 1} has unsupported fields.`);
    const text = (name: string, max: number, required = false): string => {
      const raw = entry[name];
      if (typeof raw !== "string" || raw.length > max || (required && !raw.trim())) throw badRequest(`Import preview annotation ${index + 1} ${name} is invalid.`);
      return required ? raw.trim() : raw;
    };
    const annotation = { doNo: text("doNo", 120, true), materialCode: text("materialCode", 120, true), remark: text("remark", 1_000), medication: text("medication", 200), fmrOmed: text("fmrOmed", 200) };
    const key = `${annotation.doNo.toLocaleUpperCase("en-US")}\u0000${annotation.materialCode.toLocaleUpperCase("en-US")}`;
    if (seen.has(key)) throw badRequest(`Import preview annotation ${index + 1} duplicates an order.`);
    seen.add(key);
    return annotation;
  });
  return { includeBaseline: value.includeBaseline, annotations };
}

function inventoryDraftRequest(value: unknown): InventoryDraftRequest {
  if (!plainObject(value)) throw badRequest("Inventory draft request must be a JSON object.");
  const allowed = new Set(["fromDate", "toDate", "sourceOrderIds", "demandThrough", "combineSameProduct"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw badRequest(`Inventory draft field ${key} is not supported.`);
  if (!validDate(value.fromDate) || !validDate(value.toDate)) throw badRequest("Inventory draft dates must be valid YYYY-MM-DD dates.");
  if ((value.fromDate as string) > (value.toDate as string)) throw badRequest("Inventory draft fromDate cannot be after toDate.");
  const days = Math.round((Date.parse(`${value.toDate}T12:00:00Z`) - Date.parse(`${value.fromDate}T12:00:00Z`)) / 86_400_000) + 1;
  if (days > 31) throw badRequest("Inventory drafts may span at most 31 days.");
  const result: InventoryDraftRequest = { fromDate: value.fromDate as string, toDate: value.toDate as string };
  if(value.demandThrough!==undefined){if(!validDate(value.demandThrough))throw badRequest("Order demand cutoff must be a valid date.");result.demandThrough=value.demandThrough as string;}
  if (value.combineSameProduct !== undefined) {
    if (typeof value.combineSameProduct !== "boolean") throw badRequest("combineSameProduct must be true or false.");
    result.combineSameProduct = value.combineSameProduct;
  }
  if (Object.prototype.hasOwnProperty.call(value, "sourceOrderIds")) {
    if (!Array.isArray(value.sourceOrderIds) || value.sourceOrderIds.length > 2_000) throw badRequest("sourceOrderIds must be an array of 2000 items or fewer.");
    const ids = value.sourceOrderIds.map((id, index) => {
      if (typeof id !== "string" || !id.trim() || id.length > 200) throw badRequest(`sourceOrderIds[${index}] is invalid.`);
      return id;
    });
    if (new Set(ids).size !== ids.length) throw badRequest("sourceOrderIds cannot contain duplicates.");
    result.sourceOrderIds = ids;
  }
  return result;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
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

const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const requestId = String(response.locals.requestId ?? "unknown");
  let apiError: ApiError;
  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof SyntaxError && "status" in error && error.status === 400) {
    apiError = badRequest("Request body contains malformed JSON.", "MALFORMED_JSON");
  } else if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
    const limit = request.path === "/api/commands" ? "66 MB" : "10 MB";
    apiError = new ApiError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds the ${limit} limit.`);
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
