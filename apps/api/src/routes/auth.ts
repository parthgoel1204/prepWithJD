import { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  createUser,
  createSession,
  deleteSession,
  findUserByEmail,
  findUserById,
} from "@prepwithjd/pipeline";
import { config, cookieOptions } from "../config";
import { asyncH, HttpError } from "../lib/http";
import { requireAuth } from "../middleware/auth";

const registerSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  email: z.string().trim().toLowerCase().email("a valid email is required"),
  password: z.string().min(8, "password must be at least 8 characters").max(100),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("a valid email is required"),
  password: z.string().min(1, "password is required"),
});

function setSessionCookie(res: Response, token: string): void {
  res.cookie(config.sessionName, token, { ...cookieOptions, maxAge: config.sessionTtlMs });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(config.sessionName, { path: "/" });
}

export const authRouter = Router();

authRouter.post(
  "/register",
  asyncH(async (req: Request, res: Response) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION", parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { name, email, password } = parsed.data;

    if (await findUserByEmail(email)) throw new HttpError(409, "EMAIL_TAKEN", "An account with that email already exists");

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser(name, email, passwordHash);

    const token = randomBytes(32).toString("hex");
    await createSession(user._id, token, config.sessionTtlMs);
    setSessionCookie(res, token);

    res.status(201).json({ user: user.toJSON() });
  }),
);

authRouter.post(
  "/login",
  asyncH(async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION", parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { email, password } = parsed.data;

    const user = await findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new HttpError(401, "BAD_CREDENTIALS", "Email or password is incorrect");
    }

    const token = randomBytes(32).toString("hex");
    await createSession(user._id, token, config.sessionTtlMs);
    setSessionCookie(res, token);

    res.json({ user: user.toJSON() });
  }),
);

authRouter.post(
  "/logout",
  asyncH(async (req: Request, res: Response) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[config.sessionName];
    if (token) await deleteSession(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncH(async (req: Request, res: Response) => {
    const user = req.user ? await findUserById(req.user._id) : null;
    if (!user) throw new HttpError(401, "SESSION_INVALID", "Session invalid");
    res.json({ user: user.toJSON() });
  }),
);