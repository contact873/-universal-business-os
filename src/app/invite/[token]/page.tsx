import Link from "next/link";
import { getDb } from "@/lib/db.mjs";
import { findInvitationByToken } from "@/lib/types";
import { currentSession } from "@/lib/session-server";
import { acceptInvitationAction } from "@/app/actions";
import { normalizeEmail } from "@/lib/identities.mjs";

export const dynamic = "force-dynamic";

/**
 * Accepting an invitation.
 *
 * Deliberately reachable with no session: the person being invited usually has no account, which is
 * the reason they were invited rather than added. Every dead end here says which dead end it is,
 * because "invalid link" covers four different situations and only one of them is the visitor's
 * fault.
 */
export default async function AcceptInvitation({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;

  const db = getDb();
  const found = findInvitationByToken(db, token);
  const session = await currentSession();
  const signedInAs = session.ok ? session.user.email : null;

  const shell = (title: string, body: React.ReactNode) => (
    <section className="wrap narrow">
      <div className="card">
        <span className="eyebrow">Invitation</span>
        <h1>{title}</h1>
        {body}
      </div>
    </section>
  );

  if (!found.ok) {
    return shell(
      "That link is not an invitation",
      <>
        <p className="lede">
          It may have been mistyped, or it may belong to a workspace that no longer exists. Ask
          whoever invited you to send it again.
        </p>
        <p className="small muted">
          Already have an account? <Link href="/login">Sign in</Link>.
        </p>
      </>,
    );
  }

  if (found.acceptedAt) {
    return shell(
      "That invitation has been used",
      <>
        <p className="lede">
          Somebody already accepted the invitation to {found.organizationName} with this link.
        </p>
        <p className="small muted">
          If that was you, <Link href="/login">sign in</Link> and the workspace will be there.
        </p>
      </>,
    );
  }

  if (found.expired) {
    return shell(
      "That invitation has expired",
      <>
        <p className="lede">
          Invitations to {found.organizationName} last seven days. This one has run out, which is a
          limit and not a mistake on your part.
        </p>
        <p className="small muted">Ask whoever invited you to send a new one.</p>
      </>,
    );
  }

  if (signedInAs && normalizeEmail(signedInAs) !== normalizeEmail(found.email as string)) {
    return shell(
      "That invitation is for a different address",
      <>
        <p className="lede">
          This invitation is for <strong>{found.email}</strong>, and you are signed in as{" "}
          <strong>{signedInAs}</strong>.
        </p>
        <p className="small muted">
          Sign out and open this link again, or ask for an invitation to your own address.
        </p>
      </>,
    );
  }

  const existingUser = db
    .prepare("select id from users where email = ?")
    .get(normalizeEmail(found.email as string));
  const canCreate = !signedInAs && !existingUser;

  return (
    <section className="wrap narrow">
      <div className="card">
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        <span className="eyebrow">Invitation</span>
        <h1>
          Join <em>{found.organizationName}</em>
        </h1>
        <p className="lede">
          {found.email} has been invited as <strong>{found.role}</strong>. Accepting adds this
          workspace to your account; it does not create a separate login.
        </p>

        {canCreate ? (
          <form action={acceptInvitationAction} style={{ marginTop: "var(--s5)" }}>
            <input type="hidden" name="token" value={token} />
            <div className="field">
              <label htmlFor="i-name">Your name</label>
              <input id="i-name" name="name" maxLength={80} autoComplete="name" />
            </div>
            <div className="field">
              <label htmlFor="i-password">Choose a password</label>
              <input
                id="i-password"
                name="password"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
              />
              <p className="small muted" style={{ margin: "var(--s2) 0 0" }}>
                At least 10 characters. Stored as a scrypt hash, never in the clear.
              </p>
            </div>
            <p className="small muted">
              Your account address will be <strong>{found.email}</strong>.
            </p>
            <button className="accent" type="submit">
              Create my account and join
            </button>
          </form>
        ) : null}

        {!canCreate && !signedInAs ? (
          <>
            <p className="lede">
              An account already exists for {found.email}. Sign in as that address, then open this
              link again.
            </p>
            <p>
              <Link className="btn btn-accent" href="/login">
                Sign in
              </Link>
            </p>
          </>
        ) : null}

        {signedInAs ? (
          <form action={acceptInvitationAction} style={{ marginTop: "var(--s5)" }}>
            <input type="hidden" name="token" value={token} />
            <p className="small muted">
              Signed in as <strong>{signedInAs}</strong>. That matches the invitation, so accepting
              will add {found.organizationName} to your account.
            </p>
            <button className="accent" type="submit">
              Join {found.organizationName}
            </button>
          </form>
        ) : null}

        <p className="small muted" style={{ marginTop: "var(--s5)" }}>
          If you were not expecting this, close the page and nothing happens.
        </p>
      </div>
    </section>
  );
}
