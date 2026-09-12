import { Schema, model } from "mongoose";

export interface UserDoc {
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true },
);

userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as { passwordHash?: string; __v?: unknown };
    delete out.passwordHash;
    delete out.__v;
    return ret;
  },
});

export const UserModel = model<UserDoc>("User", userSchema);