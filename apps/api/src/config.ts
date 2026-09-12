import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

// Load apps/api/.env regardless of the process cwd (cli/monorepo tooling start this
// server from repo root too).
loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export const config = {
  port: intEnv("API_PORT", 4000),
  mongodbUri: process.env.MONGODB_URI ?? "",
  sessionName: process.env.SESSION_NAME ?? "sid",
  sessionTtlMs: intEnv("SESSION_TTL_DAYS", 7) * 24 * 60 * 60 * 1000,
  isProduction: process.env.NODE_ENV === "production",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
};

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.isProduction,
  path: "/",
};

export function envBool(name: string): boolean {
  return boolEnv(name, false);
}

export function envString(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}