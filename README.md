# Singapore Site Similarity Explorer

An English-language, interactive Mapbox GL JS site for comparing two Singapore reference parcels with their similar plots. It supports:

- colour-coded Site 01 and Site 02 families;
- click-to-inspect parcel planning metrics;
- animated dashed similarity links;
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

The included workflow publishes `dist` whenever the `main` branch is updated. In the GitHub repository, open **Settings → Pages** and choose **GitHub Actions** as the source if it is not already selected.

## Update the data

Replace the two files in `dist/data` while keeping these names:

- `SITE1-like_similar_plots.geojson`
- `SITE2-like_similar_plots.geojson`

Each collection should contain one feature with `Role: "Reference"`; any features with `Role: "Candidate"` become searchable similar plots automatically.

The current data contains four candidates for Site 01. Site 02 currently contains only its reference parcel, so the interface displays a clear empty-candidate state until candidate features are added.

