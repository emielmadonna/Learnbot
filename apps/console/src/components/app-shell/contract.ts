export type PanelKey =
  | "agent"
  | "insights"
  | "course"
  | "people"
  | "platform"
  | "widget"
  | "settings";

export type ShellRole =
  | "learner"
  | "creator"
  | "teacher"
  | "tenant_admin"
  | "tenant_owner"
  | "platform_owner";

export type AgentConfig = {
  assistantName: string;
  logoUrl: string | null;
  avatarUrl: string | null;
  iconGlyph: string;
  primaryColor: string;
  accentColor: string;
  surfaceColor: string;
  textColor: string;
  welcomeMessage: string;
  personaInstructions: string;
  tone: string;
  voice: string;
  courseScope: "all" | string[];
};

export type ShellPayload = {
  role: ShellRole;
  tenant: { tenantId: string; slug: string; displayName: string };
  agent: AgentConfig;
  sections: Record<PanelKey, boolean>;
  workspace: unknown; // LearningWorkspace from lib/supabase/learning-rpc
};

export type PanelProps = {
  payload: ShellPayload;
  params: URLSearchParams;
  close(): void;
  refresh(): Promise<void>;
};
