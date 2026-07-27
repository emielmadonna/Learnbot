"use client";

import { UserAccessManager } from "../../app/app/admin/users/user-access-manager";
import type { PanelProps } from "../app-shell/contract";
import styles from "./sections.module.css";

/**
 * People panel — the previous user-access route.
 *
 * `UserAccessManager` is hosted unchanged: same `/api/admin/users` reads and
 * mutations, same privacy-safe adoption totals.
 */
export function PeoplePanel(_props: PanelProps) {
  return (
    <div className={styles.stack}>
      <section className={styles.stackTight}>
        <p className={styles.eyebrow}>People</p>
        <h3 className={styles.title}>A calm view of your team.</h3>
        <p className={styles.lede}>
          Create controlled access, understand adoption, and keep every person
          inside the right workspace boundary.
        </p>
      </section>
      <UserAccessManager />
    </div>
  );
}

export default PeoplePanel;
