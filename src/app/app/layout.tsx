import Link from "next/link";
import { requireWorkspace } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await requireWorkspace();

  const org = getDb()
    .prepare("select name, slug, industry from organizations where id = ?")
    .get(session.orgId) as { name: string; slug: string; industry: string | null } | undefined;

  return (
    <>
      <section className="wrap" style={{ paddingBottom: "var(--s5)" }}>
        <p className="eyebrow" style={{ marginBottom: "var(--s2)" }}>
          {org?.industry ?? "workspace"} · your role: {session.role}
        </p>
        <h1 style={{ fontSize: "clamp(1.6rem, 3vw, 2.2rem)" }}>{org?.name ?? "Workspace"}</h1>
        <nav className="nav" aria-label="Workspace">
          <Link href="/app">Overview</Link>
          <Link href="/app/contacts">Contacts</Link>
          <Link href="/app/leads">Leads</Link>
          <Link href="/app/settings">Settings</Link>
        </nav>
      </section>
      {children}
    </>
  );
}
