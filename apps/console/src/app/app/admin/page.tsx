import { redirect } from "next/navigation";

/** The owner overview is now the `insights` panel of the single app shell. */
export default function AdminOverviewPage() {
  redirect("/app?panel=insights");
}
