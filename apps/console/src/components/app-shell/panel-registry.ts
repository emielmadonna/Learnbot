import type { ComponentType } from "react";
import AgentPanel from "../sections/agent-panel";
import CoursePanel from "../sections/course-panel";
import InsightsPanel from "../sections/insights-panel";
import PeoplePanel from "../sections/people-panel";
import PlatformPanel from "../sections/platform-panel";
import SettingsPanel from "../sections/settings-panel";
import WidgetPanel from "../sections/widget-panel";
import type { PanelKey, PanelProps } from "./contract";

export type PanelDefinition = {
  /** Accessible dialog name. */
  title: string;
  /** Short supporting line rendered under the title. */
  subtitle: string;
  /** Nav label for the persistent header. */
  navLabel: string;
  /** Layout width of the slide-in surface. */
  size: "standard" | "wide";
  component: ComponentType<PanelProps>;
};

/**
 * The single place panels are registered. Add a panel here and it becomes
 * reachable at `/app?panel=<key>` with slide-in, focus trap and deep linking
 * handled by {@link PanelHost}.
 */
export const panelRegistry: Record<PanelKey, PanelDefinition> = {
  agent: {
    title: "Assistant",
    subtitle: "Grounded conversation and voice",
    navLabel: "Assistant",
    size: "wide",
    component: AgentPanel,
  },
  insights: {
    title: "Insights",
    subtitle: "Durable workspace readiness and library totals",
    navLabel: "Insights",
    size: "wide",
    component: InsightsPanel,
  },
  course: {
    title: "Learning",
    subtitle: "Courses, lessons and authoring",
    navLabel: "Learning",
    size: "wide",
    component: CoursePanel,
  },
  people: {
    title: "People",
    subtitle: "Controlled access and adoption",
    navLabel: "People",
    size: "wide",
    component: PeoplePanel,
  },
  platform: {
    title: "Platform",
    subtitle: "Cross-tenant operating view",
    navLabel: "Platform",
    size: "wide",
    component: PlatformPanel,
  },
  widget: {
    title: "Widget",
    subtitle: "Your assistant, embedded on your own site",
    navLabel: "Widget",
    size: "wide",
    component: WidgetPanel,
  },
  settings: {
    title: "Settings",
    subtitle: "Workspace, brand and account",
    navLabel: "Settings",
    size: "standard",
    component: SettingsPanel,
  },
};
