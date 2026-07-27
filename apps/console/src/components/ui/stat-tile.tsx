import styles from "./stat-tile.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";

/**
 * How much of the underlying evidence is actually there.
 * "unknown" means the platform could not compute it; "restricted" means the
 * viewer is not permitted to see it. Neither is ever rendered as 0.
 */
export type StatState = "known" | "partial" | "unknown" | "restricted";

const stateClass: Readonly<Record<StatState, string>> = {
  known: styles.known!,
  partial: styles.partial!,
  unknown: styles.unknown!,
  restricted: styles.restricted!,
};

export type StateBadgeProps = {
  readonly state: StatState;
  readonly children?: string | undefined;
  readonly className?: string | undefined;
};

/** Known / partial / unknown / restricted pill, harvested from the intelligence surface. */
export function StateBadge({ state, children, className }: StateBadgeProps) {
  return (
    <span className={cx(tokens.uiRoot, styles.badge, stateClass[state], className)}>
      {children ?? state}
    </span>
  );
}

type StatTileBase = {
  readonly label: string;
  readonly eyebrow?: string | undefined;
  /** One line under the value: how it was measured, what it counts. */
  readonly sublabel?: string | undefined;
  /** Footer context line, e.g. "Lessons per week vs same-tenant median". */
  readonly footnote?: string | undefined;
  /** Rendered as a <time> in the footer. Pass a display string. */
  readonly asOf?: string | undefined;
  readonly className?: string | undefined;
  /** Hides the state pill when a whole section already carries one. */
  readonly hideBadge?: boolean | undefined;
};

export type StatTileProps = StatTileBase &
  (
    | {
        readonly state?: "known" | "partial" | undefined;
        readonly value: string;
        readonly reason?: string | undefined;
      }
    | {
        readonly state: "unknown" | "restricted";
        readonly value?: undefined;
        /** Required: say why the number is absent instead of showing a zero. */
        readonly reason: string;
      }
  );

const absentLabel: Readonly<Record<"unknown" | "restricted", string>> = {
  unknown: "Not known",
  restricted: "Restricted",
};

/**
 * Headline number with its provenance. When the value is unknown or restricted
 * the tile says so and explains why — it never substitutes 0, "—" or a guess.
 */
export function StatTile(props: StatTileProps) {
  const {
    label,
    eyebrow,
    sublabel,
    footnote,
    asOf,
    className,
    hideBadge = false,
  } = props;
  const state: StatState = props.state ?? "known";
  const absent = state === "unknown" || state === "restricted";

  return (
    <article className={cx(tokens.uiRoot, styles.tile, className)}>
      <div className={styles.top}>
        <p className={styles.eyebrow}>{eyebrow ?? ""}</p>
        {!hideBadge && <StateBadge state={state} />}
      </div>
      <h3 className={styles.label}>{label}</h3>
      {absent ? (
        <strong className={cx(styles.value, styles.absent)}>
          {absentLabel[state as "unknown" | "restricted"]}
        </strong>
      ) : (
        <strong className={styles.value}>{props.value}</strong>
      )}
      <p className={styles.detail}>
        {absent ? props.reason : (sublabel ?? props.reason ?? "")}
      </p>
      {(footnote !== undefined || asOf !== undefined) && (
        <div className={styles.foot}>
          {footnote !== undefined && <span>{footnote}</span>}
          {asOf !== undefined && <time>{asOf}</time>}
        </div>
      )}
    </article>
  );
}

export default StatTile;
