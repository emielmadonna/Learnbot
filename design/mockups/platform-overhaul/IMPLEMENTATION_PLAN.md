# LearningBot visible-product rebuild

## Outcome

LearningBot keeps the depth of the existing platform without exposing its
internal complexity. A first-time admin or client should be able to understand
the current screen, the available choices, and the next action without training.

This is a complete replacement of the visible product, not a restyle of the
current shell.

## Non-negotiable product rules

1. **One obvious place to start.** Admins land on client workspaces. Clients land
   on their workspace overview.
2. **One client context at a time.** The current client is always visible. No
   data, filter, or browser-restored state crosses between clients.
3. **Admin view and Client view are explicit.** The admin can switch between
   controls and an exact preview of what the client sees.
4. **Progressive disclosure.** The primary navigation contains only Overview,
   Bot, Learning, Analytics, Signals, and one Workspace settings destination.
5. **Visibility is not permission.** Hidden client sections remain available to
   authorized admins; server-side authorization remains authoritative.
6. **One primary action per screen.** Secondary actions stay quiet and appear
   near the object they affect.
7. **The same words everywhere.** UI, routes, API responses, empty states, and
   support material use the same product vocabulary.
8. **Light and dark are one system.** Both modes ship together and each client
   can use System, Light, or Dark as its default.
9. **Every bot is independently branded.** Identity, avatar/logo, accent,
   greeting, appearance, and bot experience are scoped per client.
10. **No legacy surface remains visible after cutover.** Capability parity is
    verified before the old UI is removed from navigation and routing.

## Final information architecture

### Platform admin

- **Client workspaces**
  - Search and filter clients
  - Open a client
  - Add a client
- **Client workspace — Admin view**
  - Overview
  - Bot
  - Learning
  - Analytics
  - Signals
  - Workspace settings
- **Client workspace — Client view**
  - Exact preview of the enabled client-facing sections

### Client

- **Overview**
- **Bot**
- **Learning**
- **Analytics** — only when enabled
- **Signals** — only when enabled

### Workspace settings

One destination contains client-visible feature access, bot identity, branding,
default appearance, client members, and advanced settings. Those concerns can
use sections within the page but do not compete in the primary navigation.

## Rebuild sequence

### 1. Lock the design contract

- Select one visual direction.
- Finalize desktop, tablet, and mobile mocks for every primary screen.
- Define shared tokens, components, loading/empty/error states, and motion.
- Approve the route map and exact product vocabulary.

**Exit gate:** the mock covers every primary destination and both appearances.

### 2. Inventory and preserve capability

- Map each existing RPC, workflow, permission, setting, and analytics source to
  its new destination.
- Mark duplicates for consolidation.
- Mark obsolete visible behavior for removal.
- Keep tenant isolation, authorization, ingestion, analytics, bot runtime,
  billing, and branding contracts intact unless a change is explicitly required.

**Exit gate:** every capability is either mapped, intentionally merged, or
explicitly retired.

### 3. Build the new foundation

- Introduce the new token system and shared components.
- Build the unified public and authenticated shells.
- Implement the admin workspace list and reliable client-context switching.
- Implement the Admin view / Client view contract.
- Put the new product behind one cutover flag while it is being completed.

**Exit gate:** authentication leads to the correct simple starting surface for
both platform admins and clients.

### 4. Migrate complete vertical workflows

Move functionality into the new surfaces in this order:

1. Workspace creation and client access
2. Bot configuration and live preview
3. Learning creation, upload, review, and publishing
4. Analytics and unanswered-question review
5. Signals and opportunity review
6. Per-client branding and light/dark defaults
7. Landing, sign-in, onboarding, account, billing, and recovery states

Each workflow is moved with its real data, mutations, permissions, success,
failure, loading, empty, and degraded states. A visual shell with dead controls
does not count as migrated.

**Exit gate:** each workflow works end-to-end on the new surface before the next
legacy destination is removed.

### 5. Verify parity and simplicity

- Role and tenant access tests
- Admin-hidden/client-visible section tests
- Exact Admin view / Client view parity tests
- Bot and learning mutation tests
- Analytics data accuracy tests
- Light/dark and per-client branding tests
- Keyboard, focus, contrast, responsive, and reduced-motion tests
- First-use usability pass with no prior explanation

**Exit gate:** no critical workflow requires the legacy UI and a first-time user
can complete the core path without instruction.

### 6. Cut over and remove the old product

- Make the new shell the only production entry.
- Remove legacy navigation, panels, drawers, and duplicate routes.
- Redirect only where a saved link has a clear new destination.
- Delete unused UI components and styling after data/permission parity is
  confirmed.
- Keep rollback at the release level, not as a permanent second UI.

**Exit gate:** there is one visible LearningBot product from landing page through
admin and client use.

## Definition of done

The rebuild is done only when:

- Admin login opens Client workspaces.
- A client opens in Admin view.
- Client view shows exactly what that client sees.
- The admin can enable or hide client sections without losing admin analytics.
- A client can configure the bot, add learning, and use enabled reporting
  without training.
- Each client bot has independent branding and appearance defaults.
- All controls shown in the new UI work against real platform data.
- All primary workflows work in light and dark modes on desktop and mobile.
- No current legacy surface is reachable through normal product navigation.
