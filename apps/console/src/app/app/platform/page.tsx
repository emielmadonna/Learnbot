import { redirect } from "next/navigation";

/** Platform control is now the `platform` panel of the single app shell. */
export default function PlatformAdminPage() {
  redirect("/app?panel=platform");
}
