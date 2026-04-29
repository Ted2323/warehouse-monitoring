import { NextResponse } from "next/server";

// Pings the FastAPI service's /health from the server so we don't expose
// DETECTION_SERVICE_URL to the browser. The dashboard fires this on mount;
// if the Render container is sleeping, the boot starts here while the user
// is still picking a file. By the time they upload, /detect is warm and we
// skip the cold-start poll in /api/detect entirely.
export const maxDuration = 5;

export async function GET() {
  const url = process.env.DETECTION_SERVICE_URL;
  if (!url) {
    return NextResponse.json({ status: "no-service" }, { status: 200 });
  }

  // Fire-and-forget semantics — we just need Render's edge to start the
  // container. Don't wait for the boot to finish; cap the wait so this
  // route stays cheap even if /health takes a while to answer.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2_000);

  try {
    const res = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    res.body?.cancel().catch(() => {});
    return NextResponse.json({ status: res.ok ? "warm" : "cold", code: res.status });
  } catch {
    clearTimeout(timer);
    return NextResponse.json({ status: "waking" });
  }
}
