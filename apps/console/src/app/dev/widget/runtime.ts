export type {
  CourseAiWidgetElement,
  IdentityTier,
  ResolvedLearningContext,
  WidgetBranding,
  WidgetConversation,
  WidgetIdentity,
  WidgetRuntimeAdapter,
  WidgetRuntimeEvent,
  WidgetSnapshot,
  WidgetThreadItem,
  WidgetVoiceControl,
} from "../../../../../../packages/widget-runtime/src/index";

export function loadWidgetRuntime() {
  return import("../../../../../../packages/widget-runtime/src/index");
}
