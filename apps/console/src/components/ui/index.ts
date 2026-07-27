/**
 * Shared console UI primitives.
 *
 * Every component here is themed only through the five brand custom properties
 * the shell sets: --brand-primary, --brand-accent, --brand-surface,
 * --brand-text and --brand-on-primary. See README.md in this directory.
 */

export { Button } from "./button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./button";

export { ColorField } from "./color-field";
export type { ColorFieldProps } from "./color-field";

export {
  AA_THRESHOLD,
  contrastRatio,
  isHexColor,
  normalizeHex,
  passesAA,
  relativeLuminance,
} from "./contrast";
export type { ContrastLevel } from "./contrast";

export { DistributionBar } from "./distribution-bar";
export type { DistributionBarProps, DistributionItem } from "./distribution-bar";

export { EmptyState } from "./empty-state";
export type { EmptyStateProps, EmptyStateTone } from "./empty-state";

export {
  Field,
  SelectField,
  TextAreaField,
  TextField,
} from "./field";
export type {
  FieldControl,
  FieldProps,
  SelectFieldProps,
  SelectOption,
  TextAreaFieldProps,
  TextFieldProps,
} from "./field";

export { FileDrop } from "./file-drop";
export type { FileDropProps, FileDropStatus } from "./file-drop";

export { PanelFrame } from "./panel-frame";
export type { PanelFrameProps, PanelSide } from "./panel-frame";

export { StateBadge, StatTile } from "./stat-tile";
export type { StateBadgeProps, StatState, StatTileProps } from "./stat-tile";

export { Toggle } from "./toggle";
export type { ToggleProps } from "./toggle";

export { TrendChart } from "./trend-chart";
export type { TrendChartProps, TrendPoint } from "./trend-chart";
