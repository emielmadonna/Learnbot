"use client";

import { UserAccessManager } from "../../app/app/admin/users/user-access-manager";
import peopleStyles from "../../app/app/admin/users/users.module.css";
import type { PanelProps } from "../app-shell/contract";

/**
 * People panel — the previous user-access route.
 *
 * `UserAccessManager` keeps the same `/api/admin/users` reads and mutations,
 * the same workspace boundary, and the same privacy-safe adoption totals.
 */
export function PeoplePanel(_props: PanelProps) {
  return (
    <div className={peopleStyles.panel}>
      <section className={peopleStyles.panelHeader}>
        <p className={peopleStyles.eyebrow}>People and access</p>
        <h2>Everyone in this workspace.</h2>
        <p className={peopleStyles.lede}>
          Create controlled access, see who still needs to complete their first
          sign-in, and keep every person inside the right workspace boundary.
        </p>
      </section>
      <UserAccessManager />
    </div>
  );
}

export default PeoplePanel;
