import {
  authenticatedLearningClient,
  executeLearningRpc,
  learningRedirect,
  safeLearningError,
} from "../../../../lib/supabase/learning-route";
import { learningOperationKey } from "../../../../lib/supabase/learning-rpc";

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const form = await request.formData();
    await executeLearningRpc(supabase, "learning_publish_course", {
      target_course_id: String(form.get("courseId") ?? ""),
      idempotency_key: learningOperationKey("web-course-publish"),
    });
    return learningRedirect(request, "status", "course_published");
  } catch (error) {
    return learningRedirect(request, "error", safeLearningError(error));
  }
}
