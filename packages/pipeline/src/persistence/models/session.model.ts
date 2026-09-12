import { Schema, model, type Types } from "mongoose";

export interface SessionDoc {
  token: string;
  userId: Types.ObjectId;
  expiresAt: Date;
  createdAt: Date;
}

const sessionSchema = new Schema<SessionDoc>({
  token: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  expiresAt: { type: Date, required: true, expires: 0 }, // MongoDB TTL index
  createdAt: { type: Date, default: Date.now },
});

export const SessionModel = model<SessionDoc>("Session", sessionSchema);