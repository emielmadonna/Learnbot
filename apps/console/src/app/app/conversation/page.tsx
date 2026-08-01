import { redirect } from "next/navigation";

/**
 * The conversation is now the `agent` panel of the single app shell. Existing
 * links, bookmarks and `?mode=voice` deep links keep working.
 */
export default async function ConversationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const next = new URLSearchParams({ panel: "agent", view: "talk" });
  for (const key of ["mode", "courseId", "lessonId"]) {
    const value = parameters[key];
    if (typeof value === "string" && value) next.set(key, value);
  }
  redirect(`/app?${next.toString()}`);
}
