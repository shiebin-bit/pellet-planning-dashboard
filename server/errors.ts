import type { WorkspaceEnvelope } from "../src/domain/commands";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly workspace?: WorkspaceEnvelope,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(message: string, code = "INVALID_REQUEST"): ApiError {
  return new ApiError(400, code, message);
}
