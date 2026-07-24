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
    await executeLearningRpc(supabase, "learning_create_course_draft", {
      requested_title: String(form.get("title") ?? ""),
      requested_description: String(form.get("description") ?? ""),
      requested_module_title: String(form.get("moduleTitle") ?? ""),
      requested_lesson_title: String(form.get("lessonTitle") ?? ""),
      requested_lesson_content: String(form.get("lessonContent") ?? ""),
      idempotency_key: learningOperationKey("web-course-create"),
    });
    return learningRedirect(request, "status", "course_created");
  } catch (error) {
    return learningRedirect(request, "error", safeLearningError(error));
  }
}
