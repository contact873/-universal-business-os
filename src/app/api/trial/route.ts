import { getDb } from "@/lib/db.mjs";
import { createRouteHandler, createTrialAccount } from "@/lib/types";
import { ensurePlans } from "@/lib/plans.mjs";
import { sendEmail } from "@/lib/email.mjs";

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

export const POST = createRouteHandler({
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
  },
  handler: async ({ data }: { data: Record<string, any> }) => {
    const db = getDb();

    // A fresh deployment has no plan catalogue until something creates it.
    ensurePlans(db);

    let result;
    try {
      result = await createTrialAccount(
        db,
        {
          email: data.email,
          password: data.password,
          company: data.company,
          industry: data.industry ?? null,
          country: data.country ?? null,
          name: data.name ?? null,
        },
        {
          sendEmail: (message: { to: string; subject: string; html: string }) => sendEmail(message),
        },
      );
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
        // Whether the welcome email left the building. Honest, and useful in support.
        emailed: Boolean(result.delivery?.ok),
      },
    };
  },
});
