import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "sid";
const AUTH_ROUTES = ["/login", "/register"];

/**
 * Cheap first-line guard: redirect unauthenticated users away from protected pages.
 * Real session validation (expired/invalid tokens) happens in the API, which returns
 * 401 and the client redirects to /login — graceful, never a crash.
 *
 * Only the cookie's presence is checked here (proxy runtime has no Mongo access).
 * Next 16: this file is the renamed middleware convention (proxy.ts).
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has(SESSION_COOKIE);
  const isAuthRoute = AUTH_ROUTES.includes(pathname);

  if (pathname === "/") {
    return NextResponse.redirect(new URL(hasSession ? "/dashboard" : "/login", req.url));
  }

  if (isAuthRoute && hasSession) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (!hasSession && !isAuthRoute) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};