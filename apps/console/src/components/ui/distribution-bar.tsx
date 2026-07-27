import styles from "./distribution-bar.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";
import { EmptyState } from "./empty-state";

export type DistributionItem = {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  /** Secondary line, e.g. the parent module or lesson. */
  readonly sublabel?: string | undefined;
  /** Draws attention to one row without changing its rank. */
  readonly emphasis?: boolean | undefined;
};

export type DistributionBarProps = {
  readonly items: readonly DistributionItem[];
  readonly ariaLabel: string;
  readonly caption?: string | undefined;
  /**
   * Denominator for the share column. Defaults to the sum of the supplied
   * items — pass it explicitly whenever the list is truncated upstream, or the
   * shares will read as 100% of a partial set.
   */
  readonly total?: number | undefined;
  /** Trims the rendered rows and reports the remainder underneath. */
  readonly maxItems?: number | undefined;
  /** Sorts descending by value. On by default; turn off for a fixed order. */
  readonly rank?: boolean | undefined;
  readonly formatValue?: ((value: number) => string) | undefined;
  readonly onSelect?: ((item: DistributionItem) => void) | undefined;
  readonly emptyMessage?: string | undefined;
  readonly className?: string | undefined;
};

/**
 * Ranked horizontal bars with share-of-total, for question volume across
 * courses, modules or lessons. Bar length is relative to the largest row so
 * small differences stay visible; the percentage is always of the real total.
 */
export function DistributionBar({
  items,
  ariaLabel,
  caption,
  total,
  maxItems,
  rank = true,
  formatValue,
  onSelect,
  emptyMessage = "No questions have been attributed to this level yet.",
  className,
}: DistributionBarProps) {
  const ordered = rank
    ? [...items].sort((left, right) => right.value - left.value)
    : [...items];
  const shown = maxItems === undefined ? ordered : ordered.slice(0, maxItems);
  const sum = items.reduce((running, item) => running + item.value, 0);
  const denominator = total ?? sum;
  const peak = shown.reduce((running, item) => Math.max(running, item.value), 0);
  const hiddenCount = ordered.length - shown.length;
  const format = formatValue ?? ((value: number) => value.toLocaleString());

  if (shown.length === 0) {
    return (
      <EmptyState
        className={className}
        description={emptyMessage}
        headline="Nothing to rank"
      />
    );
  }

  return (
    <div className={cx(tokens.uiRoot, styles.distribution, className)}>
      {caption !== undefined && (
        <p className={styles.caption}>
          <span>{caption}</span>
          <span>{format(denominator)} total</span>
        </p>
      )}
      <ol aria-label={ariaLabel} className={styles.list}>
        {shown.map((item) => {
          const share = denominator > 0 ? item.value / denominator : undefined;
          const width = peak > 0 ? (item.value / peak) * 100 : 0;
          const body = (
            <>
              <span className={styles.name}>
                <b>{item.label}</b>
                {item.sublabel !== undefined && <small>{item.sublabel}</small>}
              </span>
              <span className={styles.figures}>
                <span className={styles.count}>{format(item.value)}</span>
                <span className={styles.share}>
                  {share === undefined ? "—" : `${Math.round(share * 100)}%`}
                </span>
              </span>
              <span className={styles.track}>
                <span
                  className={cx(
                    styles.fill,
                    item.emphasis === true && styles.fillEmphasis,
                  )}
                  style={{ width: `${width}%` }}
                />
              </span>
            </>
          );

          return (
            <li key={item.id}>
              {onSelect === undefined ? (
                <div
                  className={cx(
                    styles.row,
                    item.emphasis === true && styles.emphasis,
                  )}
                >
                  {body}
                </div>
              ) : (
                <button
                  className={cx(
                    styles.row,
                    styles.interactive,
                    item.emphasis === true && styles.emphasis,
                  )}
                  onClick={() => onSelect(item)}
                  type="button"
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {hiddenCount > 0 && (
        <p className={styles.remainder}>
          {hiddenCount} more not shown.
        </p>
      )}
    </div>
  );
}

export default DistributionBar;
