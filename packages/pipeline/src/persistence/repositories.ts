import type { Types } from "mongoose";
import type { KitContent, KitInput, KitStatus, RetrievalFailure } from "../types";
import { SessionModel, type SessionDoc } from "./models/session.model";
import { UserModel, type UserDoc } from "./models/user.model";
import { KitModel } from "./models/kit.model";
import { SourceFailureModel } from "./models/sourceFailure.model";
import { companyNameFromUrl } from "../lib/util";

type HydratedUser = InstanceType<typeof UserModel>;

// ---------- users ----------
export async function findUserByEmail(email: string): Promise<HydratedUser | null> {
  return UserModel.findOne({ email: email.toLowerCase() });
}

export async function findUserById(id: Types.ObjectId | string): Promise<HydratedUser | null> {
  return UserModel.findById(id);
}

export async function createUser(name: string, email: string, passwordHash: string): Promise<HydratedUser> {
  return UserModel.create({ name, email: email.toLowerCase(), passwordHash });
}

// ---------- sessions ----------
export async function createSession(userId: Types.ObjectId, token: string, ttlMs: number): Promise<SessionDoc> {
  return SessionModel.create({ token, userId, expiresAt: new Date(Date.now() + ttlMs) });
}

export async function findSession(token: string): Promise<SessionDoc | null> {
  return SessionModel.findOne({ token });
}

export async function deleteSession(token: string): Promise<void> {
  await SessionModel.deleteOne({ token });
}

/** Cleanup pass for expired sessions (defence-in-depth; TTL index already handles it). */
export async function deleteExpiredSessions(): Promise<void> {
  await SessionModel.deleteMany({ expiresAt: { $lte: new Date() } });
}

// ---------- kits ----------
export interface KitCreateInput extends KitInput {
  userId: Types.ObjectId;
}

export async function createKit(input: KitCreateInput): Promise<KitModelInstance> {
  return KitModel.create({
    userId: input.userId,
    status: "draft",
    input: {
      jd: input.jd,
      company_url: input.company_url,
      days: input.days,
      file_name: input.file_name ?? "",
    },
    content: {
      source: {
        company: companyNameFromUrl(input.company_url),
        company_url: input.company_url,
        jd_chars: input.jd.length,
        researched_at: "",
      },
    },
  });
}

export type KitModelInstance = InstanceType<typeof KitModel>;

export function listKits(userId: Types.ObjectId | string): Promise<KitModelInstance[]> {
  return KitModel.find({ userId })
    .sort({ createdAt: -1 })
    .limit(100)
    .select("_id status input content.source createdAt updatedAt")
    .lean()
    .exec() as Promise<KitModelInstance[]>;
}

export async function findKitById(id: string): Promise<KitModelInstance | null> {
  return KitModel.findById(id).lean() as Promise<KitModelInstance | null>;
}

export async function updateKitStatus(id: string, status: KitStatus): Promise<void> {
  await KitModel.updateOne({ _id: id }, { $set: { status } });
}

export async function deleteKit(id: string): Promise<boolean> {
  const res = await KitModel.deleteOne({ _id: id });
  return res.deletedCount > 0;
}

export async function persistRetrieval(kitId: string, content: KitContent): Promise<void> {
  await KitModel.updateOne({ _id: kitId }, { $set: { status: "retrieved", content } });
}

export async function persistFailedKit(id: string, error: string): Promise<void> {
  await KitModel.updateOne({ _id: id }, { $set: { status: "failed" } });
  await KitModel.updateOne({ _id: id }, { $push: { errorLog: error } });
}

// ---------- source failures (log-and-continue records) ----------
export async function recordSourceFailures(
  userId: Types.ObjectId | string,
  kitId: string | null,
  failures: RetrievalFailure[],
): Promise<void> {
  if (!failures.length) return;
  const docs = failures.map((f) => ({
    userId,
    kitId: kitId ?? undefined,
    sourceUrl: f.source_url,
    stage: f.stage,
    code: f.code,
    message: f.message,
    attempt: f.attempt,
  }));
  await SourceFailureModel.insertMany(docs);
}

export async function listSourceFailures(kitId: string | null, userId: Types.ObjectId | string, limit = 50) {
  const filter: Record<string, unknown> = { userId };
  if (kitId) filter.kitId = kitId;
  return SourceFailureModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean().exec();
}