import mongoose from "mongoose";

const DEFAULT_URI = process.env.MONGODB_URI ?? "";

export async function connectDb(uri = DEFAULT_URI): Promise<void> {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  if (!uri) throw new Error("MONGODB_URI is not set — copy apps/api/.env.example to apps/api/.env and add your Atlas connection string");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  mongoose.connection.on("error", (err) => console.error("[mongo]", err.message));
}

export async function disconnectDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

export function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}