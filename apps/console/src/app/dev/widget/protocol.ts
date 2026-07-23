import type {
  IdentityTier,
  ResolvedLearningContext,
  WidgetSnapshot,
} from "./runtime";

export interface SimulatorBranding {
  assistantName: string;
  primaryColor: string;
  accentColor: string;
  surfaceColor: string;
  textColor: string;
  welcomeCopy: string;
  launcherPosition: "bottom-left" | "bottom-right";
  voiceEnabled: boolean;
  logoPath: string;
}

export interface SimulatorConfiguration {
  tenantKey: string;
  tenantName: string;
  identityTier: IdentityTier;
  learnerName: string;
  branding: SimulatorBranding;
  context: ResolvedLearningContext;
}

export type HostCommand =
  | { source: "widget-lab"; type: "configure"; configuration: SimulatorConfiguration }
  | { source: "widget-lab"; type: "open" }
  | { source: "widget-lab"; type: "close" }
  | { source: "widget-lab"; type: "expand" }
  | { source: "widget-lab"; type: "restore" }
  | { source: "widget-lab"; type: "start-voice" }
  | { source: "widget-lab"; type: "inject-evidence" }
  | { source: "widget-lab"; type: "force-failure" }
  | { source: "widget-lab"; type: "reset" };

export type HostEvent =
  | { source: "widget-host"; type: "ready" }
  | {
      source: "widget-host";
      type: "snapshot";
      snapshot: WidgetSnapshot;
      hidden: boolean;
    }
  | {
      source: "widget-host";
      type: "activity";
      label: string;
      detail: string;
      at: string;
    };

export function isHostCommand(value: unknown): value is HostCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    value.source === "widget-lab" &&
    "type" in value &&
    typeof value.type === "string"
  );
}
