"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db.mjs";
import { startSignupAccount } from "@/lib/types";
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
  createInvitation,
  recordInvitationDelivery,
  sendEmail,
  invitationEmail,
  createService,
  createStaff,
  bookAppointment,
  setAppointmentStatus,
  zonedToUtc,
  listStaffRows,
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

  let result;
  try {
    // Goes through the same path as the marketing site's form, so the plan and the subscriber row
    // are identical either way. This used to hardcode the paid Starter plan and skip the registry.
    //
    // It creates the user itself. Calling createUser first and then handing the same address in here
    // created the person twice: the second attempt hit the unique constraint, the sign-up failed, and
    // it left a user row with no workspace behind it.
    result = await startSignupAccount(
      db(),
      { email, password, company, industry, country: field(form, "country") || null, name },
      { sendEmail: (outgoing) => sendEmail(outgoing) },
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "digest" in error) throw error;
    redirect(`/signup?error=${message((error as Error).message)}`);
  }

  if (!result.ok || !result.userId || !result.orgId) {
    // Say which it is. On our own sign-up page there is nothing to protect by being vague, and
    // "try another email address" told somebody with an account nothing they could act on.
    const explain =
      result.reason === "email_taken"
        ? "That email already has an account. Sign in instead, or use a different address."
        : result.reason === "bad_input" || result.reason === "bad_company"
          ? (result.message ?? "Check the details and try again.")
          : "That could not be created. Try again, or write to us.";
    redirect(`/signup?error=${message(explain)}`);
  }

  try {
    const { token, expiresAt } = createSession(db(), { userId: result.userId, orgId: result.orgId });
    await setSessionCookie(token, expiresAt);
  } catch (error) {
    if (typeof error === "object" && error !== null && "digest" in error) throw error;
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

  // Stored first, sent second. If the provider is down the invitation still exists and is shown as
  // pending, rather than vanishing with the failure.
  let invitation;
  try {
    invitation = createInvitation(db(), session.orgId, {
      email,
      role,
      actorUserId: session.user.id,
    });
  } catch (error) {
    redirect(`/app/settings?error=${message((error as Error).message)}`);
  }

  const workspace = db()
    .prepare("select name from organizations where id = ?")
    .get(session.orgId) as { name: string } | undefined;

  const body = invitationEmail({
    workspaceName: workspace?.name ?? "the workspace",
    inviterEmail: session.user.email,
    role,
  });

  const sent = await sendEmail({ to: invitation.email, subject: body.subject, html: body.html });
  recordInvitationDelivery(db(), invitation.invitationId, sent);

  if (sent.ok) {
    redirect(`/app/settings?invited=${encodeURIComponent(invitation.email)}`);
  }

  // The honest message: the invitation exists, and no email left the building.
  const why = sent.reason === "not_configured" ? "no email provider is configured" : `the provider refused it (${sent.reason})`;
  redirect(
    `/app/settings?error=${message(`Invitation for ${invitation.email} was recorded, but not emailed because ${why}.`)}`,
  );
}

export async function markInvoicePaidAction(form: FormData) {
  const session = await requireWorkspace();

  // Platform administration only. A workspace owner confirming their own invoice would be a
  // conflict of interest, not a feature.
  if (!session.user.is_platform_admin) {
    redirect(`/admin/invoices?error=${message("Only platform administration can confirm a payment.")}`);
  }

  const invoiceId = field(form, "invoiceId");
  const reference = field(form, "reference") || null;

  const { markInvoicePaid } = await import("@/lib/payments.mjs");
  const result = markInvoicePaid(getDb(), invoiceId, {
    reference,
    actorUserId: session.user.id,
  } as never);

  if (!result.ok) {
    const explain =
      result.reason === "already_paid"
        ? "That invoice was already marked paid."
        : "That invoice does not exist.";
    redirect(`/admin/invoices?error=${message(explain)}`);
  }

  redirect("/admin/invoices?paid=1");
}

export async function startCardTrialAction() {
  const session = await requireWorkspace();

  try {
    assertCan(session.role, "billing:write");
  } catch {
    redirect(`/app/billing?error=${message("Only an owner can change billing details.")}`);
  }

  // Fail closed and say why. Until a provider account exists there is no hosted checkout to send
  // anybody to, and collecting a card on this server is not an option.
  if (!process.env.PAYMENT_PROVIDER_KEY?.trim()) {
    redirect(
      `/app/billing?error=${message("Card payments are not switched on yet, so nothing was charged.")}`,
    );
  }

  redirect(
    `/app/billing?error=${message("The payment provider adapter is not built yet. The card form will appear here once it is.")}`,
  );
}

export async function createServiceAction(form: FormData) {
  const session = await requireWorkspace();
  try {
    assertCan(session.role, "service:write");
  } catch {
    redirect(`/app/bookings?error=${message("Only a manager or above can add services.")}`);
  }

  try {
    createService(db(), session.orgId, {
      name: field(form, "name"),
      durationMinutes: Number(field(form, "durationMinutes")),
      priceMinor: field(form, "priceMinor") ? Math.round(Number(field(form, "priceMinor")) * 100) : null,
      currency: field(form, "currency") || null,
      actorUserId: session.user.id,
    });
  } catch (error) {
    redirect(`/app/bookings?error=${message((error as Error).message)}`);
  }

  redirect("/app/bookings");
}

export async function createStaffAction(form: FormData) {
  const session = await requireWorkspace();
  try {
    assertCan(session.role, "staff:write");
  } catch {
    redirect(`/app/bookings?error=${message("Only a manager or above can add staff.")}`);
  }

  try {
    createStaff(db(), session.orgId, {
      name: field(form, "name"),
      timezone: field(form, "timezone") || null,
      actorUserId: session.user.id,
    });
  } catch (error) {
    redirect(`/app/bookings?error=${message((error as Error).message)}`);
  }

  redirect("/app/bookings");
}

export async function bookAppointmentAction(form: FormData) {
  const session = await requireWorkspace();
  try {
    assertCan(session.role, "booking:write");
  } catch {
    redirect(`/app/bookings?error=${message("Your role cannot book appointments.")}`);
  }

  const staffId = field(form, "staffId");
  const serviceId = field(form, "serviceId");
  const when = field(form, "startsAt"); // from a datetime-local input: 2026-03-10T10:00

  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(when);
  if (!match) {
    redirect(`/app/bookings?error=${message("Pick a date and a time.")}`);
  }

  // The person typing means the clinic's local wall clock, so the time is interpreted in the staff
  // member's zone rather than in whatever the browser thinks the timezone is.
  const staff = listStaffRows(db(), session.orgId).find((member) => member.id === staffId);
  if (!staff) {
    redirect(`/app/bookings?error=${message("Choose a staff member.")}`);
  }

  const zone = staff.timezone || (db()
    .prepare("select timezone from organizations where id = ?")
    .get(session.orgId) as { timezone: string | null } | undefined)?.timezone || "UTC";

  const minuteOfDay = Number(match[2]) * 60 + Number(match[3]);
  const startsAt = zonedToUtc(match[1], minuteOfDay, zone);

  const result = bookAppointment(db(), session.orgId, {
    staffId,
    serviceId,
    startsAt,
    contactId: field(form, "contactId") || null,
    notes: field(form, "notes") || null,
    actorUserId: session.user.id,
  });

  if (!result.ok) {
    const explain =
      result.reason === "conflict"
        ? "That slot is already taken."
        : result.reason === "outside_hours"
          ? `That time is outside the working day in ${zone}.`
          : result.reason === "unknown_service"
            ? "Choose a service."
            : result.reason === "unknown_staff"
              ? "Choose a staff member."
              : `The booking was refused (${result.reason}).`;
    redirect(`/app/bookings?error=${message(explain)}`);
  }

  redirect("/app/bookings?booked=1");
}

export async function cancelAppointmentAction(form: FormData) {
  const session = await requireWorkspace();
  const appointmentId = field(form, "appointmentId");

  const result = setAppointmentStatus(db(), session.orgId, appointmentId, "cancelled", {
    actorUserId: session.user.id,
  });

  if (!result.ok) {
    redirect(`/app/bookings?error=${message("That appointment was not found in this workspace.")}`);
  }

  redirect("/app/bookings?cancelled=1");
}
