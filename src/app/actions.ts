"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db.mjs";
import { SESSION_COOKIE } from "@/lib/config.mjs";
import { LEAD_STAGES } from "@/lib/tenant.mjs";
import { assertCan } from "@/lib/roles.mjs";
import { writeAudit } from "@/lib/audit.mjs";
import { id as newId, nowIso } from "@/lib/identities.mjs";
import { requireWorkspace, currentSession } from "@/lib/session-server";
import {
  tenantStore,
  createUser,
  authenticate,
  createOrganization,
  membershipsFor,
  createSession,
  revokeSession,
  switchOrg,
  withinLimit,
} from "@/lib/types";

// A "use server" module may export async functions and nothing else, so constants and helpers
// live in their own modules rather than being re-exported from here.

const db = () => getDb();

async function setSessionCookie(token: string, expiresAt: string) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
}

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

function message(text: string): string {
  return encodeURIComponent(text.slice(0, 200));
}

export async function signUpAction(form: FormData) {
  const email = field(form, "email");
  const password = field(form, "password");
  const name = field(form, "name");
  const company = field(form, "company");
  const industry = field(form, "industry") || null;

  let userId: string;
  try {
    ({ userId } = createUser(db(), { email, password, name }));
  } catch (error) {
    redirect(`/signup?error=${message((error as Error).message)}`);
  }

  try {
    const { orgId } = createOrganization(db(), {
      name: company,
      industry,
      ownerUserId: userId,
      plan: "starter",
      defaultCountry: field(form, "country") || null,
    });
    const { token, expiresAt } = createSession(db(), { userId, orgId });
    await setSessionCookie(token, expiresAt);
  } catch (error) {
    redirect(`/signup?error=${message((error as Error).message)}`);
  }

  redirect("/app");
}

export async function signInAction(form: FormData) {
  const email = field(form, "email");
  const password = field(form, "password");

  const result = authenticate(db(), email, password);
  if (!result.ok || !result.user) {
    // One message for a wrong email and a wrong password: telling them apart confirms which
    // addresses have accounts.
    redirect("/login?error=That%20email%20and%20password%20do%20not%20match%20an%20account.");
  }

  const memberships = membershipsFor(db(), result.user.id);
  const orgId = memberships.length === 1 ? memberships[0].orgId : null;
  const { token, expiresAt } = createSession(db(), { userId: result.user.id, orgId });

  await setSessionCookie(token, expiresAt);
  redirect(orgId ? "/app" : memberships.length ? "/app/choose" : "/app");
}

export async function signOutAction() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) revokeSession(db(), token);
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

export async function switchWorkspaceAction(form: FormData) {
  const session = await currentSession();
  if (!session.ok) redirect("/login");

  const orgId = field(form, "orgId");
  const result = switchOrg(db(), session.session.id, orgId);
  if (!result.ok) redirect("/app/choose?error=You%20are%20not%20a%20member%20of%20that%20workspace.");

  redirect("/app");
}

export async function createContactAction(form: FormData) {
  const session = await requireWorkspace();
  try {
    assertCan(session.role, "contact:write");
  } catch {
    redirect(`/app/contacts?error=${message("Your role cannot add contacts.")}`);
  }

  // The plan limit is checked here, on the server, because hiding the form is not enforcement:
  // anybody with a session can post to this action directly.
  const limit = withinLimit(db(), session.orgId, "contacts");
  if (!limit.allowed) {
    const explain =
      limit.reason === "not_entitled"
        ? "This workspace has no plan that includes contacts."
        : `This plan allows ${limit.limit} contacts and the workspace has ${limit.current}.`;
    redirect(`/app/contacts?error=${message(`${explain} Choose a plan to add more.`)}`);
  }

  const name = field(form, "name");
  const email = field(form, "email");
  const mobile = field(form, "mobile");
  const telephone = field(form, "telephone");
  const tags = field(form, "tags")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const result = tenantStore().capture(
    session.orgId,
    { name, email, mobile, telephone, message: field(form, "notes") },
    { source: "manual", tags, actorUserId: session.user.id, defaultCountry: "+971" },
  );

  if (!result.ok) {
    redirect(`/app/contacts?error=${message("Add an email or a phone number.")}`);
  }

  redirect(`/app/contacts?created=${result.contactId}`);
}

export async function moveStageAction(form: FormData) {
  const session = await requireWorkspace();
  const leadId = field(form, "leadId");
  const stage = field(form, "stage");

  if (!LEAD_STAGES.includes(stage)) {
    redirect(`/app/leads?error=${message("Unknown stage.")}`);
  }

  try {
    const changed = tenantStore().updateLeadStage(session.orgId, leadId, stage, {
      role: session.role,
      actorUserId: session.user.id,
    });
    if (!changed) {
      redirect(`/app/leads?error=${message("That lead was not found in this workspace.")}`);
    }
  } catch (error) {
    redirect(`/app/leads?error=${message((error as Error).message)}`);
  }

  redirect("/app/leads");
}

export async function addNoteAction(form: FormData) {
  const session = await requireWorkspace();
  try {
    assertCan(session.role, "lead:write");
  } catch {
    redirect(`/app/leads?error=${message("Your role cannot add notes.")}`);
  }

  const leadId = field(form, "leadId");
  const body = field(form, "body");
  if (!body) redirect(`/app/leads?error=${message("Write a note first.")}`);

  tenantStore().addActivity(session.orgId, leadId, {
    kind: "note",
    body,
    actorUserId: session.user.id,
  });

  redirect(`/app/leads?noted=${encodeURIComponent(leadId)}`);
}

export async function inviteMemberAction(form: FormData) {
  const session = await requireWorkspace();
  try {
    assertCan(session.role, "member:invite");
  } catch {
    redirect(`/app/settings?error=${message("Only an owner or admin can invite people.")}`);
  }

  const email = field(form, "email");
  const role = field(form, "role") || "staff";

  db()
    .prepare(
      `insert into invitations (id, organization_id, email, role, token_hash, expires_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId("inv"),
      session.orgId,
      email.toLowerCase(),
      role,
      newId("tok"),
      new Date(Date.now() + 7 * 86_400_000).toISOString(),
      nowIso(),
    );

  writeAudit(db(), {
    orgId: session.orgId,
    actorUserId: session.user.id,
    action: "member.invite",
    entity: "invitation",
    meta: { email, role },
  });

  // Sending the email is milestone 2. The invitation is recorded, and the settings page shows
  // it as pending, rather than the interface pretending a message went out.
  redirect(`/app/settings?invited=${encodeURIComponent(email)}`);
}
