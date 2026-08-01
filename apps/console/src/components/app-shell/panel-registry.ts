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
    title: "Talk to your bot",
    subtitle: "Practice with the same grounded assistant your students use",
    navLabel: "Conversation",
    size: "wide",
    component: AgentPanel,
  },
  insights: {
    title: "Insights",
    subtitle: "Questions, students and signals worth acting on",
    navLabel: "Results",
    size: "wide",
    component: InsightsPanel,
  },
  course: {
    title: "Learning",
    subtitle: "The course and everything the assistant may read",
    navLabel: "Learning",
    size: "wide",
    component: CoursePanel,
  },
  people: {
    title: "People",
    subtitle: "Workspace access and student activity",
    navLabel: "People",
    size: "wide",
    component: PeoplePanel,
  },
  platform: {
    title: "Workspaces",
    subtitle: "Every client workspace in one operating view",
    navLabel: "Workspaces",
    size: "wide",
    component: PlatformPanel,
  },
  widget: {
    title: "Install",
    subtitle: "Appearance, domains and the student-facing assistant",
    navLabel: "Install",
    size: "wide",
    component: WidgetPanel,
  },
  settings: {
    title: "Settings",
    subtitle: "The bot, appearance, install, people, plan and account",
    navLabel: "Settings",
    size: "standard",
    component: SettingsPanel,
  },
};
