import { getDb } from "@/lib/db.mjs";
import { createRouteHandler, startSignupAccount } from "@/lib/types";
import { ensurePlans } from "@/lib/plans.mjs";
import { sendEmail } from "@/lib/email.mjs";
import { PUBLIC_ORIGINS, SIGNUP_MODE, TRIAL_DAYS, PAYMENT_PROVIDER_CONFIGURED } from "@/lib/config.mjs";
import { withCors, preflight, rejectDisallowedOrigin } from "@/lib/cors.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The endpoint the marketing site posts to when somebody starts a trial.
//
// Deliberate properties:
//   * Rate limited by IP before anything else, five per hour, because account creation is exactly
//     what a bot farm does when it finds a public form. The guard handler applies the limit before
//     it authenticates or validates.
//   * The same answer whether or not the email is already registered. Saying "that email exists"
//     turns the endpoint into a membership oracle.
//   * The account is created before the welcome email is sent, so a mail outage costs an email, not
//     a customer.
//   * A weak password is rejected with the rule stated, because "invalid input" teaches nobody.

const trialHandler = createRouteHandler({
  auth: "none",
  rateLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  maxBytes: 8 * 1024,
  schema: {
    email: { type: "email", required: true },
    password: { type: "string", required: true, min: 10, max: 200 },
    company: { type: "string", required: true, min: 2, max: 80 },
    industry: { type: "string", max: 40 },
    country: { type: "string", max: 8 },
    name: { type: "string", max: 80 },
    phone: { type: "string", max: 40 },
    // Opt in, never assumed. An unchecked box sends false, and false means the address is stored
    // but not mailable.
    marketingConsent: { type: "boolean" },
  },
  handler: async ({ data }: { data: Record<string, any> }) => {
    const db = getDb();

    // A fresh deployment has no plan catalogue until something creates it.
    ensurePlans(db);

    let result;
    try {
      const input = {
        email: data.email,
        password: data.password,
        company: data.company,
        industry: data.industry ?? null,
        country: data.country ?? null,
        name: data.name ?? null,
        phone: data.phone ?? null,
        marketingConsent: data.marketingConsent === true,
      };

      const sender = (message: { to: string; subject: string; html: string }) => sendEmail(message);

      // What a new sign-up gets is decided in one place, so this endpoint and the application's own
      // sign-up page cannot drift apart again.
      result = await startSignupAccount(db, input, { sendEmail: sender });
    } catch (error) {
      console.error("[trial] failed:", error);
      return {
        ok: false,
        status: 500,
        error: { code: "server_error", message: "Something went wrong on our side." },
      };
    }

    if (!result.ok) {
      if (result.reason === "email_taken") {
        // The same message a successful sign-up returns to a bot. The real user is told by email,
        // or by the sign-in page, not by this endpoint.
        return { data: { started: true } };
      }

      return {
        ok: false,
        status: 400,
        error: {
          code: result.reason,
          message:
            result.reason === "bad_company"
              ? "A business name is required."
              : result.message ?? "Check the details and try again.",
        },
      };
    }

    return {
      data: {
        started: true,
        workspace: result.slug,
        // Which plan the workspace is on: "free" means it is usable now and never expires.
        plan: result.plan ?? SIGNUP_MODE,
        // True when the workspace exists but no access has been granted yet, because no card is on
        // file. The website must say that rather than sending the visitor to a dashboard they
        // cannot use.
        needsCard: Boolean(result.needsCard),
        providerConfigured: PAYMENT_PROVIDER_CONFIGURED,
        // Null on the free plan. It is not a trial, and reporting a trial length for it would be
        // the first thing a future client misreads.
        trialDays: result.plan === "free" ? null : (result.trialDays ?? TRIAL_DAYS),
        emailed: Boolean(result.delivery?.ok),
      },
    };
  },
});

// The exported handlers, so the marketing site's form can call this from another origin. The
// allowlist comes from PUBLIC_ORIGINS.
//
// The rejection comes before the handler, not after it. Adding CORS headers to a stranger's response
// would still have created their account: the door has to be closed, not just left without a
// doormat. See rejectDisallowedOrigin.
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");

  const blocked = rejectDisallowedOrigin(origin, PUBLIC_ORIGINS);
  if (blocked) return blocked;

  const response = await trialHandler(request);
  return withCors(response, origin, PUBLIC_ORIGINS);
}

export async function OPTIONS(request: Request): Promise<Response> {
  return preflight(request.headers.get("origin"), PUBLIC_ORIGINS);
}
