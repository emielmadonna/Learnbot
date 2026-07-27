import { redirect } from "next/navigation";

/** User access is now the `people` panel of the single app shell. */
export default function UserAccessPage() {
  redirect("/app?panel=people");
}
