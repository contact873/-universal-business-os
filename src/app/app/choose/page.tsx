import { requireSession } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";
import { membershipsFor } from "@/lib/types";
import { switchWorkspaceAction } from "@/app/actions";

export default async function ChooseWorkspace({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await requireSession();
  const memberships = membershipsFor(getDb(), session.user.id);

  return (
    <div className="wrap">
      <div className="narrow">
        <h1>Choose a workspace</h1>
        <p className="lede">
          You belong to more than one business on this platform. Only the one you pick is loaded,
          and each is stored separately from the others.
        </p>

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        {memberships.length === 0 ? (
          <p className="notice">
            You do not belong to a workspace yet. An owner or admin has to invite you.
          </p>
        ) : (
          memberships.map((membership) => (
            <form action={switchWorkspaceAction} key={membership.orgId} style={{ marginBottom: "var(--s3)" }}>
              <input type="hidden" name="orgId" value={membership.orgId} />
              <button type="submit" className="btn-ghost" style={{ width: "100%", textAlign: "left" }}>
                {membership.name} <span className="muted small">as {membership.role}</span>
              </button>
            </form>
          ))
        )}
      </div>
    </div>
  );
}
