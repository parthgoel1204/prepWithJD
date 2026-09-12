import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "prepWithJD — Interview Prep Kit",
  description: "Research a company and generate a structured interview-prep kit from a job description.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}