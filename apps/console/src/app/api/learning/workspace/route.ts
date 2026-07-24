import { NextResponse } from "next/server";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const workspace = await executeLearningRpc(
      supabase,
      "learning_get_workspace",
    );
    return NextResponse.json(workspace, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json(
      { ok: false, code: "authentication_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
}
