import { Schema, model, type Types } from "mongoose";
import type { RetrievalStage } from "../../types";

/** Terminal record of a per-source retrieval failure (log-and-continue, never abort). */
export interface SourceFailureDoc {
  userId: Types.ObjectId;
  kitId?: Types.ObjectId;
  sourceUrl: string;
  stage: RetrievalStage;
  code: string;
  message: string;
  attempt?: number;
  createdAt: Date;
}

const sourceFailureSchema = new Schema<SourceFailureDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kitId: { type: Schema.Types.ObjectId, ref: "Kit", index: true },
    sourceUrl: { type: String, required: true },
    stage: { type: String, enum: ["fetch", "robots", "search", "validate"], required: true },
    code: { type: String, required: true },
    message: { type: String, default: "" },
    attempt: { type: Number },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const SourceFailureModel = model<SourceFailureDoc>("SourceFailure", sourceFailureSchema);