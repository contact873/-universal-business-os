// The typed contract for the plain JavaScript tenant store.
//
// The store itself is JavaScript so that the same code can be imported by node:test and by
// Next. These interfaces are what the pages rely on, written out rather than inferred so that a
// change to the store's shape fails here at build time instead of in a browser.

import { getDb } from "@/lib/db.mjs";
import { createTenantStore } from "@/lib/tenant.mjs";
import {
  createUser as createUserJs,
  authenticate as authenticateJs,
  createOrganization as createOrganizationJs,
  membershipsFor as membershipsForJs,
  organizationByIntakeKey as organizationByIntakeKeyJs,
} from "@/lib/accounts.mjs";
import {
  createSession as createSessionJs,
  revokeSession as revokeSessionJs,
  switchOrg as switchOrgJs,
} from "@/lib/sessions.mjs";
import { createRouteHandler as createRouteHandlerJs } from "@/lib/guard.mjs";
import { listAudit as listAuditJs } from "@/lib/audit.mjs";
import { withinLimit as withinLimitJs, applyEvent as applyEventJs } from "@/lib/billing.mjs";
import { planForDisplay as planForDisplayJs } from "@/lib/plans.mjs";
import {
  createTrialAccount as createTrialAccountJs,
  createCardTrialAccount as createCardTrialAccountJs,
  createFreeAccount as createFreeAccountJs,
  startSignupAccount as startSignupAccountJs,
} from "@/lib/onboarding.mjs";

export type TrialInput = {
  email: string;
  password: string;
  company: string;
  industry?: string | null;
  country?: string | null;
  name?: string | null;
};

export type TrialResult = {
  ok: boolean;
  reason?: string;
  message?: string;
  userId?: string;
  orgId?: string;
  slug?: string;
  plan?: string;
  needsCard?: boolean;
  subscriptionId?: string;
  trialDays?: number;
  delivery?: SendResult;
  createdAt?: string;
};

export function createTrialAccount(
  db: unknown,
  input: TrialInput,
  options?: {
    sendEmail?:
      | ((message: { to: string; subject: string; html: string }) => SendResult | Promise<SendResult>)
      | null;
    plan?: string;
  },
): Promise<TrialResult> {
  return createTrialAccountJs(db as never, input as never, options as never) as Promise<TrialResult>;
}

export function createCardTrialAccount(
  db: unknown,
  input: TrialInput,
  options?: {
    sendEmail?:
      | ((message: { to: string; subject: string; html: string }) => SendResult | Promise<SendResult>)
      | null;
    plan?: string;
    trialDays?: number;
  },
): Promise<TrialResult> {
  return createCardTrialAccountJs(db as never, input as never, options as never) as Promise<TrialResult>;
}

export function startSignupAccount(
  db: unknown,
  input: TrialInput,
  options?: {
    sendEmail?:
      | ((message: { to: string; subject: string; html: string }) => SendResult | Promise<SendResult>)
      | null;
    mode?: string;
  },
): Promise<TrialResult> {
  return startSignupAccountJs(db as never, input as never, options as never) as Promise<TrialResult>;
}

export function createFreeAccount(
  db: unknown,
  input: TrialInput,
  options?: {
    sendEmail?:
      | ((message: { to: string; subject: string; html: string }) => SendResult | Promise<SendResult>)
      | null;
  },
): Promise<TrialResult> {
  return createFreeAccountJs(db as never, input as never, options as never) as Promise<TrialResult>;
}

export type PlanDisplay = {
  id: string;
  name: string;
  monthly: number;
  setup: number | null;
  liveInDays: number | null;
  currency: string;
  limits: Record<string, number>;
};

export function planForDisplay(db: unknown): PlanDisplay[] {
  return planForDisplayJs(db as never) as PlanDisplay[];
}
import {
  zonedToUtc as zonedToUtcJs,
  createService as createServiceJs,
  createStaff as createStaffJs,
  book as bookJs,
  setAppointmentStatus as setStatusJs,
  listAppointments as listAppointmentsJs,
  listServices as listServicesJs,
  listStaff as listStaffJs,
  freeSlots as freeSlotsJs,
} from "@/lib/bookings.mjs";
import {
  sendEmail as sendEmailJs,
  invitationEmail as invitationEmailJs,
} from "@/lib/email.mjs";
import {
  createInvitation as createInvitationJs,
  recordInvitationDelivery as recordDeliveryJs,
  listInvitations as listInvitationsJs,
} from "@/lib/accounts.mjs";

/* bookings ------------------------------------------------------------------ */

export type ServiceRow = { id: string; name: string; duration_minutes: number; price_minor: number | null; currency: string | null };
export type StaffRow = { id: string; name: string; timezone: string | null };

export type AppointmentRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  service_name: string;
  staff_name: string;
  contact_name: string | null;
};

export type BookingResult = {
  ok: boolean;
  reason?: string;
  appointmentId?: string;
  startsAt?: string;
  endsAt?: string;
  service?: string;
  staff?: string;
  zone?: string;
};

export function zonedToUtc(dateIso: string, minuteOfDay: number, timeZone: string): string {
  return zonedToUtcJs(dateIso, minuteOfDay, timeZone) as string;
}

export function createService(db: unknown, orgId: string, input: { name: string; durationMinutes: number; priceMinor?: number | null; currency?: string | null; actorUserId?: string | null }): { serviceId: string; name: string; durationMinutes: number } {
  return createServiceJs(db as never, orgId, input as never) as never;
}

export function createStaff(db: unknown, orgId: string, input: { name: string; timezone?: string | null; userId?: string | null; actorUserId?: string | null }): { staffId: string; name: string } {
  return createStaffJs(db as never, orgId, input as never) as never;
}

export function bookAppointment(
  db: unknown,
  orgId: string,
  input: { staffId: string; serviceId: string; contactId?: string | null; startsAt: string; notes?: string | null; actorUserId?: string | null },
): BookingResult {
  return bookJs(db as never, orgId, input as never) as BookingResult;
}

export function setAppointmentStatus(
  db: unknown,
  orgId: string,
  appointmentId: string,
  status: string,
  options?: { actorUserId?: string | null },
): { ok: boolean; reason?: string } {
  return setStatusJs(db as never, orgId, appointmentId, status, options as never) as never;
}

export function listAppointments(db: unknown, orgId: string, options?: { from?: string | null; to?: string | null; limit?: number }): AppointmentRow[] {
  return listAppointmentsJs(db as never, orgId, options as never) as never;
}

export function listServices(db: unknown, orgId: string): ServiceRow[] {
  return listServicesJs(db as never, orgId) as never;
}

export function listStaffRows(db: unknown, orgId: string): StaffRow[] {
  return listStaffJs(db as never, orgId) as never;
}

export function freeSlots(db: unknown, orgId: string, staffId: string, dateIso: string, minutes: number): { startsAt: string; endsAt: string }[] {
  return freeSlotsJs(db as never, orgId, staffId, dateIso, minutes) as never;
}

/* email --------------------------------------------------------------------- */

export type SendResult = { ok: boolean; id?: string | null; reason?: string; status?: number; detail?: string };

export function sendEmail(
  message: { to: string; subject: string; html: string; replyTo?: string | null },
  options?: { key?: string; fetchImpl?: unknown },
): Promise<SendResult> {
  return sendEmailJs(message as never, options as never) as Promise<SendResult>;
}

export function invitationEmail(input: { workspaceName: string; inviterEmail: string | null; role: string; acceptUrl?: string | null }): { subject: string; html: string } {
  return invitationEmailJs(input as never) as { subject: string; html: string };
}

export function createInvitation(
  db: unknown,
  orgId: string,
  input: { email: string; role: string; actorUserId?: string | null },
): { invitationId: string; token: string; email: string; role: string } {
  return createInvitationJs(db as never, orgId, input as never) as never;
}

export function recordInvitationDelivery(db: unknown, invitationId: string, result: SendResult): { ok: boolean } {
  return recordDeliveryJs(db as never, invitationId, result as never) as never;
}

export type InvitationRow = {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  sent_at: string | null;
  send_error: string | null;
};

export function listInvitations(db: unknown, orgId: string): InvitationRow[] {
  return listInvitationsJs(db as never, orgId) as never;
}

export type BillingEventInput = {
  provider: string;
  eventId: string;
  type: string;
  data?: Record<string, any>;
  raw?: string | null;
  now?: number;
};

export type BillingEventResult = {
  applied: boolean;
  reason?: string;
  orgId?: string;
  status?: string;
  entitlements?: unknown;
};

// Same reason as everything else here: a JavaScript default of null makes the parameter infer as
// `null | undefined` and reject the string a caller passes.
export function applyEvent(db: unknown, input: BillingEventInput): BillingEventResult {
  return applyEventJs(db as never, input as never) as BillingEventResult;
}

export type LimitCheck = {
  allowed: boolean;
  limit: number | null;
  current: number | null;
  reason: string;
};

export function withinLimit(
  db: unknown,
  orgId: string,
  feature: string,
  options?: { current?: number | null },
): LimitCheck {
  return withinLimitJs(db as never, orgId, feature, options as never) as never;
}

export type AuditRow = {
  id: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  meta_json: string | null;
  created_at: string;
  actor_email: string | null;
};

export function auditTrail(db: unknown, orgId: string, options?: { limit?: number }): AuditRow[] {
  return listAuditJs(db as never, orgId, options as never) as AuditRow[];
}

export type Identity = {
  id: string;
  kind: string;
  value_raw: string;
  value_normalized: string;
  label: string | null;
  needs_review: number;
};

export type Contact = {
  id: string;
  organization_id: string;
  name: string | null;
  source: string | null;
  first_seen_at: string;
  last_seen_at: string;
  submission_count: number;
};

export type ContactDetail = Contact & {
  identities: Identity[];
  tags: string[];
  leads: Lead[];
};

export type Lead = {
  id: string;
  organization_id: string;
  contact_id: string;
  stage: string;
  source: string | null;
  form_id: string | null;
  message: string | null;
  value_minor: number | null;
  currency: string | null;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Activity = {
  id: string;
  kind: string;
  body: string | null;
  created_at: string;
};

export type LeadDetail = Lead & { activities: Activity[] };

export type Stats = {
  contacts: number;
  leads: number;
  byStage: { stage: string; n: number }[];
  newThisWeek: number;
  recent: {
    id: string;
    stage: string;
    source: string | null;
    created_at: string;
    contact_name: string | null;
  }[];
};

export type CaptureResult =
  | { ok: true; replayed: boolean; created: boolean; contactId: string; leadId: string; identities: Identity[]; errors: unknown[] }
  | { ok: false; errors: unknown[]; identities: unknown[]; contactId: null; leadId: null };

export type TenantStore = {
  listContacts(orgId: string, options?: { limit?: number; tag?: string | null }): Contact[];
  getContact(orgId: string, contactId: string): ContactDetail | null;
  updateContact(orgId: string, contactId: string, patch: { name?: string }, options?: { actorUserId?: string }): number;
  deleteContact(orgId: string, contactId: string, options?: { role?: string; actorUserId?: string }): number;
  addTag(orgId: string, contactId: string, tag: string): number;
  removeTag(orgId: string, contactId: string, tag: string): number;
  capture(orgId: string, submission: Record<string, unknown>, options?: Record<string, unknown>): CaptureResult;
  listLeads(orgId: string, options?: { stage?: string | null; ownerUserId?: string | null; limit?: number }): Lead[];
  getLead(orgId: string, leadId: string): LeadDetail | null;
  addActivity(orgId: string, leadId: string, activity: { kind?: string; body?: string | null; actorUserId?: string | null }): number;
  updateLeadStage(orgId: string, leadId: string, stage: string, options?: { role?: string; actorUserId?: string }): number;
  assignLead(orgId: string, leadId: string, ownerUserId: string, options?: { role?: string; actorUserId?: string }): number;
  stats(orgId: string): Stats;
};

export function tenantStore(): TenantStore {
  return createTenantStore(getDb()) as unknown as TenantStore;
}

// Typed wrappers for the accounts module.
//
// A parameter with a default in plain JavaScript infers as `null | undefined` rather than the
// type callers will actually pass, so the boundary is declared once here instead of being cast
// at each call site.

export type NewUserInput = {
  email: string;
  password: string;
  name?: string | null;
  platformAdmin?: boolean;
};

export function createUser(db: unknown, input: NewUserInput): { userId: string; email: string } {
  return createUserJs(db as never, input as never) as { userId: string; email: string };
}

export function authenticate(
  db: unknown,
  email: string,
  password: string,
): { ok: boolean; reason?: string; user?: { id: string; email: string; name: string | null; is_platform_admin: number } } {
  return authenticateJs(db as never, email, password) as never;
}

export type NewOrganizationInput = {
  name: string;
  industry?: string | null;
  timezone?: string;
  ownerUserId?: string | null;
  slug?: string | null;
  plan?: string | null;
  defaultCountry?: string | null;
};

export function createOrganization(
  db: unknown,
  input: NewOrganizationInput,
): { orgId: string; slug: string } {
  return createOrganizationJs(db as never, input as never) as { orgId: string; slug: string };
}

export type Membership = { orgId: string; role: string; name: string; slug: string };

export function membershipsFor(db: unknown, userId: string): Membership[] {
  return membershipsForJs(db as never, userId) as never;
}

export function organizationByIntakeKey(
  db: unknown,
  key: string,
): { id: string; name: string; slug: string; industry: string | null; default_country: string | null } | null {
  return organizationByIntakeKeyJs(db as never, key) as never;
}

export function database(): ReturnType<typeof getDb> {
  return getDb();
}

// Session wrappers, for the same reason: optional parameters with defaults infer as
// `null | undefined` in the JavaScript module and reject the values callers pass.

export type SessionToken = { sessionId: string; token: string; expiresAt: string };

export function createSession(
  db: unknown,
  input: { userId: string; orgId?: string | null; ttlMs?: number; now?: number },
): SessionToken {
  return createSessionJs(db as never, input as never) as SessionToken;
}

export function revokeSession(db: unknown, token: string): number {
  return revokeSessionJs(db as never, token) as number;
}

export function switchOrg(
  db: unknown,
  sessionId: string,
  orgId: string,
): { ok: boolean; reason?: string; role?: string } {
  return switchOrgJs(db as never, sessionId, orgId) as never;
}

// The request boundary from the api-and-auth skill, typed. Every option that has a default in
// the JavaScript module would otherwise reject the value a caller passes.

export type RouteHandlerOptions = {
  handler: (context: { data: any; identity: any; request: Request }) => Promise<unknown>;
  schema?: Record<string, unknown> | null;
  secret?: string | null;
  auth?: "required" | "optional" | "none";
  cookieName?: string;
  rateLimit?: { limit: number; windowMs: number } | null;
  rateLimitByIdentity?: { limit: number; windowMs: number } | null;
  authorize?: ((context: { identity: any; data: any; request: Request }) => boolean | Promise<boolean>) | null;
  onError?: ((error: unknown, context: { request: Request; identity: any }) => void) | null;
  maxBytes?: number;
  now?: () => number;
};

export function createRouteHandler(
  options: RouteHandlerOptions,
): (request: Request) => Promise<Response> {
  return createRouteHandlerJs(options as never) as never;
}
