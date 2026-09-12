import AuthForm from "@/components/auth-form";

export default function LoginPage() {
  return (
    <main className="min-h-screen px-4">
      <AuthForm mode="login" />
    </main>
  );
}