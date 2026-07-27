# Console UI primitives

Shared vocabulary for the real Supabase-backed console. These components were
harvested out of the `/dev` fixture surfaces so the interaction design survives
when those surfaces are deleted.

```ts
import { Button, PanelFrame, StatTile, TextField } from "@/components/ui";
```

## Theming contract

**These primitives are chrome, and chrome is neutral.** The full rule lives at
the top of `components/app-shell/shell.module.css`; the short version:

| Property | Where it may appear |
| --- | --- |
| `--brand-primary` | Filled buttons, active nav, focus rings, links, small status accents |
| `--brand-accent` | Small accents only: dots, stripes, meter fills |
| `--brand-on-primary` | Text/glyph colour placed on `--brand-primary` |

`--brand-surface` and `--brand-text` are **not** part of this contract. They are
tenant-supplied *neutrals*, and deriving greys from them is what once painted
the entire console in one client's green.

Neutrals read straight from the Graphite tokens in `app/tokens.css`: `--ink`,
`--muted`, `--hairline`, `--bg`, `--surface`, `--elev`. Those are ground-aware
(dark by default, light via `prefers-color-scheme` or `[data-ground="light"]`)
and gated by `scripts/check-contrast.mjs`, which is the only way the documented
contrast ratios can be guaranteed whatever ground or colours a tenant ends up
on. Backgrounds, card surfaces, body text, borders and muted labels are always
neutral. There used to be a second neutral ramp here (`--ui-ink`, `--n-0` …
`--n-900`, fixed and never ground-aware); it is gone — see docs/PLAN.md Phase
16. If you see a `--ui-*` name in this codebase now, it is one of a small set
of derived aliases (a status wash, a shadow, a focus ring) that exist only
because Graphite has no token for them — never a competing neutral system.

No component hardcodes a brand colour. Status hues collapse onto Graphite's
two status colours, `--good` and `--warn` — there is no separate "danger",
"critical" or "notice" hue any more. They are mixed into the surface for
legibility but never inherit the brand, because a destructive action must not
read as "on brand".

Derived tokens live in `tokens.module.css` under the `.uiRoot` class, which each
component applies to its own root. Nothing outside this directory needs to know
about them, but they are available if you compose a new local element inside a
primitive.

Rules the primitives keep:

- Responsive; wide content scrolls inside its own container, never the page.
- Visible focus everywhere (`:focus-visible` outline from `--ui-focus`).
- `prefers-reduced-motion` respected.
- No dependencies beyond React.

---

## `PanelFrame`

Standard slide-in panel chrome: title block, close button, one scrolling body,
sticky footer for actions. Open/closed state and any backdrop stay with the
caller — this owns chrome and keyboard behaviour only.

```ts
type PanelFrameProps = {
  title: string;
  eyebrow?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;            // right-aligned footer actions
  footerLead?: ReactNode;        // left-aligned footer status text
  headerActions?: ReactNode;     // extra controls beside the close button
  onClose?: () => void;          // also bound to Escape
  closeLabel?: string;           // default "Close panel"
  side?: "right" | "left" | "inline";  // default "right"
  width?: string;                // CSS width for slide-in variants
  modal?: boolean;               // default false; true traps Tab + sets aria-modal
  autoFocus?: boolean;           // default true
  className?: string;
};
```

```tsx
<PanelFrame
  description="Changes stay in draft until you publish."
  eyebrow="Widget setup"
  footer={
    <>
      <Button onClick={rollback}>Rollback</Button>
      <Button loading={saving} onClick={publish} variant="primary">
        Publish branding
      </Button>
    </>
  }
  footerLead={dirty ? "Unsaved draft" : "Live"}
  onClose={close}
  title="Branding"
  width="520px"
>
  {/* fields */}
</PanelFrame>
```

## `Button`

```ts
type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";  // default "secondary"
  size?: "sm" | "md" | "lg";                                // default "md"
  loading?: boolean;        // spinner + aria-busy + blocks activation
  loadingLabel?: ReactNode; // replaces children while loading
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  fullWidth?: boolean;
  className?: string;
};
```

`type` defaults to `"button"`; pass `type="submit"` explicitly inside forms.

```tsx
<Button loading={saving} loadingLabel="Publishing…" onClick={publish} variant="primary">
  Publish
</Button>
<Button onClick={remove} variant="danger">Delete version</Button>
```

## `Field`, `TextField`, `TextAreaField`, `SelectField`

`Field` is the label / help / error scaffold. The three concrete fields wrap it
and handle `htmlFor`, `aria-describedby` and `aria-invalid` for you.

```ts
type SharedFieldProps = {
  label: string;
  id?: string;          // generated when omitted
  help?: string;
  error?: string;       // non-empty renders the inline error + marks invalid
  required?: boolean;
  hideLabel?: boolean;  // visually hidden, still announced
  className?: string;
};

type TextFieldProps     = SharedFieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className" | "required" | "aria-describedby" | "aria-invalid">;
type TextAreaFieldProps = SharedFieldProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, /* same */>;
type SelectFieldProps   = SharedFieldProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, /* same */> & {
  options: readonly { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;   // disabled first option
};

// Escape hatch for a control this module does not ship:
type FieldProps = SharedFieldProps & {
  children: (control: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": true | undefined;
    required: boolean;
  }) => ReactNode;
};
```

```tsx
<TextField
  error={nameError}
  help="Shown to learners in the assistant header."
  label="Assistant name"
  onChange={(event) => update("assistantName", event.target.value)}
  value={draft.assistantName}
/>

<SelectField
  label="Launcher style"
  onChange={(event) => update("launcherStyle", event.target.value)}
  options={[
    { value: "pill", label: "Pill" },
    { value: "circle", label: "Circle" },
    { value: "minimal", label: "Minimal" },
  ]}
  value={draft.launcherStyle}
/>

<Field label="Custom control" help="Anything not covered above.">
  {(control) => <MyWidget {...control} />}
</Field>
```

## `ColorField`

Swatch picker plus hex entry, with a live WCAG AA verdict. `onChange` only
fires with a canonical `#rrggbb` value; half-typed hex stays local and shows an
inline error. When a colour cannot be parsed the component reports "contrast not
checked" rather than claiming a pass.

```ts
type ColorFieldProps = {
  label: string;
  value: string;                    // "#rrggbb"
  onChange: (hex: string) => void;  // always canonical lowercase #rrggbb
  id?: string;
  help?: string;
  disabled?: boolean;
  className?: string;
  contrastAgainst?: string;         // enables the AA check
  contrastLevel?: "text" | "large-text" | "ui";  // default "text" (4.5:1)
  contrastLabel?: string;           // names the pair in the verdict copy
};
```

```tsx
<ColorField
  contrastAgainst={draft.surface}
  contrastLabel="primary on surface"
  label="Primary"
  onChange={(hex) => update("primary", hex)}
  value={draft.primary}
/>
```

Helpers are exported separately for non-UI use:

```ts
contrastRatio(a: string, b: string): number | undefined;  // undefined, never a guess
passesAA(ratio: number, level?: ContrastLevel): boolean;
normalizeHex(value: string): string | undefined;
isHexColor(value: string): boolean;
relativeLuminance(hex: string): number | undefined;
AA_THRESHOLD: Record<ContrastLevel, number>;
```

## `FileDrop`

Drag-and-drop image upload with preview, type/size validation and progress.
Presentational: it performs no fetching. You supply the transport.

```ts
type FileDropProps = {
  label: string;
  onUpload: (file: File, onProgress: (ratio: number) => void) => Promise<void>;
  previewUrl?: string | null;   // already-stored image
  placeholder?: string;         // glyph/initials when there is no image
  help?: string;
  accept?: readonly string[];   // default ["image/png","image/jpeg","image/svg+xml","image/webp"]
  maxBytes?: number;            // default 2 MB
  onRemove?: () => void;        // renders a Remove affordance when an image exists
  disabled?: boolean;
  id?: string;
  className?: string;
};
```

Reject the promise with an `Error` to surface its message inline. Call
`onProgress` with 0–1 when the transport can measure it; otherwise the bar runs
indeterminate.

```tsx
<FileDrop
  help="Square SVG or PNG."
  label="Logo"
  onRemove={() => update("logoUrl", null)}
  onUpload={async (file, onProgress) => {
    const url = await uploadLogo(file, onProgress);
    update("logoUrl", url);
  }}
  placeholder={initials}
  previewUrl={draft.logoUrl}
/>
```

## `StatTile` and `StateBadge`

Headline number with its provenance. The union type makes the honest path the
typed path: an unknown or restricted tile cannot compile without a `reason`, and
never renders a substitute zero.

```ts
type StatState = "known" | "partial" | "unknown" | "restricted";

type StatTileProps = {
  label: string;
  eyebrow?: string;
  sublabel?: string;   // one line under the value
  footnote?: string;   // footer context line
  asOf?: string;       // rendered as <time>
  hideBadge?: boolean;
  className?: string;
} & (
  | { state?: "known" | "partial"; value: string; reason?: string }
  | { state: "unknown" | "restricted"; value?: undefined; reason: string }
);

type StateBadgeProps = { state: StatState; children?: string; className?: string };
```

```tsx
<StatTile
  asOf="Jul 24, 4:15 PM"
  eyebrow="Lesson signal"
  footnote="Attributed questions per active learner"
  label="Confusion"
  sublabel="41 questions across 18 active learners"
  value="2.28 q / learner"
/>

<StatTile
  label="Module velocity"
  reason="Identity coverage below threshold · cohort median unavailable"
  state="unknown"
/>
```

## `DistributionBar`

Ranked horizontal bars with share-of-total, for question volume across courses,
modules or lessons. Bar length is relative to the largest row so small
differences stay visible; the percentage is always of the real total.

```ts
type DistributionItem = {
  id: string;
  label: string;
  value: number;
  sublabel?: string;
  emphasis?: boolean;
};

type DistributionBarProps = {
  items: readonly DistributionItem[];
  ariaLabel: string;
  caption?: string;
  total?: number;      // pass explicitly when items are truncated upstream
  maxItems?: number;   // trims rows and reports the remainder
  rank?: boolean;      // default true (sort descending)
  formatValue?: (value: number) => string;
  onSelect?: (item: DistributionItem) => void;  // rows become buttons
  emptyMessage?: string;
  className?: string;
};
```

Renders an `EmptyState` when there is nothing to rank.

```tsx
<DistributionBar
  ariaLabel="Questions by lesson"
  caption="Questions by lesson"
  items={lessons}
  maxItems={8}
  onSelect={(item) => openLesson(item.id)}
  total={allQuestionCount}
/>
```

## `TrendChart`

Dependency-free inline SVG line/area chart for volume over time. A `null` value
is a genuine gap — it breaks the line rather than being interpolated or
zero-filled — and a period with no observations renders an `EmptyState` instead
of a flat line at zero. A visually hidden `<dl>` carries the values for screen
readers.

```ts
type TrendPoint = { label: string; value: number | null };

type TrendChartProps = {
  points: readonly TrendPoint[];
  ariaLabel: string;
  caption?: string;
  height?: number;                  // default 96
  showArea?: boolean;               // default true
  baseline?: "zero" | "min";        // default "zero"
  formatValue?: (value: number) => string;
  emptyMessage?: string;
  className?: string;
};
```

```tsx
<TrendChart
  ariaLabel="Questions per day over the last 30 days"
  caption="Questions per day"
  points={days}
/>
```

## `EmptyState`

For data that is genuinely absent — not for a pending load.

```ts
type EmptyStateProps = {
  headline: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;    // usually a Button; omit when there is no honest next step
  tone?: "neutral" | "restricted" | "error";  // default "neutral"
  compact?: boolean;
  className?: string;
  children?: ReactNode;
};
```

```tsx
<EmptyState
  action={<Button onClick={addSource} variant="primary">Add learning</Button>}
  description="Questions appear here once learners have used the assistant on a published lesson."
  headline="No questions yet"
/>
```

## `Toggle`

Native button with `role="switch"`, so Space and Enter both work.

```ts
type ToggleProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  disabled?: boolean;
  hideLabel?: boolean;
  bordered?: boolean;   // divider underneath, for stacked lists
  id?: string;
  className?: string;
};
```

```tsx
<Toggle
  bordered
  checked={draft.attribution}
  description="Show “Powered by Learning OS” in the assistant footer."
  label="Platform attribution"
  onChange={(next) => update("attribution", next)}
/>
```

---

## Client vs server

`PanelFrame`, `Field` (and the field variants), `ColorField`, `FileDrop` and
`Toggle` are `"use client"` — they hold state or generate ids.
`Button`, `StatTile`, `StateBadge`, `DistributionBar`, `TrendChart` and
`EmptyState` have no hooks and render fine from a server component (as long as
you do not pass a handler from one).

## Provenance

| Primitive | Harvested from |
| --- | --- |
| `PanelFrame` | `dev/learning` inspector/outline panels, `dev/chat` sheet chrome |
| `Button` | `dev/branding` publish/rollback, `dev/intelligence` review actions |
| `Field` family | `dev/branding` control column, `dev/learning` inline forms |
| `ColorField` | `dev/branding` colour grid + contrast callout |
| `FileDrop` | `dev/branding` logo field |
| `StatTile` / `StateBadge` | `dev/intelligence` metric cards and known/partial/unknown pills |
| `DistributionBar` | `dev/creator` learner progress rows, `dev/intelligence` source coverage |
| `TrendChart` | new — the fixtures never drew one honestly |
| `EmptyState` | `dev/intelligence` empty audit trail |
| `Toggle` | `dev/branding` trust & attribution switches |
