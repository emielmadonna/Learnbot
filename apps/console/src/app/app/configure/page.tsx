import { redirect } from "next/navigation";

export default async function ConfigurePage() {
  redirect("/app#configuration");
}
