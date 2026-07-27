import styles from "./trend-chart.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";
import { EmptyState } from "./empty-state";

export type TrendPoint = {
  readonly label: string;
  /** null means "no observation for this bucket" — it is drawn as a gap, not a zero. */
  readonly value: number | null;
};

export type TrendChartProps = {
  readonly points: readonly TrendPoint[];
  /** Names the chart for assistive tech, e.g. "Questions per day, last 30 days". */
  readonly ariaLabel: string;
  readonly caption?: string | undefined;
  readonly height?: number | undefined;
  readonly showArea?: boolean | undefined;
  /**
   * Where the vertical scale starts. "zero" keeps volume comparisons honest and
   * is the default; "min" magnifies small movement and should be labelled.
   */
  readonly baseline?: "zero" | "min" | undefined;
  readonly formatValue?: ((value: number) => string) | undefined;
  readonly emptyMessage?: string | undefined;
  readonly className?: string | undefined;
};

const VIEW_WIDTH = 600;
const PAD = 6;

type Plotted = { readonly x: number; readonly y: number };

function runsOf(points: ReadonlyArray<Plotted | undefined>): Plotted[][] {
  const runs: Plotted[][] = [];
  let current: Plotted[] = [];
  for (const point of points) {
    if (point === undefined) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Dependency-free inline SVG line/area chart for volume over time.
 * Missing buckets break the line rather than being interpolated or zero-filled,
 * and a period with no observations at all renders an EmptyState.
 */
export function TrendChart({
  points,
  ariaLabel,
  caption,
  height = 96,
  showArea = true,
  baseline = "zero",
  formatValue,
  emptyMessage = "No activity has been recorded for this period.",
  className,
}: TrendChartProps) {
  const observed = points.filter(
    (point): point is { label: string; value: number } => point.value !== null,
  );
  const format = formatValue ?? ((value: number) => value.toLocaleString());

  if (observed.length === 0) {
    return (
      <EmptyState
        className={className}
        compact
        description={emptyMessage}
        headline="No trend to draw"
      />
    );
  }

  const values = observed.map((point) => point.value);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const low = baseline === "zero" ? Math.min(0, dataMin) : dataMin;
  const span = dataMax - low === 0 ? 1 : dataMax - low;
  const step = points.length > 1 ? VIEW_WIDTH / (points.length - 1) : 0;
  const usable = height - PAD * 2;

  const plotted = points.map<Plotted | undefined>((point, index) =>
    point.value === null
      ? undefined
      : {
          x: points.length > 1 ? index * step : VIEW_WIDTH / 2,
          y: PAD + (1 - (point.value - low) / span) * usable,
        },
  );
  const runs = runsOf(plotted);
  const last = plotted.filter((point): point is Plotted => point !== undefined).at(-1);
  const latest = observed.at(-1);
  const gaps = points.length - observed.length;

  return (
    <figure className={cx(tokens.uiRoot, styles.trend, className)}>
      {(caption !== undefined || latest !== undefined) && (
        <figcaption className={styles.head}>
          {caption !== undefined && (
            <span className={styles.caption}>{caption}</span>
          )}
          {latest !== undefined && (
            <span className={styles.latest}>{format(latest.value)}</span>
          )}
        </figcaption>
      )}
      <svg
        aria-label={ariaLabel}
        className={styles.plot}
        height={height}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      >
        <line
          className={styles.baseline}
          x1="0"
          x2={VIEW_WIDTH}
          y1={height - PAD}
          y2={height - PAD}
        />
        {showArea &&
          runs.map((run) => (
            <path
              className={styles.area}
              d={`M ${run[0]!.x} ${height - PAD} ${run
                .map((point) => `L ${point.x} ${point.y}`)
                .join(" ")} L ${run[run.length - 1]!.x} ${height - PAD} Z`}
              key={`area-${run[0]!.x}`}
            />
          ))}
        {runs.map((run) => (
          <path
            className={styles.line}
            d={`M ${run[0]!.x} ${run[0]!.y} ${run
              .slice(1)
              .map((point) => `L ${point.x} ${point.y}`)
              .join(" ")}`}
            key={`line-${run[0]!.x}`}
          />
        ))}
        {last !== undefined && (
          /*
           * A zero-length round-capped stroke renders as a dot that stays
           * circular under the non-uniform x scaling a full-width chart needs.
           */
          <line
            className={styles.marker}
            x1={last.x}
            x2={last.x}
            y1={last.y}
            y2={last.y}
          />
        )}
      </svg>
      <div className={styles.axis}>
        <span>{points[0]?.label ?? ""}</span>
        {gaps > 0 && (
          <span className={styles.gap}>
            {gaps} period{gaps === 1 ? "" : "s"} without data
          </span>
        )}
        <span>{points[points.length - 1]?.label ?? ""}</span>
      </div>
      {/* Values stay reachable without reading the drawing. */}
      <dl className={styles.srOnly}>
        {points.map((point) => (
          <div key={point.label}>
            <dt>{point.label}</dt>
            <dd>{point.value === null ? "no data" : format(point.value)}</dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}

export default TrendChart;
