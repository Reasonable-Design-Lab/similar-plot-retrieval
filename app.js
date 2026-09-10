(function () {
  "use strict";

  const SINGAPORE_BOUNDS = [[103.59, 1.13], [104.08, 1.49]];
  const COLORS = { site1: "#ff6b35", site2: "#9d7bff" };
  const EMPTY_COLLECTION = { type: "FeatureCollection", features: [] };
  const DATASETS = [
    { id: "site1", label: "Site 01", url: "data/SITE1-like_similar_plots.geojson" },
    { id: "site2", label: "Site 02", url: "data/SITE2-like_similar_plots.geojson" }
  ];

  const state = {
    map: null,
    datasets: {},
    featuresById: new Map(),
    selectedFeature: null,
    popup: null,
    dashFrame: null,
    mapReady: false,
    buildingsEnabled: false,
    webMcpLifecycle: null
  };

  const els = {
    tokenNotice: document.getElementById("tokenNotice"),
    mapStatus: document.getElementById("mapStatus"),
    datasetCount: document.getElementById("datasetCount"),
    selectionEmpty: document.getElementById("selectionEmpty"),
    siteDetails: document.getElementById("siteDetails"),
    detailRole: document.getElementById("detailRole"),
    detailTitle: document.getElementById("detailTitle"),
    detailBadge: document.getElementById("detailBadge"),
    metricArea: document.getElementById("metricArea"),
    metricGfa: document.getElementById("metricGfa"),
    metricGpr: document.getElementById("metricGpr"),
    metricAspect: document.getElementById("metricAspect"),
    findSimilarButton: document.getElementById("findSimilarButton"),
    similarHint: document.getElementById("similarHint"),
    resultsSection: document.getElementById("resultsSection"),
    resultsList: document.getElementById("resultsList"),
    resultCount: document.getElementById("resultCount"),
    overviewButton: document.getElementById("overviewButton"),
    pitchButton: document.getElementById("pitchButton"),
    site1Zone: document.getElementById("site1Zone"),
    site2Zone: document.getElementById("site2Zone")
  };

  function setStatus(message, isError) {
    els.mapStatus.classList.toggle("error", Boolean(isError));
    els.mapStatus.lastElementChild.textContent = message;
  }

  function hasValidToken() {
    const token = window.MAP_CONFIG && window.MAP_CONFIG.accessToken;
    return typeof token === "string" && token.startsWith("pk.") && !token.includes("YOUR_MAPBOX");
  }

  function normalizeZone(value) {
    if (!value) return "Not specified";
    return String(value)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/Zone$/i, "")
      .replace(/Business\s*1/i, "Business 1")
      .trim();
  }

  function formatNumber(value, digits) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return new Intl.NumberFormat("en-SG", {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits
    }).format(number);
  }

  function formatArea(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${formatNumber(number, 0)} m²` : "—";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getCoordinates(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return geometry.coordinates.flat(1);
    if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2);
    return [];
  }

  function getBounds(feature) {
    const coords = getCoordinates(feature.geometry);
    return coords.reduce(
      (bounds, coord) => [
        [Math.min(bounds[0][0], coord[0]), Math.min(bounds[0][1], coord[1])],
        [Math.max(bounds[1][0], coord[0]), Math.max(bounds[1][1], coord[1])]
      ],
      [[Infinity, Infinity], [-Infinity, -Infinity]]
    );
  }

  function getCenter(feature) {
    const bounds = getBounds(feature);
    return [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];
  }

  function matchScore(feature) {
    const p = feature.properties;
    const diffs = [p["Width diff"], p["Aspect diff"], p["GFA diff"]]
      .map(Number)
      .filter(Number.isFinite)
      .map(Math.abs);
    if (!diffs.length) return 1;
    return Math.max(0, Math.min(1, 1 - diffs.reduce((a, b) => a + b, 0) / diffs.length));
  }

  function curveBetween(start, end) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const distance = Math.hypot(dx, dy);
    const bow = Math.min(distance * 0.28, 0.055);
    const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const control = distance > 0
      ? [midpoint[0] - (dy / distance) * bow, midpoint[1] + (dx / distance) * bow]
      : midpoint;
    const coords = [];
    for (let index = 0; index <= 64; index += 1) {
      const t = index / 64;
      const oneMinusT = 1 - t;
      coords.push([
        oneMinusT * oneMinusT * start[0] + 2 * oneMinusT * t * control[0] + t * t * end[0],
        oneMinusT * oneMinusT * start[1] + 2 * oneMinusT * t * control[1] + t * t * end[1]
      ]);
    }
    return coords;
  }

  async function loadDatasets() {
    const loaded = await Promise.all(DATASETS.map(async (dataset) => {
      const response = await fetch(dataset.url);
      if (!response.ok) throw new Error(`Could not load ${dataset.url}`);
      const collection = await response.json();
      const features = collection.features.map((feature, index) => {
        const cloned = JSON.parse(JSON.stringify(feature));
        cloned.properties = {
          ...cloned.properties,
          __site: dataset.id,
          __datasetLabel: dataset.label,
          __featureIndex: index
        };
        const id = cloned.properties.UUID || `${dataset.id}-${index}`;
        cloned.id = id;
        state.featuresById.set(String(id), cloned);
        return cloned;
      });
      const reference = features.find((feature) => feature.properties.Role === "Reference") || features[0];
      const candidates = features.filter((feature) => feature.properties.Role === "Candidate")
        .sort((a, b) => matchScore(b) - matchScore(a));
      return [dataset.id, { ...dataset, features, reference, candidates }];
    }));

    state.datasets = Object.fromEntries(loaded);
    return {
      type: "FeatureCollection",
      features: loaded.flatMap(([, dataset]) => dataset.features)
    };
  }

  function addMapContent(allPlots) {
    const map = state.map;
    map.addSource("plots", { type: "geojson", data: allPlots, generateId: true });
    map.addSource("selection", { type: "geojson", data: EMPTY_COLLECTION });
    map.addSource("links", { type: "geojson", data: EMPTY_COLLECTION });

    map.addLayer({
      id: "links-glow",
      type: "line",
      source: "links",
      slot: "top",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": 7,
        "line-opacity": 0.13,
        "line-blur": 5
      }
    });

    map.addLayer({
      id: "links-dashed",
      type: "line",
      source: "links",
      slot: "top",
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.4, 13, 2.7],
        "line-opacity": 0.92,
        "line-dasharray": [0, 3, 2]
      }
    });

    map.addLayer({
      id: "plots-fill",
      type: "fill",
      source: "plots",
      slot: "top",
      paint: {
        "fill-color": ["match", ["get", "__site"], "site1", COLORS.site1, COLORS.site2],
        "fill-opacity": ["case", ["==", ["get", "Role"], "Reference"], 0.62, 0.3]
      }
    });

    map.addLayer({
      id: "plots-outline",
      type: "line",
      source: "plots",
      slot: "top",
      paint: {
        "line-color": ["match", ["get", "__site"], "site1", "#ffb08f", "#c7b7ff"],
        "line-width": ["case", ["==", ["get", "Role"], "Reference"], 3, 1.5],
        "line-opacity": ["case", ["==", ["get", "Role"], "Reference"], 1, 0.72]
      }
    });

    map.addLayer({
      id: "selection-fill",
      type: "fill",
      source: "selection",
      slot: "top",
      paint: { "fill-color": ["get", "color"], "fill-opacity": 0.18 }
    });

    map.addLayer({
      id: "selection-outline",
      type: "line",
      source: "selection",
      slot: "top",
      layout: { "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": 4,
        "line-opacity": 0.94,
        "line-blur": 0.2
      }
    });

    const labels = Object.values(state.datasets)
      .filter((dataset) => dataset.reference)
      .map((dataset) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: getCenter(dataset.reference) },
        properties: { label: dataset.label, __site: dataset.id, uuid: dataset.reference.properties.UUID }
      }));

    map.addSource("reference-labels", { type: "geojson", data: { type: "FeatureCollection", features: labels } });
    map.addLayer({
      id: "reference-labels",
      type: "symbol",
      source: "reference-labels",
      slot: "top",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 12,
        "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
        "text-offset": [0, -1.6],
        "text-allow-overlap": true
      },
      paint: { "text-color": "#ffffff", "text-halo-color": "#0a0d12", "text-halo-width": 1.3 }
    });

    map.on("mouseenter", "plots-fill", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "plots-fill", () => { map.getCanvas().style.cursor = ""; });
    map.on("mouseenter", "reference-labels", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "reference-labels", () => { map.getCanvas().style.cursor = ""; });

    map.on("click", "plots-fill", (event) => {
      const rendered = event.features && event.features[0];
      if (!rendered) return;
      const original = state.featuresById.get(String(rendered.properties.UUID || rendered.id));
      if (original) selectFeature(original, true);
    });

    map.on("click", "reference-labels", (event) => {
      const rendered = event.features && event.features[0];
      const original = rendered && state.featuresById.get(String(rendered.properties.uuid));
      if (original) selectFeature(original, true);
    });

    startDashAnimation();
  }

  function startDashAnimation() {
    const sequence = [
      [0, 3, 2], [0.5, 3, 1.5], [1, 3, 1], [1.5, 3, 0.5],
      [2, 3, 0], [0, 0.5, 2, 2.5], [0, 1, 2, 2], [0, 1.5, 2, 1.5], [0, 2, 2, 1]
    ];
    let lastStep = -1;
    const animate = (timestamp) => {
      if (state.map && state.map.getLayer("links-dashed")) {
        const step = Math.floor(timestamp / 90) % sequence.length;
        if (step !== lastStep) {
          state.map.setPaintProperty("links-dashed", "line-dasharray", sequence[step]);
          lastStep = step;
        }
      }
      state.dashFrame = requestAnimationFrame(animate);
    };
    state.dashFrame = requestAnimationFrame(animate);
  }

  function updateTabState(siteId) {
    document.querySelectorAll(".site-tab").forEach((button) => {
      const active = button.dataset.site === siteId;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function focusFeature(feature) {
    const bounds = getBounds(feature);
    const mobile = window.innerWidth <= 700;
    state.map.fitBounds(bounds, {
      padding: mobile ? { top: 100, right: 55, bottom: Math.round(window.innerHeight * 0.48) + 40, left: 55 } : { top: 120, right: 160, bottom: 90, left: 470 },
      maxZoom: 17.4,
      pitch: 58,
      bearing: 14,
      duration: 1650,
      essential: true
    });
    setBuildings(true);
  }

  function setBuildings(enabled) {
    state.buildingsEnabled = enabled;
    els.pitchButton.setAttribute("aria-pressed", String(enabled));
    if (state.map && typeof state.map.setConfigProperty === "function") {
      try { state.map.setConfigProperty("basemap", "show3dObjects", enabled); } catch (_) { /* style may not expose this property */ }
    }
  }

  function updateSelectionSource(feature) {
    const source = state.map.getSource("selection");
    if (!source) return;
    const selected = JSON.parse(JSON.stringify(feature));
    selected.properties = { ...selected.properties, color: COLORS[selected.properties.__site] };
    source.setData({ type: "FeatureCollection", features: [selected] });
  }

  function makePopup(feature) {
    if (state.popup) state.popup.remove();
    const p = feature.properties;
    const dataset = state.datasets[p.__site];
    const roleLabel = p.Role === "Reference" ? dataset.label : `${dataset.label} · Similar plot`;
    const html = `<div class="map-popup">
      <div class="popup-kicker">${escapeHtml(roleLabel.toUpperCase())}</div>
      <h4>${escapeHtml(normalizeZone(p.Zone))}</h4>
      <dl>
        <dt>Site area</dt><dd>${escapeHtml(formatArea(p["KG site area m²"]))}</dd>
        <dt>Allowable GFA</dt><dd>${escapeHtml(formatArea(p["Final allowable GFA m²"]))}</dd>
        <dt>Plot ratio</dt><dd>${escapeHtml(formatNumber(p["Master Plan GPR"], 1))}</dd>
      </dl>
    </div>`;
    state.popup = new mapboxgl.Popup({ offset: 14, closeButton: true })
      .setLngLat(getCenter(feature))
      .setHTML(html)
      .addTo(state.map);
  }

  function selectFeature(feature, shouldFocus) {
    state.selectedFeature = feature;
    const p = feature.properties;
    const dataset = state.datasets[p.__site];
    const isReference = p.Role === "Reference";
    const candidatePosition = dataset.candidates.findIndex((candidate) => candidate.properties.UUID === p.UUID);

    updateTabState(p.__site);
    updateSelectionSource(feature);
    els.selectionEmpty.classList.add("hidden");
    els.siteDetails.classList.remove("hidden");
    els.detailRole.textContent = isReference ? "REFERENCE PARCEL" : `SIMILAR PLOT ${String(candidatePosition + 1).padStart(2, "0")}`;
    els.detailTitle.textContent = isReference ? dataset.label : `${dataset.label} match ${String(candidatePosition + 1).padStart(2, "0")}`;
    els.detailBadge.textContent = normalizeZone(p.Zone);
    els.metricArea.textContent = formatArea(p["KG site area m²"]);
    els.metricGfa.textContent = formatArea(p["Final allowable GFA m²"]);
    els.metricGpr.textContent = formatNumber(p["Master Plan GPR"], 1);
    els.metricAspect.textContent = formatNumber(p["Aspect ratio"], 2);

    els.findSimilarButton.disabled = !isReference || dataset.candidates.length === 0;
    els.findSimilarButton.querySelector("span").textContent = isReference ? "Find similar plots" : "Viewing similar plot";
    els.similarHint.textContent = isReference
      ? (dataset.candidates.length ? `${dataset.candidates.length} candidate${dataset.candidates.length === 1 ? "" : "s"} available in this dataset.` : "No candidate plots are currently available for this site.")
      : `${Math.round(matchScore(feature) * 100)}% composite similarity to ${dataset.label}.`;

    if (!isReference) {
      els.resultsSection.classList.remove("hidden");
      renderResults(dataset, p.UUID);
    } else {
      els.resultsSection.classList.add("hidden");
    }

    makePopup(feature);
    if (shouldFocus) focusFeature(feature);
    setStatus(`${isReference ? dataset.label : "Similar plot"} selected`);
  }

  function renderResults(dataset, activeUuid) {
    els.resultCount.textContent = String(dataset.candidates.length);
    els.resultsList.innerHTML = "";
    dataset.candidates.forEach((feature, index) => {
      const p = feature.properties;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result-item";
      if (p.UUID === activeUuid) button.setAttribute("aria-current", "true");
      button.innerHTML = `
        <span class="result-rank">${String(index + 1).padStart(2, "0")}</span>
        <span class="result-copy"><strong>${escapeHtml(normalizeZone(p.Zone))}</strong><small>${escapeHtml(formatArea(p["KG site area m²"]))}</small></span>
        <span class="match-score">${Math.round(matchScore(feature) * 100)}%</span>`;
      button.addEventListener("click", () => selectFeature(feature, true));
      els.resultsList.appendChild(button);
    });
  }

  function revealSimilar() {
    const reference = state.selectedFeature;
    if (!reference || reference.properties.Role !== "Reference") return;
    const dataset = state.datasets[reference.properties.__site];
    if (!dataset.candidates.length) return;
    const start = getCenter(reference);
    const lines = dataset.candidates.map((candidate, index) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: curveBetween(start, getCenter(candidate)) },
      properties: {
        color: COLORS[dataset.id],
        uuid: candidate.properties.UUID,
        rank: index + 1
      }
    }));
    state.map.getSource("links").setData({ type: "FeatureCollection", features: lines });
    els.resultsSection.classList.remove("hidden");
    renderResults(dataset);
    showOverview();
    setStatus(`${dataset.candidates.length} similar plots connected`);
  }

  function showOverview() {
    if (!state.map) return;
    const mobile = window.innerWidth <= 700;
    state.map.fitBounds(SINGAPORE_BOUNDS, {
      padding: mobile ? { top: 88, right: 28, bottom: Math.round(window.innerHeight * 0.47) + 25, left: 28 } : { top: 105, right: 70, bottom: 58, left: 430 },
      pitch: 0,
      bearing: 0,
      duration: 1500,
      essential: true
    });
    setBuildings(false);
    if (state.popup) state.popup.remove();
    setStatus("Singapore overview");
  }

  function wireControls() {
    document.querySelectorAll(".site-tab").forEach((button) => {
      button.addEventListener("click", () => {
        const dataset = state.datasets[button.dataset.site];
        if (dataset && dataset.reference) selectFeature(dataset.reference, true);
      });
    });
    els.findSimilarButton.addEventListener("click", revealSimilar);
    els.overviewButton.addEventListener("click", showOverview);
    els.pitchButton.addEventListener("click", () => {
      const enabled = !state.buildingsEnabled;
      setBuildings(enabled);
      state.map.easeTo({ pitch: enabled ? 58 : 0, bearing: enabled ? 14 : 0, duration: 900, essential: true });
    });
  }

  function waitForMapMove() {
    return new Promise((resolve) => {
      if (!state.map || !state.map.isMoving()) {
        resolve();
        return;
      }
      const timeout = window.setTimeout(resolve, 2200);
      state.map.once("moveend", () => {
        window.clearTimeout(timeout);
        resolve();
      });
    });
  }

  function registerWebMcpTool() {
    const context = document.modelContext;
    if (!context || typeof context.registerTool !== "function") return;
    state.webMcpLifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name: "explore_site_matches",
        title: "Explore site matches",
        description: "Select Site 01 or Site 02 on the visible Singapore map and optionally reveal every similar parcel in its dataset.",
        inputSchema: {
          type: "object",
          properties: {
            site: { type: "string", enum: ["site1", "site2"], description: "Reference site to explore." },
            revealSimilar: { type: "boolean", description: "Whether to return to the overview and draw animated links to all candidates." }
          },
          required: ["site"],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          if (!input || !["site1", "site2"].includes(input.site) || ("revealSimilar" in input && typeof input.revealSimilar !== "boolean")) {
            throw new TypeError("site must be site1 or site2, and revealSimilar must be a boolean when provided.");
          }
          const dataset = state.datasets[input.site];
          if (!dataset || !dataset.reference) throw new Error("The requested reference site is not available.");
          selectFeature(dataset.reference, input.revealSimilar === false);
          if (input.revealSimilar !== false && dataset.candidates.length) revealSimilar();
          await waitForMapMove();
          return {
            selectedSite: dataset.label,
            similarPlotsShown: input.revealSimilar === false ? 0 : dataset.candidates.length,
            view: input.revealSimilar === false ? "parcel" : "singapore-overview"
          };
        }
      }, { signal: state.webMcpLifecycle.signal })).catch((error) => console.warn("WebMCP tool registration failed", error));
    } catch (error) {
      console.warn("WebMCP tool registration failed", error);
    }
  }

  async function initialise() {
    if (!hasValidToken()) {
      els.tokenNotice.classList.remove("hidden");
      setStatus("Mapbox token required", true);
      return;
    }
    if (!window.mapboxgl || !mapboxgl.supported()) {
      setStatus("WebGL is not supported in this browser", true);
      return;
    }

    mapboxgl.accessToken = window.MAP_CONFIG.accessToken;
    state.map = new mapboxgl.Map({
      container: "map",
      style: window.MAP_CONFIG.style || "mapbox://styles/mapbox/standard",
      center: [103.8198, 1.3521],
      zoom: 10.4,
      pitch: 0,
      bearing: 0,
      antialias: true,
      attributionControl: true,
      config: { basemap: { lightPreset: "dusk", show3dObjects: false, showPointOfInterestLabels: false } }
    });
    state.map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "bottom-right");
    state.map.addControl(new mapboxgl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-right");

    try {
      const dataPromise = loadDatasets();
      await new Promise((resolve, reject) => {
        state.map.once("load", resolve);
        state.map.once("error", (event) => reject(event.error || new Error("Map style failed to load")));
      });
      const allPlots = await dataPromise;
      addMapContent(allPlots);
      wireControls();
      registerWebMcpTool();
      state.mapReady = true;
      const total = allPlots.features.length;
      els.datasetCount.textContent = `${total} parcel${total === 1 ? "" : "s"}`;
      Object.values(state.datasets).forEach((dataset) => {
        const zone = dataset.reference ? normalizeZone(dataset.reference.properties.Zone) : "No reference";
        const target = dataset.id === "site1" ? els.site1Zone : els.site2Zone;
        target.textContent = zone;
      });
      showOverview();
    } catch (error) {
      console.error(error);
      setStatus("The map data could not be loaded", true);
    }
  }

  initialise();
})();
