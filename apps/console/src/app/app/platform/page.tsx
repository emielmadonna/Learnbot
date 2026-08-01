import { redirect } from "next/navigation";

/** Platform control is now the `platform` panel of the single app shell. */
export default async function PlatformAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const next = new URLSearchParams({ panel: "platform" });
  for (const key of ["view", "id", "billing", "status", "error"]) {
    const value = parameters[key];
    if (typeof value === "string" && value) next.set(key, value);
  }
  if (!next.has("view")) next.set("view", "workspaces");
  redirect(`/app?${next.toString()}`);
}
