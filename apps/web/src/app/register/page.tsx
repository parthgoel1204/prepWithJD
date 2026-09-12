import AuthForm from "@/components/auth-form";

export default function RegisterPage() {
  return (
    <main className="min-h-screen px-4">
      <AuthForm mode="register" />
    </main>
  );
}