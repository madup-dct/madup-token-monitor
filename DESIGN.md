---
version: alpha
name: Madup Console
description: A dark operator-console design system for the Madup Token Monitor. A near-black indigo canvas anchors elevated glass cards, with electric-azure as the lone interactive accent and a four-light signal palette (lime / amber / coral / violet) for status. Pretendard handles Korean copy; JetBrains Mono carries every numeric. Cards round at 14px, sit on hairline inner-highlights, and surface KPIs as oversized mono numerals over micro-sparklines.

colors:
  # Base canvas — deep indigo near-black; reads as a console window backdrop
  canvas-deep: "#070B17"
  canvas: "#0B1126"
  canvas-soft: "#11183A"
  vignette: "#1A2350"

  # Card surfaces — graduated from base toward elevated
  surface-1: "#121A33"
  surface-2: "#19233F"
  surface-3: "#22304D"
  surface-glass: "rgba(255,255,255,0.04)"

  # Borders & dividers — alpha so they sit cleanly over any surface tier
  hairline: "rgba(255,255,255,0.06)"
  hairline-strong: "rgba(255,255,255,0.12)"
  inner-highlight: "rgba(255,255,255,0.05)"
  outer-glow: "rgba(8,12,28,0.6)"

  # Type colors
  text-primary: "#E7ECF7"
  text-secondary: "#9CA8C5"
  text-tertiary: "#6A7593"
  text-faint: "#454E6A"
  text-on-accent: "#06122B"

  # Primary accent — Madup Electric Azure
  azure: "#4DA3FF"
  azure-bright: "#7BBCFF"
  azure-deep: "#2C7BE5"
  azure-soft: "rgba(77,163,255,0.14)"
  azure-glow: "rgba(77,163,255,0.35)"

  # Signal palette — status semantics
  lime: "#9BE15D"
  lime-deep: "#6CB23B"
  lime-soft: "rgba(155,225,93,0.14)"
  amber: "#F5B544"
  amber-deep: "#C88A1C"
  amber-soft: "rgba(245,181,68,0.14)"
  coral: "#FF6B5C"
  coral-deep: "#D43F2E"
  coral-soft: "rgba(255,107,92,0.14)"
  violet: "#B68CFF"
  violet-deep: "#8358D9"
  violet-soft: "rgba(182,140,255,0.14)"

  # Semantic aliases
  success: "#9BE15D"
  warning: "#F5B544"
  danger: "#FF6B5C"
  info: "#4DA3FF"

typography:
  display-xxl:
    fontFamily: JetBrains Mono
    fontSize: 64px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: -0.02em
  display-xl:
    fontFamily: JetBrains Mono
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: -0.02em
  display-lg:
    fontFamily: JetBrains Mono
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: -0.01em
  display-md:
    fontFamily: JetBrains Mono
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: -0.01em
  display-sm:
    fontFamily: JetBrains Mono
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0
  heading-lg:
    fontFamily: Pretendard
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.005em
  heading-md:
    fontFamily: Pretendard
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0
  heading-sm:
    fontFamily: Pretendard
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0
  body-lg:
    fontFamily: Pretendard
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  body-md:
    fontFamily: Pretendard
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  body-emphasis:
    fontFamily: Pretendard
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: 0
  caption-md:
    fontFamily: Pretendard
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  caption-sm:
    fontFamily: Pretendard
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0
  eyebrow:
    fontFamily: Pretendard
    fontSize: 10.5px
    fontWeight: 700
    lineHeight: 1.0
    letterSpacing: 0.16em
    textTransform: uppercase
  numeric-lg:
    fontFamily: JetBrains Mono
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: 0
  numeric-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0
  numeric-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0
  mono-tag:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: 0.04em
  button-md:
    fontFamily: Pretendard
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.0
    letterSpacing: 0
  button-sm:
    fontFamily: Pretendard
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.0
    letterSpacing: 0

rounded:
  none: 0px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  xxl: 20px
  pill: 9999px

spacing:
  px: 1px
  xxs: 4px
  xs: 6px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  xxl: 28px
  xxxl: 40px
  section: 56px

components:
  window-shell:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xxl}"
  title-bar:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.caption-md}"
    height: 36px
    padding: 0 {spacing.lg}
  sidebar-rail:
    backgroundColor: "rgba(7,11,23,0.6)"
    textColor: "{colors.text-secondary}"
    width: 224px
    padding: "{spacing.xl} {spacing.md}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.heading-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
    height: 36px
  nav-item-active:
    backgroundColor: "{colors.azure-soft}"
    textColor: "{colors.azure-bright}"
    rounded: "{rounded.md}"
  card:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xl}"
  card-elevated:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xl}"
  card-feature:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xxl}"
    padding: "{spacing.xxl}"
  kpi-block:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.display-xl}"
  stat-pill:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
    typography: "{typography.numeric-sm}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
  badge-delta-up:
    backgroundColor: "{colors.lime-soft}"
    textColor: "{colors.lime}"
    typography: "{typography.mono-tag}"
    rounded: "{rounded.sm}"
    padding: "3px 7px"
  badge-delta-down:
    backgroundColor: "{colors.coral-soft}"
    textColor: "{colors.coral}"
    typography: "{typography.mono-tag}"
    rounded: "{rounded.sm}"
    padding: "3px 7px"
  badge-status-success:
    backgroundColor: "{colors.lime-soft}"
    textColor: "{colors.lime}"
    typography: "{typography.caption-sm}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  badge-status-warning:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.amber}"
    typography: "{typography.caption-sm}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  badge-status-danger:
    backgroundColor: "{colors.coral-soft}"
    textColor: "{colors.coral}"
    typography: "{typography.caption-sm}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  segmented-bar-track:
    backgroundColor: "{colors.surface-3}"
    rounded: "{rounded.xs}"
    height: 10px
  segmented-bar-segment:
    rounded: "{rounded.xs}"
  ring-meter:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
  button-primary:
    backgroundColor: "{colors.azure}"
    textColor: "{colors.text-on-accent}"
    typography: "{typography.button-md}"
    rounded: "{rounded.md}"
    padding: "9px 14px"
    height: 34px
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.md}"
    padding: "9px 12px"
    height: 34px
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
    height: 34px
  icon-button:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    height: 32px
    padding: "0 {spacing.sm}"
  segmented-control:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.button-sm}"
    rounded: "{rounded.md}"
    height: 38px
  segmented-control-active:
    backgroundColor: "{colors.azure}"
    textColor: "{colors.text-on-accent}"
    rounded: "{rounded.sm}"
  source-carousel:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
    typography: "{typography.button-sm}"
    rounded: "{rounded.md}"
    height: 32px
    padding: "2px {spacing.xxs}"
  select-pill:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    height: 32px
    padding: "0 {spacing.md}"
  data-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-md}"
    padding: "{spacing.sm} 0"
  heatmap-cell:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.xs}"
    size: 16px
    gap: 4px
    interactive: false
  sparkline:
    strokeColor: "{colors.azure}"
    strokeWidth: 1.5
  divider:
    backgroundColor: "{colors.hairline}"
    height: 1px
---

## Overview

Madup Console reads like a flight-deck instrument cluster. The page sits on a near-black indigo canvas (`{colors.canvas}`) that fades subtly toward a brighter indigo (`{colors.canvas-soft}`) in the upper-left and back to deep black at the corners — a soft vignette that makes the elevated glass cards feel suspended rather than stuck on. There is one chromatic action color, **Electric Azure** (`{colors.azure}`), reserved for the active nav item, primary CTAs, the live data line on charts, and the running-total numerals on KPI cards.

The system reads in three layers from back to front: the **canvas vignette** (page background), the **card layer** (a single surface tier with a 1px inner highlight standing in for elevation), and the **inset surface** (a slightly brighter tier for embedded controls, list rows, and chart wells). Color contrast carries every layer change — no card-drop shadow ever has to do the lifting on its own.

Type is **strictly two-family**: Pretendard for Korean and Latin prose; JetBrains Mono for every numeral the user is asked to read — token counts, costs, percentages, timestamps, dates in lists. The mono numerals are oversized on KPI cards (`{typography.display-xl}` at 48px) so a single token figure dominates each card's reading hierarchy.

The signal palette is a deliberate **four-light system**: lime for healthy / positive deltas, amber for caution / warning quotas, coral for danger / failure, violet as a neutral fourth used for sessions and capacity-pacing. These four colors carry every status meaning on the dashboard; there is no fifth.

**Key Characteristics:**
- Near-black indigo canvas (`{colors.canvas}`) with a soft radial vignette toward `{colors.canvas-soft}` upper-left
- Three surface tiers (`{colors.surface-1}` → `{colors.surface-2}` → `{colors.surface-3}`) carry every layer of depth; no drop shadows on cards
- 1px inner-highlight (`{colors.inner-highlight}`) on every card top edge — a subtle glass lift, not a shadow
- Electric Azure (`{colors.azure}`) is the lone interactive accent: active nav, primary CTAs, current-period data line, running-total numerals
- Four signal lights (lime / amber / coral / violet) carry status — no fifth color is permitted
- JetBrains Mono on every numeral; Pretendard everywhere else — including button labels and headings
- Cards round at `{rounded.xl}` (14px) for utility cards, `{rounded.xxl}` (20px) for the outer window shell and feature cards
- Layout is fixed-rail sidebar (224px) + fluid card grid; the window itself rounds at the shell layer

## Colors

### Brand & Accent
- **Electric Azure** (`{colors.azure}` — `#4DA3FF`): the system's lone interactive color. Active nav indicator, primary CTA fill, current-period chart line, large running-total numerals. Reserve to one or two flame elements per viewport.
- **Azure Bright** (`{colors.azure-bright}` — `#7BBCFF`): hover state for primary CTA and the bright pole of the azure-soft fill that lights focused inputs.
- **Azure Deep** (`{colors.azure-deep}` — `#2C7BE5`): pressed state for primary CTA, and the comparison/prior-period chart line that sits behind the bright current line.
- **Azure Soft** (`{colors.azure-soft}` — alpha `#4DA3FF` at 14%): active nav item fill, focus halo, selected-row tint.

### Surface
- **Canvas** (`{colors.canvas}` — `#0B1126`): the universal page background.
- **Canvas Deep** (`{colors.canvas-deep}` — `#070B17`): the outer letterbox around the window shell.
- **Canvas Soft** (`{colors.canvas-soft}` — `#11183A`): the brighter pole of the vignette gradient, placed upper-left of the viewport.
- **Vignette** (`{colors.vignette}` — `#1A2350`): the brightest local hot-spot in the gradient, ~30% opacity at the top-left corner.
- **Surface 1** (`{colors.surface-1}` — `#121A33`): the default card background.
- **Surface 2** (`{colors.surface-2}` — `#19233F`): inset / embedded surfaces — list-row backgrounds, icon buttons, segmented controls.
- **Surface 3** (`{colors.surface-3}` — `#22304D`): the brightest surface tier — segmented bar tracks, heatmap empty cells, segmented control active slot.
- **Surface Glass** (`{colors.surface-glass}` — white at 4%): the additive lift placed on a card's top half to fake a glass-pane reflection.

### Text
- **Text Primary** (`{colors.text-primary}` — `#E7ECF7`): default body and headline color on every surface.
- **Text Secondary** (`{colors.text-secondary}` — `#9CA8C5`): subdued body color — descriptions, secondary metadata, nav labels (inactive).
- **Text Tertiary** (`{colors.text-tertiary}` — `#6A7593`): the lowest legible tier — eyebrows, timestamps, axis labels.
- **Text Faint** (`{colors.text-faint}` — `#454E6A`): non-content text — empty-state placeholders, dim divider labels.
- **Text on Accent** (`{colors.text-on-accent}` — `#06122B`): near-black text used on Electric Azure fills (primary CTA, active segmented option). The deep canvas tone keeps the contrast cool, not a flat white.

### Signal — Four-Light Status
- **Lime** (`{colors.lime}` — `#9BE15D`): success, positive deltas, healthy quota, completed sessions. Used as the bright pole; `{colors.lime-deep}` for filled regions, `{colors.lime-soft}` for fill backgrounds.
- **Amber** (`{colors.amber}` — `#F5B544`): warning, mid-quota (40–80%), cost figures. Used for the cost numeral on the Today card — cost is "spending" attention, not "performance."
- **Coral** (`{colors.coral}` — `#FF6B5C`): danger, failed sessions, over-quota (≥80%), destructive actions. Used sparingly — at most one coral element per viewport unless the page is reporting an actual error state.
- **Violet** (`{colors.violet}` — `#B68CFF`): a neutral fourth used for the session count, pacing indicators, and the "current week" highlight on the heatmap. Distinguishes structural metrics from performance metrics.

The signal four-light is **exhaustive**. There is no green that is not lime, no red that is not coral, no orange that is not amber. If a new meaning needs a color, find a way to express it inside the existing four or with text weight + an inline glyph.

## Typography

### Two-Family System

The system is **strictly two-family**:

- **Pretendard** carries every Korean character and every Latin word — headings, body copy, button labels, captions, nav. Pretendard sits across weights 400 / 500 / 600 / 700 with a wide Hangul x-height that holds up at 11–18px.
- **JetBrains Mono** carries every numeral the user is asked to read — KPI figures, percentages, costs, dates inside data lists, session timers, model token counts. Mono numerals are tabular by default; no figure dancing in dashboards. Run JetBrains Mono at weight 400 for inline numbers and 500 for KPI displays.

Numbers in flowing prose ("7 sessions today") stay in Pretendard. Numbers in data cells, headlines, or stat blocks switch to JetBrains Mono. The split is by role, not by digit.

### Hierarchy

| Token | Size | Weight | Family | Use |
|---|---|---|---|---|
| `{typography.display-xxl}` | 64px | 500 | JetBrains Mono | The very largest KPI numeral (rare, reserved for the running team-wide total) |
| `{typography.display-xl}` | 48px | 500 | JetBrains Mono | Today-card running total — the dashboard's headline numeral |
| `{typography.display-lg}` | 36px | 500 | JetBrains Mono | Week / Month running totals |
| `{typography.display-md}` | 28px | 500 | JetBrains Mono | Secondary KPI on side cards (e.g., session count) |
| `{typography.display-sm}` | 20px | 500 | JetBrains Mono | List-row featured values, ring-meter center label |
| `{typography.heading-lg}` | 18px | 600 | Pretendard | Card title (`이번 주`, `사용량 한도`) |
| `{typography.heading-md}` | 16px | 600 | Pretendard | Sub-section headers inside a card |
| `{typography.heading-sm}` | 14px | 600 | Pretendard | Nav labels, list-section headers |
| `{typography.body-lg}` | 15px | 400 | Pretendard | Lead paragraphs (rare on dashboard) |
| `{typography.body-md}` | 13px | 400 | Pretendard | Default body, list-row labels |
| `{typography.body-emphasis}` | 13px | 500 | Pretendard | Bolded run-in inside body |
| `{typography.caption-md}` | 12px | 400 | Pretendard | Secondary captions, axis labels |
| `{typography.caption-sm}` | 11px | 500 | Pretendard | Status badges, footnotes |
| `{typography.eyebrow}` | 10.5px | 700 | Pretendard | Card eyebrows (`오늘`, `이번 달`) — UPPERCASE 0.16em tracked |
| `{typography.numeric-lg}` | 22px | 500 | JetBrains Mono | Inline running totals inside list rows |
| `{typography.numeric-md}` | 14px | 500 | JetBrains Mono | Default numeric cell |
| `{typography.numeric-sm}` | 12px | 500 | JetBrains Mono | Compact numeric cell — segment percentages, dates |
| `{typography.mono-tag}` | 11px | 500 | JetBrains Mono | Mono badge label — delta percentages, status counts |
| `{typography.button-md}` | 13px | 600 | Pretendard | Primary / secondary button labels |
| `{typography.button-sm}` | 12px | 600 | Pretendard | Compact button labels (segmented controls, icon buttons) |

### Principles

The dashboard's headline reading sequence is **eyebrow → KPI → context**: every card opens with a Pretendard 10.5px eyebrow at `{colors.text-tertiary}`, lifts into a 28–48px JetBrains Mono numeral at `{colors.azure}`, and lands in 12–13px Pretendard secondary copy at `{colors.text-secondary}`. The pattern repeats six times across the dashboard; it is the primary rhythm.

Button labels are **lowercase Pretendard**, not uppercase. The system uses uppercase for **eyebrows only** — the small tracked-out labels that name a card. Buttons read as inline prose; eyebrows read as section markers.

There is **no italic** anywhere. Emphasis is weight (500 → body-emphasis, 600 → heading-md). Hierarchy is family and size, not style.

### Font Stack

```
font-family: "Pretendard Variable", Pretendard, -apple-system,
             BlinkMacSystemFont, system-ui, "Helvetica Neue",
             "Noto Sans KR", sans-serif;

/* For numerals — apply via .num class or a Tailwind utility */
font-family: "JetBrains Mono", "SF Mono", ui-monospace,
             "Cascadia Mono", Menlo, Consolas, monospace;
font-feature-settings: "tnum", "zero", "ss01";
```

## Layout

### Window Shell

The app launches as a free-floating macOS window — not a popover. The window opens at 1440 × 900 by default, with a minimum of 1200 × 760. The shell rounds at `{rounded.xxl}` (20px) and sits on a `{colors.canvas-deep}` letterbox if the OS reveals it.

A 36px **title bar** runs across the top of the shell with the traffic-light controls at the left, the app title (`매드업 토큰 모니터`) centered in 13px Pretendard at `{colors.text-secondary}`, and a connection-status pill at the right. The title bar is `data-tauri-drag-region` for window dragging.

### Sidebar Rail

A 224px **sidebar rail** sits flush-left under the title bar, against a slightly darker tint (`rgba(7,11,23,0.6)`) than the page canvas. The rail holds:

- **Brand row** at the top — the Madup mark + the word-mark `MADUP CONSOLE` in 12px Pretendard 600 tracked at 0.06em
- **Nav list** — five items: Dashboard / MCP / Plugins / Leaderboard / Chat — each a 36px row with a 16px icon and a 14px Pretendard label
- **Spacer** with a divider above the user block
- **User block** at the bottom — 28px avatar + name + email in two lines, with a Settings gear and Sign-out icon flush right

Active nav item draws `{colors.azure-soft}` fill + `{colors.azure-bright}` text. Inactive nav items default to `{colors.text-secondary}` text on a transparent fill. There is **no hover state** documented; on touch screens this falls back to the active state on tap.

### Grid & Container

- **Sidebar**: 224px fixed
- **Content**: fluid, minimum 976px, with `{spacing.xxl}` (28px) padding on every side and `{spacing.lg}` (16px) gaps between cards
- **Default grid**: 12 columns inside the content area; cards span any whole number of columns
- **Common spans**: 8 + 4 (KPI + side), 6 + 6 (two equal cards), 3 + 3 + 3 + 3 (four-up bottom row), 8 + 4 (chart + breakdown)

### Whitespace Philosophy

The dashboard is **dense but breathable**. Cards keep `{spacing.xl}` (20px) internal padding — generous enough that the eye separates the eyebrow from the KPI, tight enough that the dashboard never feels half-empty. Section gaps stay at `{spacing.lg}` (16px); collapsing further reads as cramped.

The single most important whitespace move is **the gap between the eyebrow and the KPI numeral**: `{spacing.md}` (12px). Smaller than that and the eyebrow reads as a label, not a section start. The numeral has to feel like it earned a hard return.

## Elevation & Depth

The system has **no drop shadows**. Every layer change is communicated by surface contrast.

| Level | Treatment | Use |
|---|---|---|
| 0 — Canvas | `{colors.canvas}` with radial vignette toward `{colors.canvas-soft}` upper-left | Page background |
| 1 — Surface 1 | `{colors.surface-1}` + 1px top-edge `{colors.inner-highlight}` | Default card |
| 2 — Surface 2 | `{colors.surface-2}` | Embedded controls inside a card — segmented controls, icon buttons, list-row hover, focused input |
| 3 — Surface 3 | `{colors.surface-3}` | Track surfaces — segmented-bar tracks, heatmap empty cells, segmented-control active backdrop |

The 1px **inner highlight** on every card's top edge is the system's signature depth gesture. Rendered as a `linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 1.5px)` background blended on top of the card fill, it reads as a glass pane catching ambient light. Bottom edge gets no equivalent; the unevenness is intentional and makes the card feel suspended from the top.

The **window-shell** sits on the `{colors.canvas-deep}` letterbox with a single 1px `{colors.hairline-strong}` outer stroke and no shadow. The OS-level drop shadow under the window provides any depth beyond the shell border.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0 | Title-bar surface (it bleeds into the shell rounding above), chart axes |
| `{rounded.xs}` | 4px | Segmented-bar segments, heatmap cells, mono tags |
| `{rounded.sm}` | 6px | Stat pills, focus rings, small chips |
| `{rounded.md}` | 8px | Buttons, inputs, segmented controls, icon buttons, nav items |
| `{rounded.lg}` | 10px | Sub-cards, inline panels inside a card |
| `{rounded.xl}` | 14px | Default card |
| `{rounded.xxl}` | 20px | Window shell, feature card |
| `{rounded.pill}` | 9999px | Status badges, avatar masks, ring-meter handles |

The two-tier philosophy is the same as any modern dashboard: **interactive elements stay tighter** (6–8px) than container surfaces (14–20px). The 14/20 split between card and shell echoes the iOS app shell language without quoting it directly.

## Components

> Only Default and Active/Pressed states are documented for every component below. Variants live as separate front-matter entries.

### Buttons

**`button-primary`** — the lone Electric Azure CTA
- Background `{colors.azure}`, text `{colors.text-on-accent}`, type `{typography.button-md}`, rounded `{rounded.md}`, padding 9px 14px, height 34px
- Used for: 새로고침 quota button, 새 메시지 send, primary form submit, Slack 로그인 CTA
- Pressed: background `{colors.azure-deep}`

**`button-outline`** — neutral secondary CTA
- Background transparent, text `{colors.text-primary}`, 1px `{colors.hairline-strong}` border, rounded `{rounded.md}`, padding 8px 14px
- Used for: Copy / Export buttons in the daily list

**`button-ghost`** — invisible action
- Background transparent, text `{colors.text-secondary}`, rounded `{rounded.md}`, padding 9px 12px
- Used for: title-bar Settings / Sign-out triggers, card-header overflow menus

**`icon-button`** — compact icon affordance
- Background `{colors.surface-2}`, text `{colors.text-secondary}`, rounded `{rounded.md}`, height 32px
- Used for: refresh / overflow / filter triggers on card headers

### Segmented Controls & Pills

**`segmented-control`** + **`segmented-control-active`** — the inline filter group
- Default: background `{colors.surface-2}`, text `{colors.text-secondary}`, height 38px, rounded `{rounded.md}`, padding 0 around two-to-four child buttons with 32px minimum height
- Active option: background `{colors.azure}`, text `{colors.text-on-accent}`, inner-rounded `{rounded.sm}` to nest inside the outer track
- Used for: Tokens/Cost toggle, Chart/List toggle, granularity (Daily/Weekly/Monthly)

**`source-carousel`** — the global token-source selector
- Three manually controlled faces in the fixed order `통합` → `Claude` → `Codex`; `통합` means exactly Claude + Codex and never includes future providers implicitly
- Header control uses previous/next icon buttons plus three labeled position dots; the active face name stays visible so every downstream token value has an explicit source context
- Arrow and dot buttons keep non-overlapping 32 × 32px targets and sit edge-to-edge, avoiding extra gaps that make the compact control feel disconnected
- The quota/summary card body uses a horizontal slide (`500ms`, `ease-out`) so the outgoing and incoming source remain visible throughout the transition, while all token-related dashboard values update from the same persisted selection
- No automatic rotation. A data source must never change without a user action
- `Claude` shows OAuth 5h/7d limits when available. `Codex` shows the latest account `rate_limits.used_percent` recorded in Codex rollout events, including each window and model-specific limit. A window whose reset time has passed is labeled `갱신 대기` instead of displaying the stale percentage
- `통합` shows absolute Claude + Codex token summaries because percentages from different provider contracts cannot be added. Claude OAuth percentages must never be relabeled as Codex data
- The `계정 한도` page combines team-visible Claude and Codex account snapshots in one list. Every row carries an explicit provider badge, Codex plan metadata when present, and a provider-qualified identity key
- Account-limit sorting compares normalized 5h, weekly, or model-specific windows. When an account has multiple model windows, its lowest remaining model allowance determines its sort position
- Codex ownership resolves through the stable account-ID override. Without an override, the immutable original uploader's team is the fallback owner scope; an override replaces that fallback with the explicitly mapped owner team
- Keyboard: every arrow and dot is a native button with a source-specific accessible name; focus stays on the activated control after rotation
- Reduced motion: replace the slide with the existing cross-fade fallback and retain the same content order

**`select-pill`** — dropdown filter
- Background `{colors.surface-2}`, text `{colors.text-primary}`, rounded `{rounded.md}`, height 32px, padding 0 12px, with a 10px caret on the right

**`stat-pill`** — a numeric chip sitting next to a label
- Background `{colors.surface-2}`, text `{colors.text-primary}`, rounded `{rounded.sm}`, padding 3px 8px, type `{typography.numeric-sm}`

### Badges

**`badge-delta-up`** + **`badge-delta-down`** — directional deltas
- Up: background `{colors.lime-soft}`, text `{colors.lime}`, type `{typography.mono-tag}`, rounded `{rounded.sm}`, padding 3px 7px, leading `+` glyph
- Down: background `{colors.coral-soft}`, text `{colors.coral}`, same shape, leading `−` glyph
- Used for: "+12% vs 7d 평균" delta indicators on the Today card

**`badge-status-success` / `badge-status-warning` / `badge-status-danger`** — pill statuses
- Background `{signal-soft}`, text `{signal}`, type `{typography.caption-sm}`, rounded `{rounded.pill}`, padding 3px 10px
- Used for: quota status, connection status, message statuses

### Cards

**`card`** — the default card
- Background `{colors.surface-1}`, rounded `{rounded.xl}` (14px), padding `{spacing.xl}` (20px), 1px top inner-highlight `{colors.inner-highlight}`
- Layout: eyebrow → KPI numeral → secondary copy → optional sparkline / mini-stat row

**`card-elevated`** — embedded surface for nested content
- Background `{colors.surface-2}`, same rounding and padding
- Used for: chart wells embedded inside a parent card

**`card-feature`** — the dashboard hero card (the Today card)
- Background `{colors.surface-1}`, rounded `{rounded.xxl}` (20px), padding `{spacing.xxxl}` (28px)
- Sized to span 8 of 12 columns at default desktop width

### KPI Block

A KPI block (`kpi-block`) is not a card on its own — it lives inside a card. It is the **eyebrow → numeral → context** stack used six times across the dashboard:

- Eyebrow: `{typography.eyebrow}` in `{colors.text-tertiary}`, margin-bottom `{spacing.md}`
- Numeral: `{typography.display-xl}` (48px JetBrains Mono) in `{colors.azure}` for the active running total
- Suffix: small inline `{typography.body-md}` Pretendard "tokens" / "원" caption at `{colors.text-secondary}`, baseline-aligned next to the numeral
- Context row: `{typography.caption-md}` at `{colors.text-secondary}` with optional delta badge

Cost KPIs swap the azure numeral for `{colors.amber}`. Session-count KPIs swap to `{colors.violet}`. Request-count KPIs stay azure (azure = "the thing we're measuring; the running total").

### Charts

**`sparkline`** — inline mini-line
- 1.5px stroke `{colors.azure}`, no fill, no axes, no points — pure shape
- Sized to a 96 × 28 cell that sits at the bottom-right of a KPI card

**Bar chart (Daily)**
- Bars in `{colors.azure}` at full saturation for the most recent period, `{colors.azure-deep}` for comparison periods
- 2px gap between bars, 8px corner radius on top corners only, flat bottom
- X-axis: `{typography.caption-md}` in `{colors.text-tertiary}`; Y-axis is hidden — a single horizontal hairline at `{colors.hairline}` separates bars from the axis row

**Line chart (Hourly / Trends)**
- Current line: 2px stroke `{colors.azure}` with a single 8px filled circle at the latest data point
- Comparison line: 1.5px stroke `{colors.azure-deep}` at 60% opacity, no points
- Gradient fill from `{colors.azure-soft}` to transparent below the current line — a 30% opacity wash, no harder than that

**`ring-meter`** — donut for percentage quotas
- 8px stroke, rounded line cap, full ring at `{colors.surface-3}` in the back, active arc in the signal color
- Center label: `{typography.display-sm}` (20px Mono) the percentage; below it `{typography.caption-md}` the metric name
- Stroke color: `{colors.lime}` (0–40%), `{colors.amber}` (40–80%), `{colors.coral}` (80–100%)

**`segmented-bar`** — the 12-segment quota meter from the original popup
- Track: `{colors.surface-3}`, rounded `{rounded.xs}`, height 10px, 12 segments separated by 2px gaps
- Filled segments use the same signal-color ramp as `ring-meter`
- Stays in the system because it expresses pacing-in-time (this many ticks remain) better than a continuous bar

**`heatmap-cell`** — activity heatmap unit
- Non-interactive 16 × 16px data marks with `{rounded.xs}` corners and a 4px gap between cells
- Each date exposes an accessible graphic label and a hover tooltip; heatmap marks do not behave like action buttons
- Five-step ramp from `{colors.surface-2}` (empty) → `{colors.azure-deep}` (1) → `{colors.azure}` (2) → `{colors.azure-bright}` (3) → `{colors.violet}` (4, today / current period accent only)

### Data Rows

**`data-row`** — list row inside a card
- Padding `{spacing.sm} 0`, dividers as 1px `{colors.hairline}` between rows (not above the first; not below the last)
- Left: `{typography.body-md}` label; Right: `{typography.numeric-md}` in `{colors.azure}` (or signal color if marked)
- Empty / zero rows: row opacity drops to 50%; numeric replaces with "—" in `{colors.text-faint}`

### Mini-Bar List

**`mini-bar-list`** — the breakdown component for tool cost / model usage
- Each row: label flush left at `{colors.text-primary}`, value flush right at `{colors.azure}` in `{typography.numeric-md}`, then a 4px-tall thin bar below at full row width filled to the relative value
- Bar uses `{colors.azure-deep}` for the fill and `{colors.surface-3}` for the unfilled track
- Bars all share the same scale (the max-value row fills 100%)

### Title Bar

**`title-bar`** — top window strip
- Height 36px, background transparent (the canvas vignette shows through), `data-tauri-drag-region`
- Left: 3 macOS traffic-light circles at 12px diameter, 8px gaps
- Center: `매드업 토큰 모니터` in `{typography.caption-md}` at `{colors.text-secondary}`
- Right: connection status pill (`{badge-status-*}`), then a `{button-ghost}` overflow trigger

### Sidebar

**`sidebar-rail`** — fixed-left navigation
- Width 224px, background `rgba(7,11,23,0.6)`, no border (the canvas tone shift carries the separation)
- Padding `{spacing.xl} {spacing.md}` (20 / 12)
- 1px right-edge `{colors.hairline}` divider

**`nav-item`** + **`nav-item-active`**
- Default: background transparent, text `{colors.text-secondary}` in `{typography.heading-sm}`, height 36px, rounded `{rounded.md}`, padding `{spacing.sm} {spacing.md}` (8 / 12), 16px stroke icon flush left in `{colors.text-tertiary}`
- Active: background `{colors.azure-soft}`, text `{colors.azure-bright}`, icon switches to `{colors.azure}`

## Do's and Don'ts

### Do
- Lead every card with the **eyebrow → numeral → context** stack — six repetitions across the dashboard establish the rhythm
- Reserve Electric Azure for the active nav, primary CTA, and the running-total numeral — at most two flame elements per viewport
- Set every numeral the user reads in **JetBrains Mono** — token counts, costs, percentages, dates, timers, session counters
- Use the four-light signal palette exhaustively — lime / amber / coral / violet — and resist inventing a fifth status color
- Communicate elevation through **surface contrast** (`{colors.surface-1}` → `{colors.surface-2}` → `{colors.surface-3}`); no drop shadows on cards
- Put the 1px top-edge inner-highlight on every card; let the bottom edge stay unlit (the unevenness is the gesture)
- Run buttons in **lowercase Pretendard 600**; reserve UPPERCASE 0.16em tracking for **eyebrows only**

### Don't
- Don't replace the four-light signal palette with general dashboard reds, greens, oranges — the four are deliberate
- Don't apply drop shadows to cards; the system reads layers via surface contrast, not Material lift
- Don't put numerals inside flowing prose in JetBrains Mono — the family split is by role (data vs. prose), not by digit
- Don't put the inner-highlight on all four edges; the asymmetric top-only highlight is the gesture
- Don't round buttons above `{rounded.md}` (8px); pill-rounded buttons read as a different brand
- Don't introduce a fifth surface tier; three (canvas + surface-1 + surface-2 + surface-3) is the entire depth vocabulary
- Don't run the sidebar wider than 224px; cards collapse below 976px content width and the layout breaks

## Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Compact | 1200–1339px | 12-col grid collapses to 8-col; four-up bottom row stacks to 2x2; cards keep their padding |
| Default | 1340–1599px | Full 12-col grid; sidebar fixed at 224px |
| Wide | ≥ 1600px | Content max-width caps at 1440px; sidebar stays 224px; left/right margins grow |

There is no mobile breakpoint — this is a desktop app with a minimum window size of 1200 × 760. Window resizes below the minimum trigger an OS-level resize fence; nothing collapses inside.

### Cards Collapse Order

When the viewport drops below default width, cards collapse in this order:
1. The four-up bottom row (Week / Month / Tool / Model) becomes a 2x2 grid
2. The 8 + 4 KPI + Quota row becomes stacked, full-width
3. The Activity heatmap card collapses its row count from 8 weeks to 6 weeks

### Touch Targets

Every interactive element clears 32 × 32px (this is a mouse-first desktop product; pointer targets are smaller than mobile but not below 32px). Title-bar icons and segmented-control segments sit at 32px height, while nav items sit at 36px.

The `source-carousel` remains a single compact row at the 1200px minimum window width. Its arrow buttons keep a 32px hit area even when the visible icon is smaller, and the active source label must not truncate in Korean or English.

## Iteration Guide

1. Reference component names and tokens directly (`{colors.azure}`, `{typography.display-xl}`, `{rounded.xl}`, `card-feature`) — never paraphrase to hex/px in component prose
2. Keep `{colors.azure}` scarce — at most two flame elements per viewport (the active nav + one KPI numeral, or the active nav + one CTA)
3. Add new card variants by tier (`card`, `card-elevated`, `card-feature`); never invent a new surface color outside the three-tier system
4. Status colors are deliberate; if a new meaning needs visual distinction, find a way inside the existing four lights or use text weight + an inline glyph
5. The eyebrow → numeral → context rhythm is the system's signature; new cards must honor it before they earn a custom layout
6. Default body to `{typography.body-md}`; reach for `{typography.body-emphasis}` for run-in bolds; never substitute italic
