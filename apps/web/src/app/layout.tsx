import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "prepWithJD — Interview Prep Kit",
  description: "Research a company and generate a structured interview-prep kit from a job description.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${GeistSans.variable} ${GeistMono.variable} min-h-screen bg-zinc-50 text-zinc-900 antialiased`}>
        {children}
      </body>
    </html>
  );
}