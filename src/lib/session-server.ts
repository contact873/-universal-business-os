import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db.mjs";
import { verifySession } from "@/lib/sessions.mjs";
import { SESSION_COOKIE } from "@/lib/config.mjs";

// The mjs modules are plain JavaScript, so their return types are widened. These narrow
// interfaces are the contract the pages rely on, and they fail closed: nothing is assumed true
// because it happened to be truthy.

export type Session = {
  ok: true;
  user: { id: string; email: string; name: string | null; is_platform_admin: number };
  session: { id: string };
  orgId: string | null;
  role: string | null;
};

export type NoSession = { ok: false; reason: string };

export async function currentSession(): Promise<Session | NoSession> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return { ok: false, reason: "missing" };
  return verifySession(getDb(), token) as Session | NoSession;
}

export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (!session.ok) redirect("/login");
  return session;
}

export async function requireWorkspace(): Promise<Session & { orgId: string; role: string }> {
  const session = await requireSession();
  if (!session.orgId) redirect("/app/choose");
  return { ...session, orgId: session.orgId, role: session.role ?? "viewer" };
}

export async function requirePlatformAdmin(): Promise<Session> {
  const session = await requireSession();
  if (!session.user.is_platform_admin) redirect("/app");
  return session;
}
