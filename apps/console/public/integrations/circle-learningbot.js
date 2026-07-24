(() => {
  "use strict";
  const currentScript = document.currentScript;
  if (!(currentScript instanceof HTMLScriptElement)) return;
  if (document.querySelector("[data-learningbot-circle-launcher]")) return;
  const applicationUrl = new URL(
    currentScript.dataset.appUrl || "https://clone.stack-labs.ai/app/conversation",
  );
  applicationUrl.searchParams.set("source", "circle");
  const label = currentScript.dataset.label || "Ask Estie";
  const primary = currentScript.dataset.primary || "#205b46";

  const launcher = document.createElement("a");
  launcher.dataset.learningbotCircleLauncher = "true";
  launcher.href = applicationUrl.toString();
  launcher.target = "_blank";
  launcher.rel = "noopener noreferrer";
  launcher.setAttribute("aria-label", `${label} in the secure learning workspace`);
  launcher.textContent = `✦ ${label}`;
  Object.assign(launcher.style, {
    position: "fixed",
    right: "22px",
    bottom: "calc(22px + env(safe-area-inset-bottom))",
    zIndex: "2147483000",
    display: "inline-flex",
    alignItems: "center",
    gap: "9px",
    minHeight: "50px",
    padding: "0 18px",
    borderRadius: "999px",
    background: primary,
    color: "#fff",
    boxShadow: "0 14px 38px rgba(18, 45, 35, .22)",
    font: "700 14px/1 system-ui, -apple-system, sans-serif",
    textDecoration: "none",
  });
  document.body.append(launcher);
})();
