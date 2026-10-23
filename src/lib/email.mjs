// Outbound email.
//
// The rule: store first, send second. Everything that needs to be emailed is written to the
// database before a provider is called, so a provider outage costs a delay rather than a record.
// The send result is then written back onto the row, so "sent" means sent and not merely attempted.
//
// The provider is Resend, called with fetch rather than its SDK: one fewer dependency for one HTTP
// request, and the fetch implementation can be injected, which is what makes the failure paths
// testable without a network.

import { RESEND_API_KEY, EMAIL_FROM } from "./config.mjs";

const ENDPOINT = "https://api.resend.com/emails";

export function emailConfigured(key = RESEND_API_KEY) {
  return Boolean(key);
}

export async function sendEmail({ to, subject, html, from = EMAIL_FROM, replyTo = null }, { fetchImpl = fetch, key = RESEND_API_KEY } = {}) {
  // Fail closed and honestly. A caller that treats this as a success would tell a customer their
  // invitation was sent when nothing left the building.
  if (!key) return { ok: false, reason: "not_configured" };
  if (!to || !subject || !html) return { ok: false, reason: "incomplete" };

  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        reason: "provider_error",
        status: response.status,
        // Truncated on purpose: provider error bodies can be long and are shown in an interface.
        detail: String(detail).slice(0, 300),
      };
    }

    const body = await response.json().catch(() => ({}));
    return { ok: true, id: body?.id ?? null };
  } catch (error) {
    return { ok: false, reason: "network_error", detail: String(error?.message ?? error).slice(0, 300) };
  }
}

export function invitationEmail({ workspaceName, inviterEmail, role, acceptUrl = null }) {
  const workspace = escapeHtml(workspaceName);
  const inviter = escapeHtml(inviterEmail ?? "somebody in the workspace");
  const link = acceptUrl ? `<p><a href="${escapeHtml(acceptUrl)}">Accept the invitation</a></p>` : "";
  const linkPlain = acceptUrl ? `<p>${escapeHtml(acceptUrl)}</p>` : "";

  return {
    subject: `You have been invited to ${workspaceName}`,
    html: `<p>${inviter} invited you to join <strong>${workspace}</strong> as ${escapeHtml(role)}.</p>
${link}
${linkPlain}
<p>If you were not expecting this, ignore it and nothing happens.</p>`,
  };
}

/** Sent the moment a trial workspace exists. It must not promise anything the product cannot do. */
export function welcomeEmail({ company, slug }) {
  const workspace = escapeHtml(company);
  return {
    subject: `Your workspace is ready: ${company}`,
    html: `<p>Your workspace <strong>${workspace}</strong> exists and your trial has started.</p>
<p>Three things are worth doing first:</p>
<ol>
  <li>Add the services you sell, with their real durations.</li>
  <li>Add the people who answer enquiries, with their timezone.</li>
  <li>Add one contact by hand, so you can see how a person is stored with more than one way of reaching them.</li>
</ol>
<p>Your workspace address is <strong>${escapeHtml(slug)}</strong>. Nothing you put in it is visible to
any other business on the platform.</p>
<p>If anything is unclear, reply to this message and a person will answer.</p>`,
  };
}

/** Sent when the workspace exists but no card is attached, so no access has been granted. */
export function cardRequiredEmail({ company, slug, trialDays = 7 }) {
  return {
    subject: `One step left to start your ${trialDays} day trial`,
    html: `<p>Your workspace <strong>${escapeHtml(company)}</strong> exists. To start the ${trialDays}
day trial, add a payment method. Nothing is charged until the trial ends, and you can cancel before
then.</p>
<p>Sign in and choose a card on the billing page. Your workspace address is
<strong>${escapeHtml(slug)}</strong>.</p>
<p>If you would rather not put a card on file, reply to this message and a person will arrange a
walkthrough instead.</p>`,
  };
}

export function leadNotificationEmail({ workspaceName, contactName, message, contactDetails }) {
  return {
    subject: `New enquiry for ${workspaceName}`,
    html: `<p>A new enquiry arrived for <strong>${escapeHtml(workspaceName)}</strong>.</p>
<p><strong>${escapeHtml(contactName ?? "Unnamed")}</strong></p>
<p>${escapeHtml(contactDetails ?? "no contact details")}</p>
<p>${escapeHtml(message ?? "no message")}</p>`,
  };
}

// Values are escaped at output, not sanitised on the way in: the database keeps what was actually
// written, and nothing that reaches a browser is trusted.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
