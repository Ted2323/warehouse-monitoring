import { NextRequest, NextResponse } from "next/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasSupabase  = !!(SUPABASE_URL && SUPABASE_KEY);

export async function GET(req: NextRequest) {
  if (!hasSupabase) {
    return NextResponse.json({ logs: [] });
  }

  const { createClient } = require("@supabase/supabase-js");
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { searchParams } = new URL(req.url);
  const cameraId = searchParams.get("camera_id");
  const limit    = parseInt(searchParams.get("limit") || "50");

  let query = supabase
    .from("detection_logs")
    .select("*")
    .order("detected_at", { ascending: false })
    .limit(limit);

  if (cameraId) query = query.eq("camera_id", cameraId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ logs: data });
}
