# UI Design System

## Direction

Calm, editorial and precise: warm neutral surfaces, restrained brand accents, generous whitespace, clear typographic hierarchy, evidence-forward cards and quiet motion. Do not begin from a generic admin template.

## Semantic tokens

Token families: `surface/{canvas,raised,overlay,inverse}`, `text/{primary,secondary,muted,inverse}`, `border/{subtle,strong,focus}`, `accent/{primary,soft,on}`, `status/{info,success,warning,danger,unknown}`, spacing 4px base, type scale, radii, shadow/elevation, z-index and motion. Tenant branding may map approved semantic accent/type/avatar tokens only.

Minimum contrast: WCAG 2.2 AA; target sizes ≥24px with 44px touch affordance; focus never color-only. Dark/light themes both required before production.

## Components

Primitives: button, icon button, link, field, select, combobox, switch, tabs, badge, tooltip, popover, dialog/sheet, toast, skeleton, progress, table/list, chart, empty state, error state. Product patterns: insight card, evidence quote, freshness badge, identity badge, opportunity score, integration health, cost metric, job row, provider route, message/source/diagram, voice controls and consent indicator.

Charts require text summaries, accessible tables/tooltips, units, time window and data-through timestamp. Red/green cannot be the only distinction.

## Motion

Use transform/opacity where possible; default 160ms, complex sheet 220ms, no decorative infinite motion. Streaming/recording indicators remain perceptible without flashing. `prefers-reduced-motion` removes spatial movement and preserves state changes.

## Governance

Mockups define the system before dashboard completion. Components need visual, keyboard, screen-reader, responsive and state stories. Tenant themes are validated before publish and fall back atomically to a known accessible theme.
