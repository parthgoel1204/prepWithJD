import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { connectDb, disconnectDb, deleteExpiredSessions, mongoReadyState } from "@prepwithjd/pipeline";
import { config } from "./config";
import { authRouter } from "./routes/auth";
import { kitsRouter } from "./routes/kits";
import { jdRouter } from "./routes/jd";
import { serializeError } from "./lib/http";

console.log("[api] starting up...");

const MONGO_ATTEMPTS = 5;
const MONGO_RETRY_DELAY_MS = 3000;

const DB_STATE_LABELS: Record<number, string> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

/**
 * Atlas DNS (SRV) resolution can blip at startup ("querySrv EREFUSED"),
 * which previously killed npm run dev with process.exit(1) after a single
 * failed attempt. Retry the initial connect so a transient resolver hiccup
 * doesn't take the whole stack down. Every retry is logged explicitly so a
 * hang or repeated failure is visible in Render's log tail rather than silent.
 */
async function connectWithRetry(): Promise<void> {
  for (let i = 1; i <= MONGO_ATTEMPTS; i++) {
    try {
      await connectDb(config.mongodbUri);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === MONGO_ATTEMPTS) throw err;
      console.error(`[api] MongoDB connection attempt ${i}/${MONGO_ATTEMPTS} failed: ${msg}, retrying in ${MONGO_RETRY_DELAY_MS}ms`);
      await new Promise((r) => setTimeout(r, MONGO_RETRY_DELAY_MS));
    }
  }
}

async function main(): Promise<void> {
  console.log("[api] connecting to MongoDB...");
  try {
    await connectWithRetry();
  } catch (err) {
    console.error(`[api] FATAL: could not connect to MongoDB after ${MONGO_ATTEMPTS} attempts, exiting`);
    process.exit(1);
  }
  console.log("[api] MongoDB connected");
  await deleteExpiredSessions();

  const app = express();
  app.disable("x-powered-by");

  // Cross-origin browser access: Vercel frontend (production) + localhost:3000 (local dev).
  // Trailing-slash-insensitive exact match; credentials require an explicit origin (never "*").
  const allowedOrigins = [
    "https://prep-with-jd-web.vercel.app",
    "http://localhost:3000",
  ];
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    }),
  );

  app.use(express.json({ limit: "4mb" }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    const ready = mongoReadyState();
    const ok = ready === 1;
    res.status(ok ? 200 : 503).json({
      ok,
      db: DB_STATE_LABELS[ready] ?? "unknown",
      readyState: ready,
      uptime_ms: Math.round(process.uptime() * 1000),
    });
  });
  app.use("/api/auth", authRouter);
  app.use("/api/kits", kitsRouter);
  app.use("/api/jd", jdRouter);

  app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND", message: "Route not found" }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, error, message } = serializeError(err);
    console.error("[api:error]", error, message);
    res.status(status).json({ error, message });
  });

  app.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
  });
}

const shutdown = async (): Promise<void> => {
  await disconnectDb();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[api] failed to start:", err.message);
  process.exit(1);
});