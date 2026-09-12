import type { NextFunction, Request, Response } from "express";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Async route wrapper — Express 5 forwards rejections anyway, this gives clearer errors. */
export function asyncH(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Express 5 params are `string | string[] | undefined` — coerce to a single string. */
export function paramStr(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== "string" || !v) throw new HttpError(400, "BAD_PARAM", `Missing request param "${name}"`);
  return v;
}

export function serializeError(err: unknown): { status: number; error: string; message?: string } {
  if (err instanceof HttpError) return { status: err.status, error: err.code, message: err.message };
  if (err instanceof Error) {
    // Mongo duplicate key -> 409
    const mongo = err as { code?: number | string };
    if (mongo.code === 11000 || mongo.code === "E11000") {
      return { status: 409, error: "DUPLICATE", message: "A record with those details already exists" };
    }
    return { status: 500, error: "INTERNAL", message: err.message };
  }
  return { status: 500, error: "INTERNAL", message: String(err) };
}