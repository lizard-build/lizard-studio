# Lizard — Brand Design System

## Typography

Font: **Geist Sans** (`'Geist', sans-serif`)

| Token | Size/Leading | Weight | Usage |
|---|---|---|---|
| Body 10 | 10/14 | Medium (500) | Labels, metadata |
| Body 12 | 12/16 | Medium (500) | Section labels, form labels |
| Body 12 | 12/18 | Medium (500) | Secondary body text, descriptions |
| Title 12 | 12/18 | Semibold (600) | Small titles, table headers |
| Body 14 | 14/20 | Regular (400) | Primary body text |
| Title 14 | 14/20 | Semibold (600) | Card titles, nav items |
| Title 24 | 24/32 | Semibold (600) | Page titles, section headers |
| Title 32 | 32/40 | Semibold (600) | Hero titles, main headings |

**Always sentence case.** Never use all-caps / uppercase for labels, section
headers, metadata, or anything else — not even via `text-transform: uppercase`.

## Colors

### Background (locked)

| Token | Value | Usage |
|---|---|---|
| `--bg-primary` | `#070707` | Main background |
| `--bg-secondary` | `#141414` | Cards, surfaces, inputs |

### Border (locked)

| Token | Value | Usage |
|---|---|---|
| `--border-primary` | `#2E2E2E` | Default borders |
| `--border-secondary` | `rgba(255, 255, 255, 0.08)` | Subtle dividers |

### Text & Icons (locked)

| Token | Value | Usage |
|---|---|---|
| `--text-primary` | `#E9EDF4` | Headings, primary content |
| `--text-secondary` | `#858B94` | Body text, descriptions |
| `--text-tertiary` | `#5F646D` | Hints, timestamps, metadata |

### Control

| Token | Value | Usage |
|---|---|---|
| `--control-primary` | `#10B981` | Primary buttons, links, active states |
| `--control-primary-hover` | `#059669` | Primary hover state |
| `--control-secondary` | `#2E2E2E` | Secondary buttons, toggles |
| `--control-secondary-hover` | `#3B3B3B` | Secondary hover state |

### Gradient

| Token | Value | Usage |
|---|---|---|
| `--gradient-primary` | `linear-gradient(135deg, #10B981, #D4A574)` | Hero accents, upgrade CTAs, accent lines. Use sparingly. |

Gradient goes from Emerald (#10B981) to Champagne Gold (#D4A574).

### Semantic / Other

| Token | Value | Usage |
|---|---|---|
| `--other-red` | `#EF4444` | Errors, destructive actions |
| `--other-yellow` | `#F59E0B` | Warnings, pending states |
| `--other-blue` | `#3B82F6` | Info, in-progress states (deploying) |
| `--other-bronze` | `#B08D57` | Premium/bronze tier |

For success / healthy / running states use `--control-primary` (`#10B981`). The palette has a single green — the brand emerald — to keep the system coherent.

## Badge patterns

Badges use 12% opacity background of their semantic color:

- Running / Healthy: `bg: rgba(16, 185, 129, 0.12)` / `color: #34D399`
- Error: `bg: rgba(239, 68, 68, 0.12)` / `color: #F87171`
- Deploying: `bg: rgba(245, 158, 11, 0.12)` / `color: #FBBF24`

## Gradient card pattern

```
background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(212, 165, 116, 0.08));
border: 1px solid rgba(16, 185, 129, 0.2);
```

## Primary Button

Use the `btn-emerald` CSS class + sizing utilities. Font is always **Semibold**.

### Sizes

| Size | Height | Padding X | Radius | Font | Icon gap |
|---|---|---|---|---|---|
| Mini | 24px (`h-6`) | 8px (`px-2`) | 4px (`rounded`) | 12px Semibold | 6px (`gap-1.5`) |
| Small | 32px (`h-8`) | 12px (`px-3`) | 8px (`rounded-lg`) | 12px Semibold | 6px (`gap-1.5`) |
| Regular | 36px (`h-9`) | 16px (`px-4`) | 8px (`rounded-lg`) | 14px Semibold | 8px (`gap-2`) |
| Large | 40px (`h-10`) | 24px (`px-6`) | 8px (`rounded-lg`) | 14px Semibold | 8px (`gap-2`) |

### States

| State | Background | Border |
|---|---|---|
| Default | `rgba(16,185,129,0.5)` | `1px solid #10B981` |
| Hover/Active | `#10B981` (solid) | border stays |
| Disabled | `rgba(16,185,129,0.5)` + `opacity: 0.5` | `1px solid #10B981` |

### Usage

```html
<!-- Regular (most common) -->
<button class="h-9 px-4 rounded-lg btn-emerald text-sm font-semibold text-white flex items-center gap-2">
  <Icon class="w-3.5 h-3.5" /> Label
</button>

<!-- Small -->
<button class="h-8 px-3 rounded-lg btn-emerald text-xs font-semibold text-white flex items-center gap-1.5">
  Label
</button>
```

## Secondary Button

For non-primary actions (Billing, Cancel, secondary CTAs). Same sizing system as Primary Button.

### Sizes

| Size | Height | Padding X | Radius | Font | Icon gap |
|---|---|---|---|---|---|
| Mini | 24px (`h-6`) | 8px (`px-2`) | 4px (`rounded`) | 12px Semibold | 6px (`gap-1.5`) |
| Small | 32px (`h-8`) | 12px (`px-3`) | 8px (`rounded-lg`) | 12px Semibold | 6px (`gap-1.5`) |
| Regular | 36px (`h-9`) | 16px (`px-4`) | 8px (`rounded-lg`) | 14px Semibold | 8px (`gap-2`) |
| Large | 40px (`h-10`) | 24px (`px-6`) | 8px (`rounded-lg`) | 14px Semibold | 8px (`gap-2`) |

### States

| State | Background | Border |
|---|---|---|
| Default | `#2E2E2E` (`--control-secondary`) | none |
| Hover/Active | `#3B3B3B` (`--control-secondary-hover`) | none |
| Disabled | `#2E2E2E` + `opacity: 0.5` | none |

Text color: `--text-primary` (`#E9EDF4` / `text-white`)

### Usage

```html
<!-- Regular -->
<button class="h-9 px-4 rounded-lg bg-[var(--control-secondary)] text-sm font-semibold text-white hover:bg-[var(--control-secondary-hover)] transition-colors active:scale-[0.97] disabled:opacity-50">
  Label
</button>

<!-- Small -->
<button class="h-8 px-3 rounded-lg bg-[var(--control-secondary)] text-xs font-semibold text-white hover:bg-[var(--control-secondary-hover)] transition-colors active:scale-[0.97] disabled:opacity-50">
  Label
</button>
```

## Danger Button

For destructive/irreversible actions (delete project, remove member, etc). Same sizing system as Primary Button.

### Sizes

| Size | Height | Padding X | Radius | Font | Icon gap |
|---|---|---|---|---|---|
| Mini | 24px (`h-6`) | 8px (`px-2`) | 4px (`rounded`) | 12px Semibold | 6px (`gap-1.5`) |
| Small | 32px (`h-8`) | 12px (`px-3`) | 8px (`rounded-lg`) | 12px Semibold | 6px (`gap-1.5`) |
| Regular | 36px (`h-9`) | 16px (`px-4`) | 8px (`rounded-lg`) | 14px Semibold | 8px (`gap-2`) |
| Large | 40px (`h-10`) | 24px (`px-6`) | 8px (`rounded-lg`) | 14px Semibold | 8px (`gap-2`) |

### States

| State | Background | Border |
|---|---|---|
| Default | `rgba(239,68,68,0.5)` | `1px solid #EF4444` |
| Hover/Active | `#EF4444` (solid) | none (border transparent) |
| Disabled | `rgba(239,68,68,0.5)` + `opacity: 0.5` | `1px solid #EF4444` |

Text color: `--text-primary` (`#E9EDF4` / `text-white`)

### Usage

```html
<!-- Regular (most common) -->
<button class="h-9 px-4 rounded-lg bg-red-500/50 border border-red-500 text-sm font-semibold text-white flex items-center gap-2 hover:bg-red-500 hover:border-transparent transition-colors active:scale-[0.97] disabled:opacity-50">
  <Icon class="w-3.5 h-3.5" /> Delete Project
</button>

<!-- Small -->
<button class="h-8 px-3 rounded-lg bg-red-500/50 border border-red-500 text-xs font-semibold text-white flex items-center gap-1.5 hover:bg-red-500 hover:border-transparent transition-colors active:scale-[0.97] disabled:opacity-50">
  Remove
</button>
```

## Button Icons — When to Include

An icon on a Primary / Secondary / Danger button **earns its place** only when it reinforces meaning, clarifies destination, or improves scannability. Never decorative.

| Situation | Icon? | Placement | Example |
|---|---|---|---|
| Create / Add a new thing | yes | leading | `+ New Project`, `+ Add Secret` |
| Standalone destructive on a page | yes | leading | `🗑 Delete Project` |
| Open / Navigate forward / External link | yes | **trailing** | `View App ↗`, `Learn more →` |
| Disclosure (opens menu/submenu) | yes | **trailing** | `Environment ⌄` |
| Back navigation | yes | leading | `← Back` (conventional — matches the direction) |
| Submit + Cancel pair in a modal / form footer | **no** on both | — | `Cancel` / `Save` |
| Destructive confirm inside modal footer (next to Cancel) | **no** | — | `Cancel` / `Delete` |
| Secondary sitting next to a Primary CTA | **no** | — | Let Primary carry visual weight |
| Inline row / table action (Edit, Rename, Remove) | **no** | — | Row already gives context |
| Full-width form submit (Deploy, Provision, Sign in) | optional | leading if used | Usually label alone is clearer |
| Icon-only button | yes | — | Only for universal symbols `✕ ⋯ ⚙ 🔍`. Must have `aria-label` |

**Quick test:** if you can remove the icon and the button's purpose is still immediately clear from the label — remove it.

## Tab Picker (time ranges, mode switches)

```
Container: bg-bg-secondary rounded-xl p-1
Active:    bg-[#2e2e2e] text-white shadow-sm rounded-[10px] font-semibold
Inactive:  text-txt-secondary hover:text-white font-semibold
```

## CSS Variables (copy-paste ready)

```css
:root {
  /* Font */
  --font-family: 'Geist', sans-serif;

  /* Background — locked */
  --bg-primary: #070707;
  --bg-secondary: #141414;

  /* Border — locked */
  --border-primary: #2E2E2E;
  --border-secondary: rgba(255, 255, 255, 0.08);

  /* Text — locked */
  --text-primary: #E9EDF4;
  --text-secondary: #858B94;
  --text-tertiary: #5F646D;

  /* Control */
  --control-primary: #10B981;
  --control-primary-hover: #059669;
  --control-secondary: #2E2E2E;
  --control-secondary-hover: #3B3B3B;

  /* Gradient */
  --gradient-primary: linear-gradient(135deg, #10B981, #D4A574);

  /* Semantic */
  --other-red: #EF4444;
  --other-yellow: #F59E0B;
  --other-blue: #3B82F6;
  --other-bronze: #B08D57;
}
```
