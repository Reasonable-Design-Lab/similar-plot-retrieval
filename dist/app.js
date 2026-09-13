(function () {
  "use strict";

  const SINGAPORE_BOUNDS = [[103.59, 1.13], [104.08, 1.49]];
  const COLORS = { site1: "#C9ACD1", site2: "#F4C18B" };
  const OUTLINE_COLORS = { site1: "#76507F", site2: "#9A5B19" };
  const NEIGHBOUR_COLORS = {
    business: "#88949F",
    residential: "#5F8FCB",
    commercial: "#A875B5",
    education: "#D99B32",
    green: "#63A36F",
    community: "#4F9B98",
    other: "#9B958C"
  };
  const EMPTY_COLLECTION = { type: "FeatureCollection", features: [] };
  const MANUAL_EXCLUSIONS = new Set([
    // Data-quality review: a 165 m² sliver was returned against the 19,679 m² Site 1 reference.
    "site1::UUID_18673aed-cba2-418b-9e65-f1fa6aa9bc8a"
  ]);
  const FILTER_LEVELS = [
    {
      id: "1+2",
      label: "Similar plots",
      stage: "Filter 1+2",
      explanation: "Starts with Business 1 land use. A plot is included when either both its width and aspect ratio are within ±20% of the reference, or its final allowable GFA is within ±20%. This is an OR rule, so similar development capacity can qualify even when a plot looks different."
    },
    {
      id: "1+2+3",
      label: "Similar neighbours",
      stage: "Filter 1+2+3",
      explanation: "Keeps the plot matches, then compares non-road plots within 75 m of each candidate: 0–2 educational plots, at least 1 residential plot, and at least 1 Business 1-family plot."
    },
    {
      id: "1+2+3+4",
      label: "Similar road frontage",
      stage: "Filter 1+2+3+4",
      explanation: "Keeps the plot and neighbour matches, then compares bordering roads. The total number of roads and the number of each road type must both be within ±1 of the reference site."
    }
  ];
  const DEFAULT_FILTER_LEVEL = FILTER_LEVELS[0].id;
  const DATASETS = [
    { id: "site1", label: "Site 1", url: "data/SITE1-like_similar_plots_v2.geojson", neighbourUrl: "data/SITE1_similar_plot_nonroad_neighbours.geojson" },
    { id: "site2", label: "Site 2", url: "data/SITE2-like_similar_plots_v2.geojson", neighbourUrl: "data/SITE2_similar_plot_nonroad_neighbours.geojson" }
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
    activeSimilaritySite: null,
    activeCandidates: [],
    activeNeighbourCandidateKey: null,
    activeNeighbours: [],
    neighbourRequestId: 0,
    selectedFilterLevel: null,
    expandedFilterInfo: null,
    retrievalRequestId: 0,
    isRetrieving: false,
    webMcpLifecycle: null
  };

  const els = {
    tokenNotice: document.getElementById("tokenNotice"),
    mapStatus: document.getElementById("mapStatus"),
    selectionEmpty: document.getElementById("selectionEmpty"),
    siteDetails: document.getElementById("siteDetails"),
    detailRole: document.getElementById("detailRole"),
    detailTitle: document.getElementById("detailTitle"),
    detailBadge: document.getElementById("detailBadge"),
    detailAddressRow: document.getElementById("detailAddressRow"),
    detailAddress: document.getElementById("detailAddress"),
    metricAreaLabel: document.getElementById("metricAreaLabel"),
    metricArea: document.getElementById("metricArea"),
    metricGfa: document.getElementById("metricGfa"),
    metricGpr: document.getElementById("metricGpr"),
    metricAspect: document.getElementById("metricAspect"),
    filterControls: document.getElementById("filterControls"),
    filterModeButtons: Array.from(document.querySelectorAll(".filter-choice[data-filter-mode]")),
    filterInfoButtons: Array.from(document.querySelectorAll(".filter-info-button")),
    filterExplanation: document.getElementById("filterExplanation"),
    filterExplanationTitle: document.getElementById("filterExplanationTitle"),
    filterExplanationText: document.getElementById("filterExplanationText"),
    similarityLoading: document.getElementById("similarityLoading"),
    similarityLoadingText: document.getElementById("similarityLoadingText"),
    similarHint: document.getElementById("similarHint"),
    resultsSection: document.getElementById("resultsSection"),
    resultsList: document.getElementById("resultsList"),
    resultCount: document.getElementById("resultCount"),
    overviewButton: document.getElementById("overviewButton"),
    pitchButton: document.getElementById("pitchButton"),
    informationButton: document.getElementById("informationButton"),
    informationOverlay: document.getElementById("informationOverlay"),
    informationSheet: document.getElementById("informationSheet"),
    informationClose: document.getElementById("informationClose"),
    site1Zone: document.getElementById("site1Zone"),
    site2Zone: document.getElementById("site2Zone")
  };

  let lastInformationFocus = null;

  function setInformationOpen(open) {
    if (!els.informationOverlay) return;
    els.informationOverlay.dataset.open = String(open);
    els.informationOverlay.setAttribute("aria-hidden", String(!open));
    els.informationButton.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("information-open", open);
    if (open) {
      lastInformationFocus = document.activeElement;
      requestAnimationFrame(() => els.informationSheet.focus());
    } else {
      const focusTarget = lastInformationFocus && lastInformationFocus !== document.body ? lastInformationFocus : els.informationButton;
      if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus();
    }
  }

  function wireInformationPanel() {
    if (!els.informationButton || !els.informationOverlay || !els.informationSheet || !els.informationClose) return;
    els.informationButton.addEventListener("click", () => setInformationOpen(true));
    els.informationClose.addEventListener("click", () => setInformationOpen(false));
    els.informationOverlay.addEventListener("click", (event) => {
      if (event.target === els.informationOverlay) setInformationOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (els.informationOverlay.dataset.open !== "true") return;
      if (event.key === "Escape") {
        event.preventDefault();
        setInformationOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(els.informationSheet.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function setStatus(message, isError, isLoading) {
    els.mapStatus.classList.toggle("error", Boolean(isError));
    els.mapStatus.classList.toggle("loading", Boolean(isLoading));
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
      .replace(/([A-Za-z])(\d)/g, "$1 $2")
      .replace(/Business\s*1/i, "Business 1")
      .trim();
  }

  function plotDisplayName(feature) {
    if (feature.properties.Role === "Reference") return normalizeZone(feature.properties.Zone);
    return feature.properties["Short address"] || normalizeZone(feature.properties.Zone);
  }

  function neighbourZoneColor(zone) {
    const value = String(zone || "").toLowerCase();
    if (value.includes("educational")) return NEIGHBOUR_COLORS.education;
    if (value.includes("residential")) return NEIGHBOUR_COLORS.residential;
    if (value.includes("commercial") || value.includes("hotel")) return NEIGHBOUR_COLORS.commercial;
    if (value.includes("park") || value.includes("open space") || value.includes("openspace") || value.includes("sports")) return NEIGHBOUR_COLORS.green;
    if (value.includes("civic") || value.includes("worship") || value.includes("health")) return NEIGHBOUR_COLORS.community;
    if (value.includes("business")) return NEIGHBOUR_COLORS.business;
    return NEIGHBOUR_COLORS.other;
  }

  function neighbourRouteLabel(routes) {
    const values = Array.isArray(routes) ? routes : [];
    if (values.includes("within-75m-polygon-buffer")) return "Within 75 m";
    if (values.includes("direct") && values.includes("across-road")) return "Direct / across one road";
    if (values.includes("direct")) return "Direct neighbour";
    if (values.includes("across-road")) return "Across one road";
    return "Nearby plot";
  }

  function compactKgId(value) {
    const text = String(value || "").replace(/^UUID_/i, "");
    return text ? `…${text.slice(-8)}` : "Not available";
  }

  function compactBuildableId(value) {
    const text = String(value || "");
    return text ? `${text.slice(0, 8)}…` : "Not available";
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
  function formatGfa(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? `${formatNumber(number, 0)} m²` : "Not available";
  }

  function featureLookupKey(siteId, uuid) {
    return `${siteId}::${uuid}`;
  }

  function getFilterDefinition(level) {
    return FILTER_LEVELS.find((filter) => filter.id === level) || FILTER_LEVELS[0];
  }

  function getCandidatesForLevel(dataset, level) {
    const selectedLevel = level || state.selectedFilterLevel;
    if (!dataset || !selectedLevel) return [];
    return dataset.candidatesByLevel[selectedLevel] || [];
  }

  function setFilterLevel(level) {
    const selected = level ? getFilterDefinition(level) : null;
    state.selectedFilterLevel = selected ? selected.id : null;
    els.filterModeButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(Boolean(selected && button.dataset.filterMode === selected.id)));
    });
    hideFilterExplanation();
  }

  function hideFilterExplanation() {
    state.expandedFilterInfo = null;
    els.filterExplanation.classList.add("hidden");
    els.filterInfoButtons.forEach((button) => button.setAttribute("aria-expanded", "false"));
  }

  function toggleFilterExplanation(level) {
    const filter = getFilterDefinition(level);
    const wasOpen = state.expandedFilterInfo === filter.id && !els.filterExplanation.classList.contains("hidden");
    hideFilterExplanation();
    if (wasOpen) return;
    state.expandedFilterInfo = filter.id;
    els.filterExplanationTitle.textContent = filter.label;
    els.filterExplanationText.textContent = filter.explanation;
    els.filterExplanation.classList.remove("hidden");
    const activeButton = els.filterInfoButtons.find((button) => button.dataset.filterInfo === filter.id);
    if (activeButton) activeButton.setAttribute("aria-expanded", "true");
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

  function isTrue(value) {
    return value === true || String(value).toLowerCase() === "true";
  }

  function matchBasis(feature) {
    const p = feature.properties || {};
    const dimensions = isTrue(p["Width and aspect match"]);
    const gfa = isTrue(p["GFA match"]);
    if (dimensions && gfa) return "Dimensions + GFA";
    if (dimensions) return "Dimensions";
    if (gfa) return "Allowable GFA";
    return "Filter match";
  }

  function matchScore(feature) {
    const p = feature.properties || {};
    const routes = [];
    const widthDiff = Math.abs(Number(p["Width diff"]));
    const aspectDiff = Math.abs(Number(p["Aspect diff"]));
    const gfaDiff = Math.abs(Number(p["GFA diff"]));
    if (isTrue(p["Width and aspect match"]) && Number.isFinite(widthDiff) && Number.isFinite(aspectDiff)) {
      routes.push((widthDiff + aspectDiff) / 2);
    }
    if (isTrue(p["GFA match"]) && Number.isFinite(gfaDiff)) routes.push(gfaDiff);
    if (!routes.length) return 0;
    return Math.max(0, Math.min(1, 1 - Math.min(...routes)));
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

  async function fetchGeoJson(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      const collection = await response.json();
      if (!collection || collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
        throw new Error(`${url} is not a valid GeoJSON FeatureCollection`);
      }
      return collection;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function loadDatasets() {
    const loaded = await Promise.all(DATASETS.map(async (dataset) => {
      const collection = await fetchGeoJson(dataset.url);
      const sourceFeatures = collection.features
        .filter((feature) => feature && feature.properties && feature.geometry && ["Polygon", "MultiPolygon"].includes(feature.geometry.type))
        .filter((feature) => {
          if (feature.properties.Role !== "Candidate") return true;
          return !MANUAL_EXCLUSIONS.has(featureLookupKey(dataset.id, String(feature.properties.UUID || "")));
        })
        .map((feature, index) => {
          const cloned = JSON.parse(JSON.stringify(feature));
          cloned.properties = {
            ...cloned.properties,
            __site: dataset.id,
            __datasetLabel: dataset.label,
            __featureIndex: index
          };
          cloned.id = `${dataset.id}-${index}`;
          return cloned;
        });
      const reference = sourceFeatures.find((feature) => feature.properties.Role === "Reference") || sourceFeatures[0];
      const candidateMap = new Map();
      const candidateIdsByLevel = Object.fromEntries(FILTER_LEVELS.map((filter) => [filter.id, new Set()]));

      sourceFeatures.filter((feature) => feature.properties.Role === "Candidate").forEach((feature) => {
        const uuid = String(feature.properties.UUID || feature.id);
        if (!candidateMap.has(uuid)) candidateMap.set(uuid, feature);
        const filter = FILTER_LEVELS.find((item) => item.stage === feature.properties["Filter stage"]);
        if (filter) candidateIdsByLevel[filter.id].add(uuid);
      });

      const candidates = Array.from(candidateMap.values()).sort((a, b) => matchScore(b) - matchScore(a));
      const candidatesByLevel = Object.fromEntries(FILTER_LEVELS.map((filter) => [
        filter.id,
        candidates.filter((feature) => candidateIdsByLevel[filter.id].has(String(feature.properties.UUID || feature.id)))
      ]));
      const features = [reference, ...candidates];
      features.forEach((feature) => {
        const uuid = feature.properties.UUID || feature.id;
        state.featuresById.set(featureLookupKey(dataset.id, String(uuid)), feature);
      });
      return [dataset.id, { ...dataset, features, reference, candidates, candidatesByLevel }];
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
    map.addSource("neighbours", { type: "geojson", data: EMPTY_COLLECTION, generateId: true });
    map.addSource("neighbour-selection", { type: "geojson", data: EMPTY_COLLECTION });

    map.addLayer({
      id: "links-glow",
      type: "line",
      source: "links",
      slot: "top",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": 4,
        "line-opacity": 0.055,
        "line-blur": 2.5
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
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.95, 13, 1.55],
        "line-opacity": 0.42,
        "line-dasharray": [0, 3, 2]
      }
    });

    map.addLayer({
      id: "plots-fill",
      type: "fill",
      source: "plots",
      slot: "top",
      filter: ["==", ["get", "Role"], "Reference"],
      paint: {
        "fill-color": ["match", ["get", "__site"], "site1", COLORS.site1, COLORS.site2],
        "fill-opacity": ["case", ["==", ["get", "Role"], "Reference"], 0.84, 0.76]
      }
    });

    map.addLayer({
      id: "plots-outline",
      type: "line",
      source: "plots",
      slot: "top",
      filter: ["==", ["get", "Role"], "Reference"],
      paint: {
        "line-color": ["match", ["get", "__site"], "site1", OUTLINE_COLORS.site1, OUTLINE_COLORS.site2],
        "line-width": ["case", ["==", ["get", "Role"], "Reference"], 3.8, 2.4],
        "line-opacity": ["case", ["==", ["get", "Role"], "Reference"], 1, 0.96]
      }
    });

    map.addLayer({
      id: "neighbours-fill",
      type: "fill",
      source: "neighbours",
      slot: "top",
      paint: {
        "fill-color": ["get", "zone_color"],
        "fill-opacity": 0.58
      }
    });

    map.addLayer({
      id: "neighbours-outline",
      type: "line",
      source: "neighbours",
      slot: "top",
      layout: { "line-join": "round" },
      paint: {
        "line-color": ["get", "zone_color"],
        "line-width": 1.8,
        "line-opacity": 0.95
      }
    });

    map.addLayer({
      id: "neighbour-selection-fill",
      type: "fill",
      source: "neighbour-selection",
      slot: "top",
      paint: { "fill-color": ["get", "zone_color"], "fill-opacity": 0.82 }
    });

    map.addLayer({
      id: "neighbour-selection-outline",
      type: "line",
      source: "neighbour-selection",
      slot: "top",
      layout: { "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": 4.5,
        "line-opacity": 1
      }
    });

    map.addLayer({
      id: "selection-fill",
      type: "fill",
      source: "selection",
      slot: "top",
      paint: { "fill-color": ["get", "color"], "fill-opacity": 0.82 }
    });

    map.addLayer({
      id: "selection-glow",
      type: "line",
      source: "selection",
      slot: "top",
      layout: { "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": 12,
        "line-opacity": 0.24,
        "line-blur": 4
      }
    });

    map.addLayer({
      id: "selection-casing",
      type: "line",
      source: "selection",
      slot: "top",
      layout: { "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": 7,
        "line-opacity": 0.98
      }
    });

    map.addLayer({
      id: "selection-outline",
      type: "line",
      source: "selection",
      slot: "top",
      layout: { "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": 4,
        "line-opacity": 1
      }
    });

    const labels = Object.values(state.datasets)
      .filter((dataset) => dataset.reference)
      .map((dataset) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: getCenter(dataset.reference) },
        properties: { label: dataset.label.toUpperCase(), __site: dataset.id, uuid: dataset.reference.properties.UUID }
      }));

    map.addSource("reference-labels", { type: "geojson", data: { type: "FeatureCollection", features: labels } });
    map.addLayer({
      id: "reference-marker-halo",
      type: "circle",
      source: "reference-labels",
      slot: "top",
      paint: {
        "circle-radius": 16,
        "circle-color": ["match", ["get", "__site"], "site1", COLORS.site1, COLORS.site2],
        "circle-opacity": 0.18,
        "circle-blur": 0.35
      }
    });
    map.addLayer({
      id: "reference-marker",
      type: "circle",
      source: "reference-labels",
      slot: "top",
      paint: {
        "circle-radius": 7.5,
        "circle-color": ["match", ["get", "__site"], "site1", COLORS.site1, COLORS.site2],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3
      }
    });
    map.addLayer({
      id: "reference-labels",
      type: "symbol",
      source: "reference-labels",
      slot: "top",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 13,
        "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
        "text-offset": [1.25, 0],
        "text-anchor": "left",
        "text-allow-overlap": true
      },
      paint: {
        "text-color": ["match", ["get", "__site"], "site1", OUTLINE_COLORS.site1, OUTLINE_COLORS.site2],
        "text-halo-color": "#ffffff",
        "text-halo-width": 3,
        "text-halo-blur": 0.5
      }
    });

    map.on("mouseenter", "neighbours-fill", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "neighbours-fill", () => { map.getCanvas().style.cursor = ""; });
    map.on("mouseenter", "plots-fill", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "plots-fill", () => { map.getCanvas().style.cursor = ""; });
    map.on("mouseenter", "reference-labels", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "reference-labels", () => { map.getCanvas().style.cursor = ""; });
    map.on("mouseenter", "reference-marker", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "reference-marker", () => { map.getCanvas().style.cursor = ""; });

    map.on("click", "neighbours-fill", (event) => {
      const rendered = event.features && event.features[0];
      if (rendered) showNeighbourPopup(rendered, event.lngLat);
    });

    map.on("click", "plots-fill", (event) => {
      const rendered = event.features && event.features[0];
      if (!rendered) return;
      const original = state.featuresById.get(featureLookupKey(rendered.properties.__site, String(rendered.properties.UUID || rendered.id)));
      if (original) selectFeature(original, true);
    });

    map.on("click", "reference-labels", (event) => {
      const rendered = event.features && event.features[0];
      const original = rendered && state.featuresById.get(featureLookupKey(rendered.properties.__site, String(rendered.properties.uuid)));
      if (original) selectFeature(original, true);
    });

    map.on("click", "reference-marker", (event) => {
      const rendered = event.features && event.features[0];
      const original = rendered && state.featuresById.get(featureLookupKey(rendered.properties.__site, String(rendered.properties.uuid)));
      if (original) selectFeature(original, true);
    });

    map.on("click", (event) => {
      if (!state.activeNeighbourCandidateKey) return;
      const interactiveLayers = ["neighbours-fill", "plots-fill", "reference-labels", "reference-marker"]
        .filter((layerId) => map.getLayer(layerId));
      const hits = map.queryRenderedFeatures(event.point, { layers: interactiveLayers });
      if (hits.length) return;
      clearNeighbourContext({ removePopup: true });
      els.similarHint.textContent = "Neighbouring plots hidden. Select a similar plot to browse its context again.";
      setStatus("Neighbouring plots hidden");
    });

    startDashAnimation();
  }

  function startDashAnimation() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const sequence = [
      [0, 3, 2], [0.5, 3, 1.5], [1, 3, 1], [1.5, 3, 0.5],
      [2, 3, 0], [0, 0.5, 2, 2.5], [0, 1, 2, 2], [0, 1.5, 2, 1.5], [0, 2, 2, 1]
    ];
    let lastStep = -1;
    const animate = (timestamp) => {
      if (state.map && state.map.getLayer("links-dashed")) {
        const step = Math.floor(timestamp / 120) % sequence.length;
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
      padding: mobile ? { top: 100, right: 55, bottom: Math.round(window.innerHeight * 0.48) + 40, left: 55 } : { top: 120, right: 160, bottom: 90, left: 410 },
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

  function setCandidateVisibility(siteId, candidates) {
    if (!state.map) return;
    const candidateIds = (candidates || []).map((feature) => String(feature.properties.UUID || feature.id));
    const candidateFilter = candidateIds.length
      ? ["all",
          ["==", ["get", "Role"], "Candidate"],
          ["==", ["get", "__site"], siteId],
          ["in", ["get", "UUID"], ["literal", candidateIds]]
        ]
      : ["==", ["get", "Role"], "__none__"];
    const filter = siteId
      ? ["any", ["==", ["get", "Role"], "Reference"], candidateFilter]
      : ["==", ["get", "Role"], "Reference"];
    ["plots-fill", "plots-outline"].forEach((layerId) => {
      if (state.map.getLayer(layerId)) state.map.setFilter(layerId, filter);
    });
  }

  function setSimilarityLoading(isLoading, filter) {
    state.isRetrieving = isLoading;
    els.filterControls.setAttribute("aria-busy", String(isLoading));
    els.filterModeButtons.forEach((button) => { button.disabled = isLoading; });
    els.filterInfoButtons.forEach((button) => { button.disabled = isLoading; });
    els.similarityLoading.classList.toggle("hidden", !isLoading);
    if (isLoading) {
      els.similarityLoadingText.textContent = `Updating ${filter.label.toLowerCase()}`;
      setStatus(`Updating ${filter.label.toLowerCase()}`, false, true);
    } else {
      els.mapStatus.classList.remove("loading");
    }
  }


  function clearNeighbourContext({ removePopup = false } = {}) {
    state.neighbourRequestId += 1;
    state.activeNeighbourCandidateKey = null;
    state.activeNeighbours = [];
    const neighbours = state.map && state.map.getSource("neighbours");
    const selection = state.map && state.map.getSource("neighbour-selection");
    if (neighbours) neighbours.setData(EMPTY_COLLECTION);
    if (selection) selection.setData(EMPTY_COLLECTION);
    if (removePopup && state.popup) {
      state.popup.remove();
      state.popup = null;
    }
  }

  function prepareNeighbours(collection, siteId, candidateUuid) {
    return collection.features.flatMap((feature) => {
      const source = (feature.properties.sources || []).find((item) => item.uuid === candidateUuid);
      if (!source) return [];
      const p = feature.properties;
      return [{
        ...feature,
        properties: {
          __site: siteId,
          neighbour_uuid: p.neighbour_uuid,
          zone: normalizeZone(p.zone),
          zone_color: neighbourZoneColor(p.zone),
          relationship: neighbourRouteLabel(source.routes),
          site_area_m2: p.site_area_m2,
          allowable_gfa_min_m2: p.allowable_gfa_min_m2,
          allowable_gfa_max_m2: p.allowable_gfa_max_m2,
          master_plan_gpr: p.master_plan_gpr,
          width_m: p.width_m,
          aspect_ratio: p.aspect_ratio,
          rectangularity: p.rectangularity,
          programmes_label: (p.programmes || []).map(normalizeZone).join(", "),
          storeys_label: (p.storeys || []).join(", "),
          setbacks_label: (p.setbacks_m || []).join(", "),
          gfa_schemes_json: JSON.stringify(p.gfa_schemes || []),
          regulation_types_label: (p.regulation_types || []).map(normalizeZone).join(", ")
        }
      }];
    });
  }

  async function loadNeighbourCollection(dataset) {
    if (dataset.neighbourCollection) return dataset.neighbourCollection;
    if (!dataset.neighbourPromise) {
      dataset.neighbourPromise = fetchGeoJson(dataset.neighbourUrl, 30000)
        .then((collection) => {
          dataset.neighbourCollection = collection;
          return collection;
        })
        .catch((error) => {
          dataset.neighbourPromise = null;
          throw error;
        });
    }
    return dataset.neighbourPromise;
  }

  function focusNeighbourContext(candidate, neighbours) {
    const bounds = new mapboxgl.LngLatBounds();
    getCoordinates(candidate.geometry).forEach((coordinate) => bounds.extend(coordinate));
    neighbours.forEach((feature) => {
      getCoordinates(feature.geometry).forEach((coordinate) => bounds.extend(coordinate));
    });
    if (bounds.isEmpty()) return;
    const mobile = window.innerWidth <= 700;
    state.map.fitBounds(bounds, {
      padding: mobile
        ? { top: 88, right: 24, bottom: Math.round(window.innerHeight * 0.47) + 28, left: 24 }
        : { top: 105, right: 80, bottom: 70, left: 420 },
      maxZoom: 16.8,
      pitch: 48,
      bearing: 10,
      duration: 1100,
      essential: true
    });
    setBuildings(true);
  }

  function neighbourSummaryHtml(neighbours) {
    if (!Array.isArray(neighbours)) return "";
    const zoneCounts = new Map();
    neighbours.forEach((feature) => {
      const zone = feature.properties.zone || "Not specified";
      zoneCounts.set(zone, (zoneCounts.get(zone) || 0) + 1);
    });
    const chips = [...zoneCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([zone, count]) => `<span><i style="background:${neighbourZoneColor(zone)}"></i>${escapeHtml(zone)} &middot; ${count}</span>`)
      .join("");
    return `<div class="neighbour-summary">
      <strong>${neighbours.length} neighbouring KG plot${neighbours.length === 1 ? "" : "s"}</strong>
      <div class="neighbour-chips">${chips}</div>
      <small>Select a coloured neighbour to browse its land-use and development characteristics. Click empty map space to close this context.</small>
    </div>`;
  }

  function optionalMetric(value, formatter) {
    if (value === null || value === undefined || value === "") return "Not available";
    return formatter ? formatter(value) : escapeHtml(String(value));
  }

  function neighbourGfaLabel(p) {
    const minimum = p.allowable_gfa_min_m2 === null || p.allowable_gfa_min_m2 === undefined ? NaN : Number(p.allowable_gfa_min_m2);
    const maximum = p.allowable_gfa_max_m2 === null || p.allowable_gfa_max_m2 === undefined ? NaN : Number(p.allowable_gfa_max_m2);
    if (!Number.isFinite(minimum) && !Number.isFinite(maximum)) return "Not available";
    if (Number.isFinite(minimum) && Number.isFinite(maximum) && Math.abs(minimum - maximum) > 0.5) {
      return `${formatNumber(minimum, 0)}-${formatNumber(maximum, 0)} m\u00b2`;
    }
    return `${formatNumber(Number.isFinite(maximum) ? maximum : minimum, 0)} m\u00b2`;
  }
  function parseGfaSchemes(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || !value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function schemeValues(values, formatter) {
    const list = Array.isArray(values) ? values.filter((value) => Number.isFinite(Number(value))) : [];
    if (!list.length) return "Not specified";
    return list.map((value) => formatter(value)).join(", ");
  }

  function gfaSchemesHtml(schemes) {
    if (!schemes.length) return "";
    const tabs = schemes.length > 1 ? `<div class="gfa-scheme-tabs" role="tablist" aria-label="Allowable GFA schemes">
      ${schemes.map((scheme, index) => `<button id="gfa-scheme-tab-${index}" type="button" role="tab" class="gfa-scheme-tab" data-scheme-index="${index}" aria-selected="${index === 0}" aria-controls="gfa-scheme-panel-${index}">${escapeHtml(normalizeZone(scheme.label))}</button>`).join("")}
    </div>` : "";
    const panels = schemes.map((scheme, index) => {
      const difference = scheme.diff_from_reference_pct === null || scheme.diff_from_reference_pct === undefined ? NaN : Number(scheme.diff_from_reference_pct);
      const differenceLabel = Number.isFinite(difference)
        ? `${difference >= 0 ? "+" : ""}${formatNumber(difference * 100, 0)}%`
        : "Not specified";
      return `<section id="gfa-scheme-panel-${index}" class="gfa-scheme-panel${index === 0 ? "" : " hidden"}" role="tabpanel" ${schemes.length > 1 ? `aria-labelledby="gfa-scheme-tab-${index}"` : ""}>
        <div class="gfa-scheme-heading"><span>SCHEME ${index + 1} OF ${schemes.length}</span><strong>${escapeHtml(normalizeZone(scheme.label))}</strong></div>
        <div class="gfa-scheme-value"><span>Allowable GFA</span><strong>${formatArea(scheme.allowable_gfa_m2)}</strong></div>
        <dl class="gfa-scheme-details">
          <dt>Vs reference GFA</dt><dd>${differenceLabel}</dd>
          <dt>Plot ratio options</dt><dd>${schemeValues(scheme.gpr_values, (value) => formatNumber(value, 1))}</dd>
          <dt>Storey options</dt><dd>${schemeValues(scheme.storeys, (value) => formatNumber(value, 0))}</dd>
          <dt>Setback options</dt><dd>${schemeValues(scheme.setbacks_m, (value) => `${formatNumber(value, 1)} m`)}</dd>
          <dt>Buildable-space ID</dt><dd class="kg-id">${escapeHtml(compactBuildableId(scheme.buildable_space_id))}</dd>
        </dl>
      </section>`;
    }).join("");
    return `<div class="gfa-schemes"><div class="gfa-schemes-title"><strong>Allowable GFA schemes</strong><span>${schemes.length}</span></div>${tabs}${panels}</div>`;
  }

  function wireGfaSchemeTabs(root) {
    const tabs = Array.from(root.querySelectorAll(".gfa-scheme-tab"));
    const panels = Array.from(root.querySelectorAll(".gfa-scheme-panel"));
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => {
        tabs.forEach((item, itemIndex) => item.setAttribute("aria-selected", String(itemIndex === index)));
        panels.forEach((panel, panelIndex) => panel.classList.toggle("hidden", panelIndex !== index));
      });
    });
  }

  function keepNeighbourPopupInDesktopViewport(popup) {
    if (window.innerWidth < 900) return;
    const fit = (attempt = 0) => {
      const element = popup.getElement();
      if (!element || !element.isConnected) return;
      const rect = element.getBoundingClientRect();
      const margin = 14;
      let shiftX = 0;
      let shiftY = 0;
      if (rect.left < margin) shiftX = margin - rect.left;
      else if (rect.right > window.innerWidth - margin) shiftX = window.innerWidth - margin - rect.right;
      if (rect.top < margin) shiftY = margin - rect.top;
      else if (rect.bottom > window.innerHeight - margin) shiftY = window.innerHeight - margin - rect.bottom;
      if (!shiftX && !shiftY) return;
      state.map.panBy([-shiftX, -shiftY], { duration: attempt === 0 ? 260 : 120 });
      if (attempt < 2) window.setTimeout(() => fit(attempt + 1), attempt === 0 ? 300 : 150);
    };
    requestAnimationFrame(() => requestAnimationFrame(() => fit()));
  }
  function showNeighbourPopup(feature, lngLat) {
    const p = feature.properties;
    const selection = state.map.getSource("neighbour-selection");
    if (selection) selection.setData({ type: "FeatureCollection", features: [feature] });
    if (state.popup) state.popup.remove();
    const programmes = p.programmes_label || "Not specified";
    const schemes = parseGfaSchemes(p.gfa_schemes_json);
    const controls = [
      p.storeys_label ? `${escapeHtml(p.storeys_label)} storey control` : "",
      p.setbacks_label ? `${escapeHtml(p.setbacks_label)} m setbacks` : ""
    ].filter(Boolean).join(" &middot; ") || "Not specified";
    const fallbackGfa = schemes.length ? "" : `
      <dt>Allowable GFA</dt><dd>${neighbourGfaLabel(p)}</dd>
      <dt>Plot ratio</dt><dd>${optionalMetric(p.master_plan_gpr, (value) => formatNumber(value, 1))}</dd>
      <dt>KG programmes</dt><dd>${escapeHtml(programmes)}</dd>
      <dt>KG controls</dt><dd>${controls}</dd>`;
    const html = `<div class="map-popup neighbour-popup">
      <div class="neighbour-popup-overview">
        <div class="popup-kicker">NEIGHBOURING KG PLOT</div>
      <h4>${escapeHtml(p.zone || "Neighbouring plot")}</h4>
      <dl>
        <dt>Relationship</dt><dd>${escapeHtml(p.relationship)}</dd>
        <dt>Planning zone</dt><dd>${escapeHtml(p.zone)}</dd>
        <dt>Plot area</dt><dd>${optionalMetric(p.site_area_m2, formatArea)}</dd>
        <dt>Plot width</dt><dd>${optionalMetric(p.width_m, (value) => `${formatNumber(value, 1)} m`)}</dd>
        <dt>Aspect ratio</dt><dd>${optionalMetric(p.aspect_ratio, (value) => formatNumber(value, 2))}</dd>
        ${fallbackGfa}
        <dt>KG records</dt><dd>${escapeHtml(p.regulation_types_label || "Not specified")}</dd>
        <dt>KG ID</dt><dd class="kg-id">${escapeHtml(compactKgId(p.neighbour_uuid))}</dd>
        </dl>
      </div>
      ${gfaSchemesHtml(schemes)}
    </div>`;
    state.popup = new mapboxgl.Popup({ anchor: "bottom", offset: 12, closeButton: true, maxWidth: "620px", className: "neighbour-popup-shell" })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(state.map);
    wireGfaSchemeTabs(state.popup.getElement());
    keepNeighbourPopupInDesktopViewport(state.popup);
    setStatus(`${p.zone || "Neighbouring plot"} KG information`);
  }

  async function showNeighbourContext(candidate) {
    const p = candidate.properties;
    const dataset = state.datasets[p.__site];
    const candidateUuid = String(p.UUID || candidate.id);
    const candidateKey = featureLookupKey(dataset.id, candidateUuid);
    const requestId = state.neighbourRequestId;
    state.activeNeighbourCandidateKey = candidateKey;
    els.similarHint.textContent = "Loading neighbouring KG plots...";
    setStatus("Loading neighbouring KG plots", false, true);
    try {
      const collection = await loadNeighbourCollection(dataset);
      if (requestId !== state.neighbourRequestId || state.activeNeighbourCandidateKey !== candidateKey) return;
      const neighbours = prepareNeighbours(collection, dataset.id, candidateUuid);
      state.activeNeighbours = neighbours;
      const source = state.map.getSource("neighbours");
      if (source) source.setData({ type: "FeatureCollection", features: neighbours });
      makePopup(candidate, neighbours);
      focusNeighbourContext(candidate, neighbours);
      els.similarHint.textContent = `${neighbours.length} neighbouring KG plots shown. Select a coloured plot to browse its characteristics.`;
      setStatus(`${neighbours.length} neighbouring KG plots shown`);
    } catch (error) {
      console.error(error);
      if (requestId !== state.neighbourRequestId) return;
      state.activeNeighbourCandidateKey = null;
      els.similarHint.textContent = "Neighbouring KG information could not be loaded. Select the plot to try again.";
      setStatus("Neighbouring KG information could not be loaded", true);
    }
  }

  function clearSimilar({ resetMode = false } = {}) {
    clearNeighbourContext({ removePopup: true });
    state.retrievalRequestId += 1;
    state.activeSimilaritySite = null;
    state.activeCandidates = [];
    setSimilarityLoading(false);
    hideFilterExplanation();
    if (resetMode) setFilterLevel(null);
    setCandidateVisibility(null);
    const links = state.map && state.map.getSource("links");
    if (links) links.setData(EMPTY_COLLECTION);
    els.resultsSection.classList.add("hidden");
    els.resultsList.innerHTML = "";
    els.resultCount.textContent = "0";
  }

  function updateRetrievalControls(dataset) {
    if (!state.selectedFilterLevel) {
      els.similarHint.textContent = "Choose a view to display matching plots.";
      return;
    }
    const candidates = getCandidatesForLevel(dataset);
    const filter = getFilterDefinition(state.selectedFilterLevel);
    if (!candidates.length) {
      els.similarHint.textContent = `No plots match “${filter.label}” for this site.`;
    } else {
      els.similarHint.textContent = `Showing ${candidates.length} plots in “${filter.label}”. Select another view to compare.`;
    }
  }

  function makePopup(feature, neighbours = null) {
    if (state.popup) state.popup.remove();
    const p = feature.properties;
    const dataset = state.datasets[p.__site];
    const isReference = p.Role === "Reference";
    const roleLabel = isReference ? dataset.label : `${dataset.label} · Similar plot`;
    const matchRow = isReference ? "" : `<dt>Matched by</dt><dd>${escapeHtml(matchBasis(feature))}</dd>`;
    const zoneRow = isReference ? "" : `<dt>Planning zone</dt><dd>${escapeHtml(normalizeZone(p.Zone))}</dd>`;
    const neighbourSummary = isReference ? "" : neighbourSummaryHtml(neighbours);
    const html = `<div class="map-popup">
      <div class="popup-kicker">${escapeHtml(roleLabel.toUpperCase())}</div>
      <h4>${escapeHtml(plotDisplayName(feature))}</h4>
      <dl>
        ${zoneRow}
        <dt>${isReference ? "Site area" : "Plot area"}</dt><dd>${escapeHtml(formatArea(p["KG site area m²"]))}</dd>
        <dt>Allowable GFA</dt><dd>${escapeHtml(formatGfa(p["Final allowable GFA m²"]))}</dd>
        <dt>Plot ratio</dt><dd>${escapeHtml(formatNumber(p["Master Plan GPR"], 1))}</dd>
        ${matchRow}
      </dl>
      ${neighbourSummary}
    </div>`;
    state.popup = new mapboxgl.Popup({ offset: 14, closeButton: true })
      .setLngLat(getCenter(feature))
      .setHTML(html)
      .addTo(state.map);
  }

  function selectFeature(feature, shouldFocus) {
    const p = feature.properties;
    const previousSite = state.selectedFeature && state.selectedFeature.properties.__site;
    if (state.activeSimilaritySite && state.activeSimilaritySite !== p.__site) clearSimilar({ resetMode: true });
    if (p.Role === "Reference" && previousSite && previousSite !== p.__site) clearSimilar({ resetMode: true });
    state.selectedFeature = feature;
    const dataset = state.datasets[p.__site];
    const isReference = p.Role === "Reference";
    clearNeighbourContext({ removePopup: false });
    const visibleCandidates = state.activeSimilaritySite === dataset.id ? state.activeCandidates : [];
    let candidatePosition = visibleCandidates.findIndex((candidate) => candidate.properties.UUID === p.UUID);
    if (candidatePosition < 0) candidatePosition = dataset.candidates.findIndex((candidate) => candidate.properties.UUID === p.UUID);

    updateTabState(p.__site);
    updateSelectionSource(feature);
    els.selectionEmpty.classList.add("hidden");
    els.siteDetails.classList.remove("hidden");
    els.detailRole.textContent = isReference ? "REFERENCE SITE" : `SIMILAR PLOT ${String(candidatePosition + 1).padStart(2, "0")}`;
    els.detailTitle.textContent = isReference ? dataset.label : plotDisplayName(feature);
    els.detailBadge.textContent = normalizeZone(p.Zone);
    els.detailAddressRow.classList.toggle("hidden", isReference || !p["Full address"]);
    els.detailAddress.textContent = isReference ? "—" : (p["Full address"] || "Address not available");
    els.metricAreaLabel.textContent = isReference ? "Site area" : "Plot area";
    els.metricArea.textContent = formatArea(p["KG site area m²"]);
    els.metricGfa.textContent = formatGfa(p["Final allowable GFA m²"]);
    els.metricGpr.textContent = formatNumber(p["Master Plan GPR"], 1);
    els.metricAspect.textContent = formatNumber(p["Aspect ratio"], 2);

    els.filterControls.classList.remove("hidden");
    if (isReference) {
      updateRetrievalControls(dataset);
    } else {
      els.similarHint.textContent = `Matched by ${matchBasis(feature).toLowerCase()}.`;
    }

    if (!isReference) {
      els.resultsSection.classList.remove("hidden");
      renderResults(dataset, visibleCandidates, p.UUID);
    } else if (state.activeSimilaritySite === dataset.id) {
      els.resultsSection.classList.remove("hidden");
      renderResults(dataset, state.activeCandidates);
    } else {
      els.resultsSection.classList.add("hidden");
    }

    makePopup(feature);
    if (shouldFocus) focusFeature(feature);
    setStatus(`${isReference ? dataset.label : "Similar plot"} selected`);
    if (!isReference) void showNeighbourContext(feature);
  }

  function renderResults(dataset, candidates, activeUuid) {
    els.resultCount.textContent = String(candidates.length);
    els.resultsList.innerHTML = "";
    if (!candidates.length) {
      els.resultsList.innerHTML = '<p class="empty-results">No plots matched this view.</p>';
      return;
    }
    candidates.forEach((feature, index) => {
      const p = feature.properties;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result-item";
      if (p.UUID === activeUuid) button.setAttribute("aria-current", "true");
      const basis = matchBasis(feature);
      const displayName = plotDisplayName(feature);
      button.setAttribute("aria-label", `${displayName}, ${formatArea(p["KG site area m²"])}, matched by ${basis}`);
      button.innerHTML = `
        <span class="result-rank">${String(index + 1).padStart(2, "0")}</span>
        <span class="result-copy"><strong>${escapeHtml(displayName)}</strong><small>${escapeHtml(formatArea(p["KG site area m²"]))}</small></span>
        <span class="match-basis">${escapeHtml(basis)}</span>`;
      button.addEventListener("click", () => selectFeature(feature, true));
      els.resultsList.appendChild(button);
    });
  }

  function revealSimilar() {
    const reference = state.selectedFeature;
    if (!reference || reference.properties.Role !== "Reference" || !state.selectedFilterLevel) return false;
    const dataset = state.datasets[reference.properties.__site];
    const candidates = getCandidatesForLevel(dataset);
    const filter = getFilterDefinition(state.selectedFilterLevel);
    state.activeSimilaritySite = dataset.id;
    state.activeCandidates = candidates;
    setCandidateVisibility(dataset.id, candidates);
    const start = getCenter(reference);
    const lines = candidates.map((candidate, index) => ({
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
    renderResults(dataset, candidates);
    updateRetrievalControls(dataset);
    showOverview();
    setStatus(candidates.length
      ? `${candidates.length} plots shown · ${filter.label}`
      : `No plots match ${filter.label}`);
    return true;
  }

  async function activateFilterMode(level) {
    const selected = state.selectedFeature;
    if (!selected) return;
    const dataset = state.datasets[selected.properties.__site];
    const reference = dataset && dataset.reference;
    if (!reference) return;
    if (selected !== reference) selectFeature(reference, false);
    const filter = getFilterDefinition(level);
    const requestId = state.retrievalRequestId + 1;
    state.retrievalRequestId = requestId;
    setFilterLevel(filter.id);
    setSimilarityLoading(true, filter);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (requestId !== state.retrievalRequestId || state.selectedFeature !== reference) return;
    try {
      revealSimilar();
    } catch (error) {
      console.error(error);
      setStatus("Similar plots could not be updated", true);
    } finally {
      if (requestId === state.retrievalRequestId) setSimilarityLoading(false);
    }
  }

  function showOverview() {
    if (!state.map) return;
    clearNeighbourContext({ removePopup: false });
    const mobile = window.innerWidth <= 700;
    state.map.fitBounds(SINGAPORE_BOUNDS, {
      padding: mobile ? { top: 88, right: 28, bottom: Math.round(window.innerHeight * 0.47) + 25, left: 28 } : { top: 105, right: 70, bottom: 58, left: 390 },
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
        clearSimilar({ resetMode: true });
        const dataset = state.datasets[button.dataset.site];
        if (dataset && dataset.reference) selectFeature(dataset.reference, true);
      });
    });
    els.filterModeButtons.forEach((button) => {
      button.addEventListener("click", () => { void activateFilterMode(button.dataset.filterMode); });
    });
    els.filterInfoButtons.forEach((button) => {
      button.addEventListener("click", () => toggleFilterExplanation(button.dataset.filterInfo));
    });
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
        description: "Select Site 1 or Site 2 on the visible Singapore map and optionally show the similar plots returned by one comparison mode.",
        inputSchema: {
          type: "object",
          properties: {
            site: { type: "string", enum: ["site1", "site2"], description: "Reference site to explore." },
            filterCombination: { type: "string", enum: ["1+2", "1+2+3", "1+2+3+4"], description: "Comparison mode used to show similar plots." },
            revealSimilar: { type: "boolean", description: "Whether to return to the overview and draw animated links to matching candidates." }
          },
          required: ["site"],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          if (!input || !["site1", "site2"].includes(input.site) ||
              ("filterCombination" in input && !FILTER_LEVELS.some((filter) => filter.id === input.filterCombination)) ||
              ("revealSimilar" in input && typeof input.revealSimilar !== "boolean")) {
            throw new TypeError("site and filterCombination must use supported values, and revealSimilar must be a boolean when provided.");
          }
          const dataset = state.datasets[input.site];
          if (!dataset || !dataset.reference) throw new Error("The requested reference site is not available.");
          clearSimilar();
          setFilterLevel(input.filterCombination || DEFAULT_FILTER_LEVEL);
          selectFeature(dataset.reference, input.revealSimilar === false);
          if (input.revealSimilar !== false) revealSimilar();
          await waitForMapMove();
          const candidates = getCandidatesForLevel(dataset);
          return {
            selectedSite: dataset.label,
            filterCombination: state.selectedFilterLevel,
            similarPlotsShown: input.revealSimilar === false ? 0 : candidates.length,
            view: input.revealSimilar === false ? "site-detail" : "singapore-overview"
          };
        }
      }, { signal: state.webMcpLifecycle.signal })).catch((error) => console.warn("WebMCP tool registration failed", error));
    } catch (error) {
      console.warn("WebMCP tool registration failed", error);
    }
  }

  function waitForMapLoad(map) {
    return new Promise((resolve, reject) => {
      let firstResourceError = null;
      const onError = (event) => {
        if (!firstResourceError) firstResourceError = event.error || new Error("Map resource failed");
      };
      const timeout = window.setTimeout(() => {
        map.off("error", onError);
        reject(firstResourceError || new Error("Map style timed out"));
      }, 20000);
      map.on("error", onError);
      map.once("load", () => {
        window.clearTimeout(timeout);
        map.off("error", onError);
        resolve();
      });
    });
  }
  async function initialise() {
    wireInformationPanel();
    if (!hasValidToken()) {
      els.tokenNotice.classList.remove("hidden");
      setStatus("Mapbox token required", true);
      return;
    }
    if (!window.mapboxgl) {
      setStatus("The map library could not be loaded", true);
      return;
    }
    if (!mapboxgl.supported()) {
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
      language: "en",

      config: { basemap: { theme: "monochrome", lightPreset: "day", show3dObjects: false, showPointOfInterestLabels: false, showTransitLabels: false } }
    });
    if (new URLSearchParams(window.location.search).has("qa")) window.__qaMap = state.map;
    state.map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "bottom-right");
    state.map.addControl(new mapboxgl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-right");
    const scaleLabel = state.map.getContainer().querySelector(".mapboxgl-ctrl-scale");
    if (scaleLabel) {
      const expandScaleUnit = () => {
        const match = scaleLabel.textContent.trim().match(/^([\d.,]+)\s*(km|m)$/i);
        if (!match) return;
        scaleLabel.textContent = `${match[1]} ${match[2].toLowerCase() === "km" ? "kilometers" : "meters"}`;
      };
      new MutationObserver(expandScaleUnit).observe(scaleLabel, { childList: true, characterData: true, subtree: true });
      expandScaleUnit();
    }

    try {
      setStatus("Loading map and plot data", false, true);
      const [allPlots] = await Promise.all([loadDatasets(), waitForMapLoad(state.map)]);
      addMapContent(allPlots);
      wireControls();
      registerWebMcpTool();
      state.mapReady = true;
      Object.values(state.datasets).forEach((dataset) => {
        const zone = dataset.reference ? normalizeZone(dataset.reference.properties.Zone) : "No reference";
        const target = dataset.id === "site1" ? els.site1Zone : els.site2Zone;
        target.textContent = zone;
      });
      showOverview();
    } catch (error) {
      console.error(error);
      const dataProblem = error && (error.name === "AbortError" || /GeoJSON|data\//i.test(error.message || ""));
      setStatus(dataProblem ? "Plot data could not be loaded" : "The base map could not be loaded", true);
    }
  }

  initialise();
})();
