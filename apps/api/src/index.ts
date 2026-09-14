import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import { connectDb, disconnectDb, deleteExpiredSessions } from "@prepwithjd/pipeline";
import { config } from "./config";
import { authRouter } from "./routes/auth";
import { kitsRouter } from "./routes/kits";
import { serializeError } from "./lib/http";

/**
 * Atlas DNS (SRV) resolution can blip at startup ("querySrv EREFUSED"),
 * which previously killed npm run dev with process.exit(1) after a single
 * failed attempt. Retry the initial connect so a transient resolver hiccup
 * doesn't take the whole stack down.
 */
async function connectWithRetry(attempts = 5, delayMs = 3000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await connectDb(config.mongodbUri);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === attempts) throw err;
      console.error(`[api] mongo connect attempt ${i}/${attempts} failed (${msg}) — retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main(): Promise<void> {
  await connectWithRetry();
  await deleteExpiredSessions();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);
  app.use("/api/kits", kitsRouter);

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