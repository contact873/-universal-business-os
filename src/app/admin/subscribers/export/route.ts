import { requirePlatformAdmin } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";
import {
  subscribersFor as subscribersForJs,
  toCsv as toCsvJs,
} from "@/lib/subscribers.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The list, as a file the business can open in a spreadsheet. Behind the same administration check
// as the page, because a list of every customer's address is exactly the thing that must not leak.
export async function GET(request: Request) {
  await requirePlatformAdmin();

  const params = new URL(request.url).searchParams;
  const rows = subscribersForJs(getDb(), {
    status: params.get("status") || null,
    planId: params.get("plan") || null,
    consentedOnly: params.get("mailable") === "1",
    q: params.get("q") || null,
    limit: 5000,
  } as never) as Record<string, unknown>[];

  const csv = toCsvJs(rows as never) as string;
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="subscribers-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
