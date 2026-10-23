// Onboarding: turning a visitor from the marketing site into a workspace.
//
// The order here is the shape of the whole product: create the account, create the workspace, grant
// the trial, and only then send an email. If the mail provider is down the customer still exists and
// can sign in; the failure is reported rather than swallowed, and it never blocks the sign-up.
//
// The endpoint that calls this must not reveal whether an email is already registered. Return
// "email_taken" internally, and let the route answer with the same generic message either way.

import { createUser, createOrganization } from "./accounts.mjs";
import { beginCardTrial } from "./billing.mjs";
import { welcomeEmail, cardRequiredEmail } from "./email.mjs";

export async function createTrialAccount(
  db,
  { email, password, company, industry = null, country = null, name = null },
  { sendEmail = null, plan = "starter", now = Date.now() } = {},
) {
  if (!company || String(company).trim().length < 2) {
    return { ok: false, reason: "bad_company" };
  }

  let userId;
  try {
    ({ userId } = createUser(db, { email, password, name }));
  } catch (error) {
    if (error?.status === 409) return { ok: false, reason: "email_taken" };
    if (error?.status === 400) return { ok: false, reason: "bad_input", message: error.message };
    throw error;
  }

  const { orgId, slug } = createOrganization(db, {
    name: company,
    industry,
    ownerUserId: userId,
    plan,
    defaultCountry: country,
  });

  // Role is owner by construction, created inside createOrganization. Nothing here can grant more.

  let delivery = { ok: false, reason: "not_attempted" };

  if (sendEmail) {
    const message = welcomeEmail({ company, slug });
    try {
      // Awaited on purpose. Reading `.ok` from an un-awaited promise would always be undefined, and
      // the caller would report "not emailed" for every successful send.
      delivery = await sendEmail({
        to: String(email).trim().toLowerCase(),
        subject: message.subject,
        html: message.html,
      });
    } catch (error) {
      delivery = { ok: false, reason: "sender_threw", detail: String(error?.message ?? error).slice(0, 200) };
    }
  }

  return { ok: true, userId, orgId, slug, delivery, createdAt: new Date(now).toISOString() };
}

/**
 * The card-first sign-up: register, then add a card, then seven days, then the charge.
 *
 * The workspace is created without a plan, so nothing is granted, and a subscription sits in
 * 'incomplete'. Access begins only when the provider confirms a card and the webhook moves it to
 * 'trialing'. That is the whole difference between this and the open trial above: the gate is in the
 * data, not in the interface.
 */
export async function createCardTrialAccount(
  db,
  { email, password, company, industry = null, country = null, name = null },
  { sendEmail = null, plan = "professional", trialDays = 7, now = Date.now() } = {},
) {
  if (!company || String(company).trim().length < 2) {
    return { ok: false, reason: "bad_company" };
  }

  let userId;
  try {
    ({ userId } = createUser(db, { email, password, name }));
  } catch (error) {
    if (error?.status === 409) return { ok: false, reason: "email_taken" };
    if (error?.status === 400) return { ok: false, reason: "bad_input", message: error.message };
    throw error;
  }

  const { orgId, slug } = createOrganization(db, {
    name: company,
    industry,
    ownerUserId: userId,
    plan: null,
    defaultCountry: country,
  });

  const started = beginCardTrial(db, orgId, plan, { trialDays, now });

  let delivery = { ok: false, reason: "not_attempted" };
  if (sendEmail) {
    const message = cardRequiredEmail({ company, slug, trialDays });
    try {
      delivery = await sendEmail({
        to: String(email).trim().toLowerCase(),
        subject: message.subject,
        html: message.html,
      });
    } catch (error) {
      delivery = { ok: false, reason: "sender_threw", detail: String(error?.message ?? error).slice(0, 200) };
    }
  }

  return {
    ok: true,
    needsCard: true,
    subscriptionId: started.subscriptionId,
    userId,
    orgId,
    slug,
    trialDays,
    delivery,
    createdAt: new Date(now).toISOString(),
  };
}
