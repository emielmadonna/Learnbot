import { CorsoMark } from "../../../components/corso/corso-mark";
import styles from "../auth.module.css";
import { InvitationSessionBridge } from "./session-bridge";

export default function InvitationPage() {
  return (
    <main className={styles.authShell}>
      <section className={styles.authPanel}>
        <span className={styles.authMark}>
          <CorsoMark size={34} />
        </span>
        <h1 className={styles.authTitle}>Accept your invitation</h1>
        <p className={styles.authLede}>
          We’re verifying this secure link before you choose a password.
        </p>
        <InvitationSessionBridge />
      </section>
    </main>
  );
}
