import type { LearningBlock } from "../../lib/supabase/learning-rpc";

/** Preserved verbatim from the previous workspace page. */
export function blockText(block: LearningBlock) {
  const text = block.content.text;
  if (typeof text === "string") return text;
  const markdown = block.content.markdown;
  if (typeof markdown === "string") return markdown;
  const html = block.content.html;
  if (typeof html === "string") {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  return "This content block is available but does not have a text preview.";
}

export function percent(value: number) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

export function roleLabel(role: string) {
  return role.replaceAll("_", " ").replace(/\b\w/gu, (letter) =>
    letter.toUpperCase(),
  );
}

export const statusMessages: Record<string, string> = {
  course_created: "Draft created. Review it below, then publish when ready.",
  course_published: "Course published. Learners can now open it.",
  progress_saved: "Progress saved.",
};

export const errorMessages: Record<string, string> = {
  request_failed: "That request could not be completed. Nothing was changed.",
  access_denied: "Your current role cannot perform that action.",
  invalid_request: "Check the values and try again.",
};
