# Singapore Site Similarity Explorer

An English-language, interactive Mapbox GL JS site for comparing two Singapore reference parcels with their similar plots. It supports:

- colour-coded Site 01 and Site 02 families;
- click-to-inspect parcel planning metrics;
- animated dashed similarity links;
- smooth transitions from the Singapore overview to a selected parcel; and
- pitched 3D building views using the Mapbox Standard style.

## Add your Mapbox token

Open `dist/config.js` and replace `pk.YOUR_MAPBOX_PUBLIC_TOKEN` with a Mapbox **public** access token. Because this is a static website, the token is visible to visitors by design. In Mapbox, restrict its allowed URLs to your GitHub Pages domain and any local address you use for testing.

## Run locally

From PowerShell:

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
