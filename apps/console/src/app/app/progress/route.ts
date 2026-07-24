import {
  authenticatedLearningClient,
  executeLearningRpc,
  learningRedirect,
  safeLearningError,
} from "../../../lib/supabase/learning-route";
import { learningOperationKey } from "../../../lib/supabase/learning-rpc";

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const form = await request.formData();
    await executeLearningRpc(supabase, "learning_mark_lesson_progress", {
      target_lesson_id: String(form.get("lessonId") ?? ""),
      target_state: String(form.get("state") ?? ""),
      idempotency_key: learningOperationKey("web-lesson-progress"),
    });
    return learningRedirect(request, "status", "progress_saved");
  } catch (error) {
    return learningRedirect(request, "error", safeLearningError(error));
  }
}
