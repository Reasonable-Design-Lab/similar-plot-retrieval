# Similar Plot Retrieval

An English-language Mapbox GL JS explorer for comparing two Singapore reference parcels with progressively stricter similar-plot results. It supports:

- colour-coded Site 1 and Site 2 families;
- three selectable plot, neighbour and road-frontage matching views;
- click-to-inspect parcel planning metrics;
- concise addresses for similar plots;
- on-demand Knowledge Graph (KG) context for non-road plots within 75 m of every selected similar plot, including planning use, development capacity, programmes and controls;
- switchable subpages for land-use-specific allowable GFA schemes, with their plot-ratio, storey, setback and buildable-space records;
- animated dashed similarity links;
- click-to-browse individual neighbouring plots, with an empty-map click to close the neighbourhood context;
- smooth transitions from the Singapore overview to a selected parcel; and
- pitched 3D building views using the Mapbox Standard style.

## Quick local launch

1. Open `mapbox-token.txt` and replace the placeholder with a Mapbox public token beginning with `pk.`.
2. Double-click `Launch Site.cmd`.
3. Keep the terminal window open while testing; press `Ctrl+C` to stop.

The launcher generates `dist/config.js`, starts the local server, and opens the website automatically. If the token is missing, it opens the token text file in Notepad for you.

Browser-based maps expose public (`pk.`) tokens by design. Before publishing, restrict the token to your local and deployed URLs in the Mapbox dashboard.

## Run locally from PowerShell

Alternatively, from PowerShell:

```powershell
.\start-local.ps1
```

Then open `http://localhost:4173`. Press `Ctrl+C` to stop the server.

You can also use any static file server and point it at the `dist` directory.

## Publish with GitHub Pages

The public website is served from the `gh-pages` branch. The deploy branch contains the files from `dist` at its root.

## Update the data

The searchable plot collections are:

- `dist/data/SITE1-like_similar_plots_v2.geojson`
- `dist/data/SITE2-like_similar_plots_v2.geojson`

Each collection should contain one feature with `Role: "Reference"`. Candidate features are grouped by their `Filter stage` value.

Neighbour relationships are prepared from these local source files in the repository root (they are not published):

- `SITE1_similar_plot_nonroad_neighbours_v2.geojson`
- `SITE2_similar_plot_nonroad_neighbours_v2.geojson`

After replacing either source file, run:

```powershell
node .\scripts\prepare-neighbour-data.mjs
```

This creates compact, web-ready copies in `dist/data`. They retain geometry, source-candidate filter membership, 75 m neighbour relationships, planning zones, parcel metrics, land-use-specific GFA schemes and KG regulation summaries while avoiding a large initial page download. The browser loads the relevant neighbour collection only after a user selects a similar plot.
