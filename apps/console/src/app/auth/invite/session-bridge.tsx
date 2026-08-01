"use client";

import { useEffect, useState } from "react";
import { createBrowserSupabaseClient } from "../../../lib/supabase/client";
import styles from "../auth.module.css";

export function InvitationSessionBridge() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const supabase = createBrowserSupabaseClient();
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const query = new URLSearchParams(window.location.search);
        const providerError =
          fragment.get("error_description") ?? query.get("error_description");
        if (providerError) throw new Error(providerError);

        const accessToken = fragment.get("access_token");
        const refreshToken = fragment.get("refresh_token");
        if (accessToken && refreshToken) {
          const session = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (session.error) throw session.error;
        } else {
          const code = query.get("code");
          if (!code) throw new Error("invitation_session_missing");
          const exchanged = await supabase.auth.exchangeCodeForSession(code);
          if (exchanged.error) throw exchanged.error;
        }

        window.history.replaceState({}, "", "/auth/invite");
        window.location.replace(
          "/auth/change-password?mode=invitation&next=/app",
        );
      } catch {
        if (active) {
          setError(
            "This invitation link is invalid or has expired. Ask the workspace owner to send a new invitation.",
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return error ? (
    <>
      <p className={styles.error} role="alert">
        {error}
      </p>
      <a className={styles.textButton} href="/auth/sign-in">
        Return to sign in
      </a>
    </>
  ) : (
    <p className={styles.notice} role="status">
      Verifying invitation…
    </p>
  );
}
