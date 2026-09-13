import type { NextFunction, Request, Response } from "express";
import type { Types } from "mongoose";
import { findSession, findUserById, deleteSession, UserModel } from "@prepwithjd/pipeline";
import { config } from "../config";

type AuthedUser = InstanceType<typeof UserModel>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sessionId?: string;
      userId?: Types.ObjectId | string;
      user?: AuthedUser;
    }
  }
}

/**
 * Blocks unauthenticated requests. Handles expired/invalid sessions gracefully: the
 * session is dropped and the client gets a 401 JSON it can redirect on.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = (req.cookies as Record<string, string> | undefined)?.[config.sessionName];
  if (!token) {
    res.status(401).json({ error: "UNAUTHENTICATED", message: "Log in to continue" });
    return;
  }

  const session = await findSession(token);
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    // Two failure modes, one outcome: token not found in sessions collection, OR its
    // expiresAt passed. Both mean "this session is dead" -> delete it and answer
    // SESSION_EXPIRED. Distinct from login's BAD_CREDENTIALS by design.
    if (session && session.expiresAt.getTime() <= Date.now()) await deleteSession(token);
    res.clearCookie(config.sessionName, { path: "/" });
    res.status(401).json({ error: "SESSION_EXPIRED", message: "Session expired, please log in again" });
    return;
  }

  const user = await findUserById(session.userId);
  if (!user) {
    await deleteSession(token);
    res.status(401).json({ error: "SESSION_INVALID", message: "Session references a deleted account" });
    return;
  }

  req.sessionId = token;
  req.userId = session.userId;
  req.user = user;
  next();
}