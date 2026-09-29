# Product spec — ASCII Atlas

ASCII Atlas is a generic engine for explorable, ASCII-rendered city maps. Each city is added as a **city pack** (config and curated content, see §9), and the behavior below applies to every city. City-specific details such as tours and research live in city briefs under `docs/cities/`. Naga City is the first city (`docs/cities/naga.md`), and examples here use it.

## 1. Experience

A city opens on its surrounding region drawn in glowing ASCII on a dark background. One continuous zoom takes the visitor through the region and into the city's subdivisions, its center, and individual streets and buildings. (For Naga: Bicol peninsula → Camarines Sur → barangays → the Centro → streets.) Visitors can:

- drag and orbit around the map
- tap a place to fly to it
- search with `/`
- take a guided tour
- scrub a year slider to watch the city change
- switch to another city (once more than one exists; see §9)

## 2. Zoom levels

Zoom is continuous (web-mercator zoom ≈ 7 → 19). Content and glyph detail change at named levels, and these transitions crossfade over roughly 0.5 zoom units rather than popping. Each city brief describes what these levels show for that city.

| Level | Approx. zoom | Content | Labels |
|---|---|---|---|
| Region | 7–9.5 | Regional coastline, major peaks, major lakes and rivers, terrain shading | Provinces/states, major cities |
| City | 9.5–13 | City boundary, subdivision outlines, main rivers, highways | City and subdivision names |
| District | 13–15.5 | All roads, building blocks as solid fill, parks, water | Districts, major roads, key landmarks |
| Street | 15.5–17.5 | Individual building footprints, trees, minor roads, alleys | Street names, POIs |
| Place | 17.5–21 | Detailed landmark rendering from above (roof ridges, belfries, domes, monument bases), entrances, plazas, street furniture, roads at their real width | Everything; info panel auto-suggests |

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

**Bounds.** The camera is clamped to the current city's region bounding box, read from the city meta the pipeline emits (`<city>.meta.json`). Max zoom is 21 (the Place level's closest view, §2). Zooming out stops at the zoom that fits the whole region in the viewport (never below 7), so the visitor can't lose the region in empty space.

## 4. Visual language

Default theme is dark (background ≈ `#04050a`), with an optional light theme. Glyphs and colors are defined in a single theme file (`packages/renderer/src/theme.ts`).

| Feature class | Glyphs | Color idea |
|---|---|---|
| Water — river/stream | `~ ≈` (slowly animated); a thin run down the screen is `( )`, a diagonal one `╱ ╲` | cyan |
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
| Monument / statue / memorial | `▲` (from the Place level) | stone |
| Tree (OSM `natural=tree`, tree rows) | `♣` (from z17) | green |
| Fence / wall / hedge | `┄ ┆` dashed | grey-brown |
| Street furniture | bench `╥`, fountain `○`, flagpole `¶` (from z18) | light grey |
| Entrance | `▪` (from z18) | stone |
| Parking / sports pitch | `▫ ·` / `─` in rows | grey / green |
| Church, school, or market grounds | the class's lightest `░` fill, under its buildings | class color, dim |

**Road glyphs follow edge direction.** The renderer computes each road cell's orientation and neighbor connectivity, and picks the matching box-drawing character. Straight segments get `─`/`│`, junctions get `┼`/`├` and so on, and diagonals get `╱ ╲` or stair-stepped runs.

**Labels** are real text snapped to the cell grid.
- Placement is by priority and zoom band, with collision detection so labels never overlap.
- Street names run along the street direction when horizontal or vertical within ±20°. Otherwise they are horizontal next to the street. Names of major roads show from the District level (z14), other streets from the Street level (z15.5), and paths from z17. One name per street shows in a given stretch of screen.
- Place names show by what they name: provinces at the Region level, cities and towns until the District level, subdivisions from z10.5 to z16, and smaller places from z13.5.
- Labels have a 1-cell dark halo.
- Tilted past map mode's 15° (orbit), names thin out so the buildings show: street and small-place names keep to the nearer part of the screen (the nearer 45% at 60°), major roads and monuments to the nearer 72%, with a row kept clear above and below each label. Landmarks and place names of subdivisions and up always show.
- Labels and map layers fade at their band's edges: over half a zoom level, their cells appear or dissolve one by one in a fixed scattered order (a dither), so levels blend without popping. A fading label keeps its place, so its neighbors don't jump.

**Place-level detail.** Zooming in adds detail rather than only enlarging cells:
- Curated landmarks show their name from z16, and statues and monuments from z18.
- From z17, landmark buildings are drawn with double-line walls (`╔═╗`) and landmark plazas with a single-line border. From z18, every building gets single-line walls (`┌─┐`) around its shaded interior. Grounds are never outlined.
- Statues, memorials, and monuments (`▲`) appear from z17, and trees, benches, fountains, flagpoles, fences, and entrances wherever OSM maps them.
- From z18, roads are drawn at their real width (the OSM `width`, else `lanes` × 3.2 m, else a class default) as strips with curbs, instead of 1-cell lines.
- From z19, pitched roofs show their ridge (`─ │ ╱ ╲`, along the footprint's long axis) between a lit slope `▓` and a shaded slope `▒`; flat roofs and landmark parts keep the height shading. The ridge is derived from the footprint shape, so it is a stylized reading of the roof.
- **Strictly top-down.** Everything on the map is drawn as seen from above, including landmarks. Landmarks add plan-view parts from their city pack (`plans/`): belfries, domes, and cupolas at their positions on the footprint, and a monument's tiered base as nested rings or squares around its `▲`. They are outlined like buildings and rise in the tilted 3D view. Front-view (façade) drawings of landmarks (`art/`) are not drawn on the map; they belong in the info panel (Phase 2).
- The Place level reaches z21, where a cell is about 0.4 × 0.7 m.

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
- Fuzzy search over the current city's landmarks, streets, subdivisions, schools, places of worship, and markets.
- Results are grouped by type and show the subdivision.
- Enter flies to the top result. Arrow keys move through results.

**Info panel**
- Right side on desktop, bottom sheet on mobile.
- Contents: name, type, subdivision, short story, photo carousel with "then/now" pairs, year built/demolished with certainty badge, sources, and links.
- "Show on timeline" jumps the slider to the feature's key years.

**Share**
- Copies a URL whose path is the city (`/<city>`) and whose query encodes `lat`, `lng`, `z`, `pitch`, `bearing`, `year`, `tour`, `step`, and `sel` (selected feature id).
- Loading that URL restores the exact view.

**HUD**
- Top right: the current zoom value and level name (e.g. `z 15.3 · District`), and a collapsible legend of the glyphs on screen and what they mean. The legend is built from the theme and lists only the classes the renderer reports in view, so it always matches the map.
- Scale indicator (the "ruler").
- Current subdivision name, with the city's local label. An approximate subdivision (see `DATA.md` §2 step 03) shows as "≈ Name".
- Coordinates, toggleable.
- Attribution line, always visible.

## 6. Tours

A tour is an ordered list of steps. Each step has:
- camera state: lat, lng, zoom, pitch, bearing
- duration: how long the step holds once the camera arrives
- narration text
- optional: a flight duration (`fly_ms`, up to 15 s, for slow establishing shots; otherwise the fly-to rule in §3), `year`, `select` (feature id), `audio` clip, `highlight` (feature ids), and `sources`

Tours belong to a city and live in its city pack. Each city brief lists that city's launch set (for Naga, see `docs/cities/naga.md` §3). Every city should ship at least one establishing tour that flies from Region level down to street level.

Tour narration must be fact-checked against sources before shipping; draft text may be written as placeholders marked `TODO(verify)`. A tour is `draft` or `verified`: a verified tour has no `TODO(verify)` left and cites sources on every step (the validator enforces this). Draft tours play, marked "draft", with their placeholders showing.

**Player behavior**
- `T` or the Tours button opens the tours menu.
- Steps auto-advance: each flies to its camera, then holds for its duration. Narration appears in a caption card (a bottom sheet on phones, in place of the info panel).
- Controls: pause, next, previous, exit, plus a progress bar. `Space` pauses or resumes, and `Esc` exits.
- If the visitor grabs the camera (drag, zoom, orbit, or selecting something else), the tour pauses and a "Resume tour" chip appears. Resuming flies back to the current step. A hidden browser tab pauses the tour too.
- A step can set the timeline year. The slider animates to it.
- Starting a tour adds a history entry; its steps don't. A shared URL with `tour` and `step` reopens the tour at that step, paused, so the link shows the view without playing on its own.

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
- **Places in view.** The first stop in the tab order (hidden until focused, like a skip link) is a "Places in view (n)" button. It opens a list of the places, landmarks, and monuments whose names are on screen; choosing one selects it and flies there, like a click.
- **Debug overlay.** `?debug=1` shows the renderer's frame rate, frame and cell-pass times, tile counts, and tile decode time, for checking the performance budgets on real devices. It is not part of the view state, so share URLs leave it out.
- Text-size setting adjusts the cell size.
- Languages: English first and always required. Each city declares extra content languages in its config (Naga: `fil` and `bcl`), and names and narration can carry those fields.

## 9. Cities

- **Registry.** The site hosts several cities. Each is a city pack in `packages/content/cities/<slug>/`: a `city.json` config plus curated content. The pipeline builds tiles, a search index, and meta for each registered city.
- **Routes.** Each city has its own route, `/<slug>` (e.g. `/naga`). All view state in the URL is relative to that city.
- **Landing.** While only one city exists, `/` sends the visitor to it. Once there is a second city, `/` becomes a city picker drawn in the same ASCII style.
- **Terminology.** The generic term is *subdivision*. The UI shows the city's local label (e.g. "barangay" in Naga).
- **No city-specific code.** Adding a city means adding a city pack and a brief, not changing the renderer or app. See `DATA.md` "Adding a city".

## 10. Non-goals (for now)

- User accounts, user-submitted content, and comments
- Live data such as traffic or weather
- Routing or directions
- Any backend
