"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db.mjs";
import {
  startSignupAccount,
  findInvitationByToken,
  acceptInvitation,
  pendingInvitationCount,
  revokeInvitation,
  updateOrganization,
  resolveIndustry,
  issueInvoice,
  outstandingInvoiceFor,
} from "@/lib/types";
import { SESSION_COOKIE } from "@/lib/config.mjs";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords.mjs";
import { LEAD_STAGES } from "@/lib/tenant.mjs";
import { assertCan, can } from "@/lib/roles.mjs";
import { writeAudit } from "@/lib/audit.mjs";
import { id as newId, nowIso } from "@/lib/identities.mjs";
import { requireWorkspace, currentSession } from "@/lib/session-server";
import {
  tenantStore,
  createUser,
  authenticate,
  createOrganization, ensureWorkspaceForUser, changePassword, revokeAllSessionsForUser,
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
  const industryOther = field(form, "industryOther") || null;

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
      { email, password, company, industry, industryOther, country: field(form, "country") || null, name },
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
        : result.reason === "industry_required"
          ? "You chose Others for the industry, so say what your business does in the box beside it."
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

  let memberships = membershipsFor(db(), result.user.id);
  if (memberships.length === 0) {
    // Signed in, but with no workspace, used to mean being sent back to this page with no explanation.
    ensureWorkspaceForUser(db(), result.user.id);
    memberships = membershipsFor(db(), result.user.id);
  }

  const orgId = memberships.length === 1 ? memberships[0].orgId : null;
  const { token, expiresAt } = createSession(db(), { userId: result.user.id, orgId });

  await setSessionCookie(token, expiresAt);
  redirect(orgId ? "/app" : memberships.length ? "/app/choose" : "/app");
}

/**
 * Changing your own password.
 *
 * Every other session is ended, because the reason somebody changes a password is usually that another
 * person may have it; leaving those sessions alive would make the change decorative. The session in this
 * browser is rebuilt immediately afterwards so the person is not thrown out of the page they are on.
 */
export async function changePasswordAction(form: FormData) {
  const session = await requireWorkspace();

  const currentPassword = field(form, "currentPassword");
  const newPassword = field(form, "newPassword");
  const again = field(form, "confirmPassword");

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    redirect(
      `/app/settings?error=${message(`A password needs at least ${MIN_PASSWORD_LENGTH} characters, because shorter ones are guessed.`)}`,
    );
  }
  if (newPassword !== again) {
    redirect(`/app/settings?error=${message("The two new passwords do not match.")}`);
  }
  if (newPassword === currentPassword) {
    redirect(`/app/settings?error=${message("That is the password you already have.")}`);
  }

  const result = changePassword(db(), session.user.id, currentPassword, newPassword);
  if (!result.ok) {
    // One message for a wrong password or an account that vanished: neither should confirm anything.
    redirect(`/app/settings?error=${message("That is not your current password.")}`);
  }

  revokeAllSessionsForUser(db(), session.user.id);
  const fresh = createSession(db(), { userId: session.user.id, orgId: session.orgId });
  await setSessionCookie(fresh.token, fresh.expiresAt);

  writeAudit(db(), {
    orgId: session.orgId,
    actorUserId: session.user.id,
    action: "user.password_changed",
    entity: "user",
    entityId: session.user.id,
  });

  redirect("/app/settings?saved=password");
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

  // Seats are a plan limit like any other, and until now they were the one limit nothing checked:
  // a workspace on the free plan, which includes a single person, could invite fifty. Pending
  // invitations count, because an invited person is a seat already spoken for.
  const members = (db().prepare("select count(*) as n from memberships where organization_id = ?").get(session.orgId) as { n: number }).n;
  const seats = withinLimit(db(), session.orgId, "seats", { current: members + pendingInvitationCount(db(), session.orgId) });

  if (!seats.allowed) {
    const limit = seats.limit ?? 0;
    redirect(
      `/app/settings?error=${message(
        `Your plan includes ${limit} ${limit === 1 ? "person" : "people"} and it is full. Upgrade the plan to add somebody, or remove a person first.`,
      )}`,
    );
  }

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

  // The link has to be built before it is sent, and it has to be handed back to the person doing the
  // inviting. Without a mail provider an invitation that cannot be copied is an invitation nobody can
  // accept, and the token exists nowhere once the hash is written.
  const origin = await requestOrigin();
  const acceptUrl = `${origin}/invite/${invitation.token}`;

  const body = invitationEmail({
    workspaceName: workspace?.name ?? "the workspace",
    inviterEmail: session.user.email,
    role,
    acceptUrl,
  });

  const sent = await sendEmail({ to: invitation.email, subject: body.subject, html: body.html });
  recordInvitationDelivery(db(), invitation.invitationId, sent);

  // The link travels in the URL so it can be shown once. It is a single-use secret, so it is never
  // stored in the clear on our side and never listed again after this page.
  const link = `&link=${encodeURIComponent(acceptUrl)}`;

  if (sent.ok) {
    redirect(`/app/settings?invited=${encodeURIComponent(invitation.email)}${link}`);
  }

  const why = sent.reason === "not_configured" ? "no email provider is configured" : `the provider refused it (${sent.reason})`;
  redirect(
    `/app/settings?error=${message(`Invitation for ${invitation.email} was recorded, but not emailed because ${why}. Send this link yourself:`)}${link}`,
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

/**
 * The origin this request arrived on, so a link works where it is actually deployed.
 *
 * APP_URL is the intended public address, and it is wrong while the DNS record does not exist. The
 * request knows better: it is the host the person is already using.
 */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  if (!host) return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${proto}://${host}`;
}

/**
 * Accepting an invitation. Reachable without a session on purpose: the person being invited does not
 * have an account yet, which is the whole reason they were invited.
 */
export async function acceptInvitationAction(form: FormData) {
  const token = field(form, "token");
  const db0 = db();

  const found = findInvitationByToken(db0, token);
  if (!found.ok || !found.acceptable) {
    redirect(`/invite/${encodeURIComponent(token)}?error=${message("That invitation is no longer valid.")}`);
  }

  const session = await currentSession();

  let userId: string | null = session.ok ? session.user.id : null;

  // No session yet: make the account, but only if nobody already holds the invited address.
  if (!userId) {
    const existing = db0.prepare("select id from users where email_normalized = ?").get(String(found.email).toLowerCase());

    if (existing) {
      redirect(
        `/invite/${encodeURIComponent(token)}?error=${message(
          "An account already exists for that address. Sign in first, then open this link again.",
        )}`,
      );
    }

    const password = field(form, "password");
    const name = field(form, "name");

    try {
      ({ userId } = createUser(db0, { email: found.email as string, password, name }));
    } catch (error) {
      redirect(`/invite/${encodeURIComponent(token)}?error=${message((error as Error).message)}`);
    }
  }

  // The seat limit applies at the moment somebody actually joins, not only when they are invited.
  const members = (db0.prepare("select count(*) as n from memberships where organization_id = ?").get(found.orgId as string) as { n: number }).n;
  const alreadyIn = db0
    .prepare("select 1 as yes from memberships where organization_id = ? and user_id = ?")
    .get(found.orgId as string, userId);

  if (!alreadyIn) {
    const seats = withinLimit(db0, found.orgId as string, "seats", { current: members });
    if (!seats.allowed) {
      redirect(
        `/invite/${encodeURIComponent(token)}?error=${message(
          `${found.organizationName} has no free seat on its current plan. Ask the owner to upgrade or remove somebody first.`,
        )}`,
      );
    }
  }

  const accepted = acceptInvitation(db0, token, userId);
  if (!accepted.ok) {
    const explain =
      accepted.reason === "wrong_account"
        ? `That invitation is for ${accepted.invitedEmail}. Sign in as that address, or ask for a new invitation.`
        : accepted.reason === "already_accepted"
          ? "That invitation has already been used."
          : accepted.reason === "expired"
            ? "That invitation has expired. Ask for a new one."
            : "That invitation could not be found.";
    redirect(`/invite/${encodeURIComponent(token)}?error=${message(explain)}`);
  }

  const uid = userId as string;
  const { token: sessionToken, expiresAt } = createSession(db0, { userId: uid, orgId: accepted.orgId as string });
  await setSessionCookie(sessionToken, expiresAt);

  redirect("/app");
}

/**
 * Edits the workspace itself. The timezone is the reason this exists: bookings are stored in UTC and
 * rendered through this value, so a clinic left on UTC shows every appointment at the wrong hour.
 */
export async function updateWorkspaceAction(form: FormData) {
  const session = await requireWorkspace();

  if (!can(session.role, "org:update")) {
    redirect(`/app/settings?error=${message("Only an owner or an admin can change the workspace.")}`);
  }

  // The same rule as sign-up: choosing Others means saying what the business does.
  const chosen = resolveIndustry(field(form, "industry") || null, field(form, "industryOther") || null);
  if (!chosen.ok) {
    redirect(
      `/app/settings?error=${message(
        chosen.reason === "industry_too_long"
          ? "Keep the industry to 60 characters or fewer."
          : "You chose Others, so please say what the business does in the box beside it.",
      )}`,
    );
  }

  const result = updateOrganization(db(), session.orgId, {
    name: field(form, "name") || null,
    industry: chosen.industry ?? null,
    timezone: field(form, "timezone") || null,
  });

  if (!result.ok) {
    const explain =
      result.reason === "bad_timezone"
        ? "That timezone is not one the system recognises, so appointments would be stored inconsistently."
        : result.reason === "bad_name"
          ? "The workspace name needs between two and eighty characters."
          : "That could not be saved.";
    redirect(`/app/settings?error=${message(explain)}`);
  }

  redirect("/app/settings?saved=1");
}

/**
 * Cancels an invitation that has not been accepted.
 *
 * An invitation that cannot be delivered still holds a seat until it expires, so on a one seat plan a
 * workspace can be locked out of inviting anybody for a week. This is the release valve.
 */
export async function revokeInvitationAction(form: FormData) {
  const session = await requireWorkspace();

  if (!can(session.role, "member:invite")) {
    redirect(`/app/settings?error=${message("Only an owner or an admin can cancel an invitation.")}`);
  }

  const result = revokeInvitation(db(), session.orgId, field(form, "invitationId"));

  if (!result.ok) {
    redirect(
      `/app/settings?error=${message(
        result.reason === "already_accepted"
          ? "That invitation has already been accepted, so the person is a member now."
          : "That invitation no longer exists.",
      )}`,
    );
  }

  redirect(`/app/settings?revoked=${encodeURIComponent(result.email ?? "the invitation")}`);
}

/**
 * An owner moving onto a paid plan.
 *
 * With no card provider connected this is the only way to become a customer: an invoice is issued at
 * the catalogue price and the workspace is told where to send the money. The plan becomes active only
 * when a person confirms the transfer arrived, because nothing else can know that, and pretending
 * otherwise means granting months on hope.
 */
export async function requestUpgradeAction(form: FormData) {
  const session = await requireWorkspace();

  if (!can(session.role, "billing:write")) {
    redirect(`/app/billing?error=${message("Only an owner can change the plan.")}`);
  }

  const planId = field(form, "planId");
  const db0 = db();

  const plan = db0.prepare("select id, name, price_minor, currency from plans where id = ?").get(planId) as
    | { id: string; name: string; price_minor: number; currency: string }
    | undefined;

  if (!plan) redirect(`/app/billing?error=${message("That plan does not exist.")}`);
  if (plan.price_minor === 0) {
    redirect(`/app/billing?error=${message("The free plan needs no invoice. Pick a paid plan to move onto.")}`);
  }

  const current = db0
    .prepare("select plan_id, status from subscriptions where organization_id = ? order by created_at desc limit 1")
    .get(session.orgId) as { plan_id: string | null; status: string } | undefined;

  if (current?.plan_id === plan.id && current?.status === "active") {
    redirect(`/app/billing?error=${message("That is already your plan.")}`);
  }

  // One unpaid invoice at a time. Two invoices for one month is an argument nobody wants.
  const existing = outstandingInvoiceFor(db0, session.orgId);
  if (existing) {
    redirect(
      `/app/billing?error=${message(
        "There is already an invoice waiting to be paid. Settle that one first, or write to us and we will cancel it.",
      )}`,
    );
  }

  let invoice;
  try {
    invoice = issueInvoice(db0, session.orgId, plan.id);
  } catch (error) {
    redirect(`/app/billing?error=${message((error as Error).message)}`);
  }

  const amount = (invoice.amountMinor / 100).toFixed(2);
  redirect(
    `/app/billing?notice=${message(
      `Invoice issued for ${plan.name}: ${plan.currency} ${amount}. Transfer it to the account below and we will switch the plan on.`,
    )}`,
  );
}
