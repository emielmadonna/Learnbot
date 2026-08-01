import { CorsoIcon, isCorsoIconName } from "./corso-icon";

export type BrandGlyphProps = {
  className?: string;
  size?: number;
  title?: string;
  /** The stored `iconGlyph`: either a Corso icon name or a literal character. */
  value: string | null | undefined;
  /** Used when `value` is empty — usually the tenant's derived initial. */
  fallback?: string;
};

/**
 * Renders a tenant's brand mark.
 *
 * `iconGlyph` is a free-text column, and for most of this product's life the
 * only thing that could go in it was one letter or an emoji. That is why the
 * configuration surface spoke a different visual language from the rest of the
 * console, where every piece of navigation is drawn with `CorsoIcon`: an admin
 * picked a typographic character while the product around it used the icon set.
 *
 * Resolving at render time closes that gap with no migration and no data
 * rewrite. A stored value that names a Corso icon draws the real SVG; anything
 * else keeps rendering as the literal character it always did, so every value
 * already saved stays valid and nothing needs backfilling.
 */
export function BrandGlyph({
  className,
  size = 24,
  title,
  value,
  fallback = "",
}: BrandGlyphProps) {
  const stored = (value ?? "").trim();

  if (isCorsoIconName(stored)) {
    // `exactOptionalPropertyTypes` is on, so an absent prop and a prop set to
    // `undefined` are different types. Spread only what was actually given.
    return (
      <CorsoIcon
        name={stored}
        size={size}
        {...(className === undefined ? {} : { className })}
        {...(title === undefined ? {} : { title })}
      />
    );
  }

  const text = stored || fallback.trim();
  if (text === "") return null;

  return (
    <span
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={className}
      role={title ? "img" : undefined}
      // The glyph path is typographic, so it scales with font-size rather than
      // the SVG's width/height. Matching `size` keeps both branches optically
      // identical wherever they are swapped for one another.
      style={{ fontSize: `${size}px`, lineHeight: 1 }}
    >
      {text}
    </span>
  );
}

export default BrandGlyph;
