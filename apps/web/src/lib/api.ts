"use client";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}

/** Session-related 401 codes the API returns on protected routes. */
const SESSION_401_CODES = ["SESSION_EXPIRED", "SESSION_INVALID", "UNAUTHENTICATED"];

/**
 * fetch wrapper: JSON body, same-origin /api proxy.
 *
 * 401s are NOT all the same failure:
 *  - `/api/auth/*` (login/register): never redirect — surface the server message inline
 *    (e.g. "Invalid email or password").
 *  - protected routes with a session-related 401 (expired/invalid/unauthenticated):
 *    hard-redirect to /login with ?reason=session_expired so the login page can show it.
 */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body) headers.set("Content-Type", "application/json");

  const res = await fetch(path, { ...options, headers });
  const data = (await res.json().catch(() => null)) as (T & ApiErrorBody) | null;

  if (res.status === 401) {
    const code = data?.error ?? "";
    // Login/register flows handle their own 401s inline — never hijack them.
    if (!path.startsWith("/api/auth/") && SESSION_401_CODES.includes(code)) {
      // Full reload clears any stale client state before re-login.
      if (typeof window !== "undefined") {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard redirect on session expiry
        window.location.assign("/login?reason=session_expired");
      }
      throw new ApiError("Session expired, please log in again", 401);
    }
    throw new ApiError(data?.message ?? `Request failed (${res.status})`, res.status);
  }

  if (!res.ok) {
    throw new ApiError(data?.message ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}