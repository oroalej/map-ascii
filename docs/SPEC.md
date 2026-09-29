# Product spec — Naga Atlas

## 1. Experience

The site opens on the Bicol peninsula drawn in glowing ASCII on a dark background. One continuous zoom takes the visitor through Camarines Sur and into Naga's barangays, the Centro, and individual streets and buildings. Visitors can:

- drag and orbit around the map
- tap a place to fly to it
- search with `/`
- take a guided tour
- scrub a year slider to watch the city change

## 2. Zoom levels

Zoom is continuous (web-mercator zoom ≈ 7 → 19). Content and glyph detail change at named levels, and these transitions crossfade over roughly 0.5 zoom units rather than popping.

| Level | Approx. zoom | Content | Labels |
|---|---|---|---|
| Region | 7–9.5 | Bicol coastline, Mt. Isarog, major lakes and rivers, terrain shading | Provinces, major cities |
| City | 9.5–13 | Naga boundary, barangay outlines, Naga River, highways | City and barangay names |
| District | 13–15.5 | All roads, building blocks as solid fill, parks, water | Districts, major roads, key landmarks |
| Street | 15.5–17.5 | Individual building footprints, trees, minor roads, alleys | Street names, POIs |
| Place | 17.5–19 | Detailed landmark rendering, entrances, plazas | Everything; info panel auto-suggests |

**Fixed cell size.** Characters are always the same size on screen (default 10×18 CSS px; configurable). Zooming changes how much ground each cell represents, not the glyph size.

## 3. Camera modes

1. **Map (default).**
   - Top-down, north-up. Pitch is 0–15° and bearing is locked unless the visitor rotates.
   - Controls: drag to pan, scroll or pinch to zoom around the cursor or pinch center.
2. **Orbit.**
   - Right-drag, Ctrl+drag, or a two-finger twist/tilt changes pitch (0–60°) and bearing.
   - Buildings extrude: walls are stacked `▓`/`▒` shaded by face orientation, roofs are `▀`/`█`. Height comes from OSM `height` or `building:levels × 3 m`, with a class default otherwise.
   - A compass button resets to north-up and flat.
3. **Street walk (phase 6).**
   - The visitor snaps to the nearest road segment and moves along the road graph with WASD or the arrow keys. At junctions they choose a branch with left/right.
   - Low camera (eye height about 10 m, pitch about 75°, looking along the road), rendered as pseudo-3D ASCII with buildings on both sides.
   - Escape returns to Map mode at the current location.

**Fly-to.** A tap, a search result, or a tour step animates the camera along an eased arc: zoom out, travel, zoom in. Duration scales with distance and is clamped to 0.8–3 s. Any user input cancels the animation.

**Bounds.** The camera is clamped to a Bicol bounding box. Min and max zoom are enforced.

## 4. Visual language

Default theme is dark (background ≈ `#04050a`), with an optional light theme. Glyphs and colors are defined in a single theme file (`packages/renderer/src/theme.ts`).

| Feature class | Glyphs | Color idea |
|---|---|---|
| Water — river/stream | `~ ≈` (slowly animated) | cyan |
| Water — lake/sea | `≈ ~ ·` | deep blue |
| Road — primary/trunk | `═ ║ ╔ ╗ ╚ ╝ ╬ ╠ ╣ ╦ ╩` | warm white |
| Road — secondary/tertiary | `─ │ ┌ ┐ └ ┘ ┼ ├ ┤ ┬ ┴` | light grey |
| Road — residential/service | `─ │ ┼` dimmer | grey |
| Path/alley/footway | `· :` | dim grey |
| Building — generic | `█ ▓ ▒ ░` (by shade/height) | amber-grey |
| Religious building | `†` marker plus fill | gold |
| School/university | `⌂` marker | soft blue |
| Market/commercial | `$` marker | orange |
| Park/plaza | `" ' ,` | green |
| Trees/forest | `♣ ♠ ↑` | green |
| Farmland/rice fields | `≡ '` in rows | yellow-green |
| Terrain (Region level) | `. : - = + * # %` luminance ramp | brown-grey |
| Landmark (curated) | `◆` pulsing glow | accent color |

**Road glyphs follow edge direction.** The renderer computes each road cell's orientation and neighbor connectivity, and picks the matching box-drawing character. Straight segments get `─`/`│`, junctions get `┼`/`├` and so on, and diagonals get `╱ ╲` or stair-stepped runs.

**Labels** are real text snapped to the cell grid.
- Placement is by priority and zoom band, with collision detection so labels never overlap.
- Street names run along the street direction when horizontal or vertical within ±20°. Otherwise they are horizontal next to the street.
- Labels have a 1-cell dark halo.

**Hover and selection.** Hovering brightens the feature's cells. The selected feature gets an accent color and a slow shimmer.

## 5. Interactions

| Input | Action |
|---|---|
| Drag | Pan |
| Scroll / pinch | Zoom (anchored at cursor) |
| Right-drag / two-finger rotate | Orbit (pitch and bearing) |
| Click / tap feature | Fly to it and open the info panel |
| Hover | Highlight and tooltip with the name |
| `/` | Focus search |
| `+` / `-` | Zoom |
| `T` | Open tours menu |
| `Y` | Toggle timeline |
| `Space` | Pause/resume tour or timeline playback |
| `Esc` | Close panel, exit walk mode, cancel fly |

**Search**
- Fuzzy search over landmarks, streets, barangays, schools, churches, and markets.
- Results are grouped by type and show the barangay.
- Enter flies to the top result. Arrow keys move through results.

**Info panel**
- Right side on desktop, bottom sheet on mobile.
- Contents: name, type, barangay, short story, photo carousel with "then/now" pairs, year built/demolished with certainty badge, sources, and links.
- "Show on timeline" jumps the slider to the feature's key years.

**Share**
- Copies a URL encoding `lat`, `lng`, `z`, `pitch`, `bearing`, `year`, `tour`, `step`, and `sel` (selected feature id).
- Loading that URL restores the exact view.

**HUD**
- Scale indicator (the "ruler").
- Current barangay name.
- Coordinates, toggleable.
- Attribution line, always visible.

## 6. Tours

A tour is an ordered list of steps. Each step has:
- camera state: lat, lng, zoom, pitch, bearing
- duration
- narration text
- optional: `year`, `select` (feature id), `audio` clip, `highlight` (feature ids)

Launch set:

1. **Traslación route.** Procession path from the Basilica Minore of Our Lady of Peñafrancia to the Naga Metropolitan Cathedral, then the fluvial procession along the Naga River.
2. **Heritage Centro walk.** Plaza Quince Martires, Plaza Rizal, the Cathedral, and the old commercial streets.
3. **Campus belt.** Ateneo de Naga University, the University of Nueva Caceres, and the surrounding streets.
4. **From Isarog to the river.** Region-level to street-level establishing flight.

Tour narration must be fact-checked against sources before shipping; draft text may be written as placeholders marked `TODO(verify)`.

**Player behavior**
- Steps auto-advance. Narration appears in a caption card.
- Controls: pause, next, previous, exit, plus a progress bar.
- If the visitor grabs the camera, the tour pauses and a "Resume tour" chip appears. Resuming flies back to the current step.
- A step can set the timeline year. The slider animates to it.

## 7. Timeline

**UI**
- Bottom slider spanning the earliest year with data to the current year.
- Tick marks on years that have data. Denser ticks mean more data.
- ▶ plays through years at a configurable speed and pauses on years that have events.
- Years before the first real data are greyed out and can't be selected.

**Behavior when the year changes**
- **Features.** Anything with `start_year > year` or `end_year <= year` is hidden. When scrubbing, appearing features "type in" and disappearing ones dissolve, cell by cell, over about 400 ms in scan order.
- **Unknown dates.** Features with no date data are treated as always present, which is the default for modern OSM features. This is flagged in the legend: "undated features shown in all years".
- **Certainty.** `circa` dates render dithered (every other cell dimmed). `exact` renders solid.
- **Names.** Street and place names come from `name_history` for the selected year, falling back to the current name.
- **Imagery underlay** (optional toggle). The nearest satellite snapshot at or before the year, converted to an ASCII luminance layer under the features, with a crossfade between snapshots.
- **Historical maps.** Where a georeferenced old map covers the year, it can be the underlay instead.
- **Events.** Event pins (`◉`) appear for events in the selected year. Tapping one opens its story.
- **Year indicator.** The current year shows large in the corner, gcdatlas-style, and is included in share URLs.

## 8. Responsiveness and accessibility

- Mobile first-class: touch gestures, bottom-sheet panels, a larger default cell size on small screens.
- `prefers-reduced-motion`: no water animation, instant cell transitions, shorter fly-to.
- Full keyboard navigation. Search results and the info panel are real DOM, readable by screen readers. The canvas has an `aria-label` describing the current view.
- Text-size setting adjusts the cell size.
- Languages: English first. The content schema supports `en`, `fil`, and `bcl` (Bikol) fields for names and narration.

## 9. Non-goals (for now)

- User accounts, user-submitted content, and comments
- Live data such as traffic or weather
- Routing or directions
- Any backend
