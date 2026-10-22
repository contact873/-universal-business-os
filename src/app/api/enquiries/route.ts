import { createRouteHandler, database, tenantStore, organizationByIntakeKey } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The public intake endpoint. A website posts here with the workspace's intake key.
//
// The boundary is the tested one from the api-and-auth skill: content type and size, then an IP
// rate limit, then validation. Authentication is deliberately "none" because a public contact
// form cannot hold a session, which is exactly why the rate limit comes before anything else and
// why the key identifies a workspace rather than granting access to it.

export const POST = createRouteHandler({
  auth: "none",
  rateLimit: { limit: 30, windowMs: 60_000 },
  maxBytes: 16 * 1024,
  schema: {
    intakeKey: { type: "string", required: true, max: 80 },
    name: { type: "string", max: 120 },
    email: { type: "email" },
    mobile: { type: "string", max: 40 },
    telephone: { type: "string", max: 40 },
    whatsapp: { type: "string", max: 60 },
    message: { type: "string", max: 4000 },
    source: { type: "string", max: 60 },
    country: { type: "string", max: 8 },
    tags: { type: "array", maxItems: 8 },
    // A field no person fills in. Bots complete every input they find.
    website: { type: "string", max: 200 },
  },
  handler: async ({ data }: { data: Record<string, any> }) => {
    if (data.website) {
      // Answer as though it worked. Telling a bot it was detected only teaches it to try harder.
      return { data: { stored: true } };
    }

    const org = organizationByIntakeKey(database(), data.intakeKey);
    if (!org) {
      return {
        ok: false,
        status: 404,
        error: { code: "unknown_workspace", message: "That intake key is not recognised." },
      };
    }

    const { intakeKey, website, tags, ...submission } = data;

    const result = tenantStore().capture(org.id, submission, {
      source: typeof submission.source === "string" ? submission.source : "website",
      tags: Array.isArray(tags) ? tags.map((t: unknown) => String(t)) : [],
      // The workspace's own country decides how a locally written number is read. A site may
      // override it per submission, but the business's market is the sensible default.
      defaultCountry:
        typeof data.country === "string" && data.country ? data.country : org.default_country,
    });

    if (!result.ok) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "no_identity",
          message: "Provide an email address or a phone number so we can reply.",
        },
      };
    }

    // Says nothing about the workspace or the contact. This endpoint is public, and confirming
    // whether a person is already known would make it an enumeration tool.
    return { data: { stored: true, replayed: result.replayed } };
  },
});
