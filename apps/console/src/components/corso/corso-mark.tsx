import type { CSSProperties } from "react";

export type CorsoMarkProps = {
  className?: string;
  size?: number;
  color?: string;
  title?: string;
};

/**
 * The Corso open-course mark from the canonical v2 reference.
 * The gap is intentional: it is a loop with an entrance, not a closed system.
 */
export function CorsoMark({
  className,
  size = 24,
  color = "currentColor",
  title,
}: CorsoMarkProps) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={className}
      fill="none"
      height={size}
      role={title ? "img" : undefined}
      style={{ color } as CSSProperties}
      viewBox="0 0 24 24"
      width={size}
    >
      <path
        d="M19.4 6.4A9 9 0 1 0 21 12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.2"
      />
      <circle cx="12" cy="12" fill="currentColor" r="3.3" />
    </svg>
  );
}

export default CorsoMark;
