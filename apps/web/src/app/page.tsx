// Root page is normally never rendered — middleware.ts redirects "/" to
// /login or /dashboard based on session-cookie presence.
export default function Home() {
  return null;
}