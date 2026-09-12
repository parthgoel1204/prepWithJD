"use client";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * fetch wrapper: JSON body, same-origin /api proxy. On 401 (session expired/invalid)
 * it redirects to /login instead of crashing, then throws so callers can stop.
 */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body) headers.set("Content-Type", "application/json");

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    // Full reload clears any stale client state before re-login.
    if (typeof window !== "undefined") {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard redirect on session expiry
      window.location.assign("/login");
    }
    throw new ApiError("Your session has expired — please log in again.", 401);
  }

  const data = (await res.json().catch(() => null)) as T & { error?: string; message?: string } | null;
  if (!res.ok) {
    throw new ApiError(data?.message ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}