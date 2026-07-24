(() => {
  "use strict";
  const currentScript = document.currentScript;
  if (!(currentScript instanceof HTMLScriptElement)) return;
  if (document.querySelector("[data-learningbot-circle-launcher]")) return;
  const applicationUrl = new URL(
    currentScript.dataset.appUrl || "https://clone.stack-labs.ai/app/conversation",
  );
  applicationUrl.searchParams.set("source", "circle");
  const tenantId = currentScript.dataset.tenantId || "";
  const tenantSlug = currentScript.dataset.tenantSlug || "";
  const assistantName = currentScript.dataset.assistantName || "";
  const assistantAccent = currentScript.dataset.assistantAccent || "";
  const assistantWelcome = currentScript.dataset.assistantWelcome || "";
  const communityUrl = currentScript.dataset.communityUrl || "";
  if (tenantId) applicationUrl.searchParams.set("tenantId", tenantId);
  if (tenantSlug) applicationUrl.searchParams.set("tenantSlug", tenantSlug);
  if (assistantName) applicationUrl.searchParams.set("assistant", assistantName);
  if (assistantAccent) applicationUrl.searchParams.set("assistantAccent", assistantAccent);
  if (assistantWelcome) applicationUrl.searchParams.set("welcome", assistantWelcome);
  if (communityUrl) applicationUrl.searchParams.set("circleCommunityUrl", communityUrl);
  const label = currentScript.dataset.label || "Ask Estie";
  const primary = currentScript.dataset.assistantPrimary || currentScript.dataset.primary || "#205b46";

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
