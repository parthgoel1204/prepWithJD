import { Suspense } from "react";
import AuthForm from "@/components/auth-form";

export default function RegisterPage() {
  return (
    <main className="min-h-screen px-4">
      <Suspense fallback={null}>
        <AuthForm mode="register" />
      </Suspense>
    </main>
  );
}