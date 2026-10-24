import { getDb } from "@/lib/db.mjs";
import { runLifecycle, summarise } from "@/lib/lifecycle.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The conversion lifecycle, on a schedule.
 *
 * Fails closed: with no secret configured it refuses, because a job that can downgrade workspaces must
 * never be reachable by anybody who guesses the path. Call it from a cron service with the header set.
 */
function authorised(request: Request): boolean {
  const secret = process.env.LIFECYCLE_SECRET?.trim();
  if (!secret) return false;
  const provided = request.headers.get("x-lifecycle-secret")?.trim();
  return Boolean(provided) && provided === secret;
}

async function handle(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json(
      { ok: false, error: { code: "unauthorized", message: "A lifecycle secret is required." } },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const result = runLifecycle(getDb());
    const summary = summarise(result);
    console.log(`[lifecycle] ${summary}`);
    return Response.json(
      { ok: true, summary, actions: result.actions, skipped: result.skipped, at: result.at },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("[lifecycle] failed:", error);
    return Response.json(
      { ok: false, error: { code: "server_error", message: "The lifecycle job failed. Check the logs." } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
