import fs from "node:fs/promises";
import path from "node:path";

const DATASETS = [
  {
    input: "SITE1_similar_plot_nonroad_neighbours_v2.geojson",
    output: "dist/data/SITE1_similar_plot_nonroad_neighbours.geojson",
    similarPlots: "dist/data/SITE1-like_similar_plots_v2.geojson"
  },
  {
    input: "SITE2_similar_plot_nonroad_neighbours_v2.geojson",
    output: "dist/data/SITE2_similar_plot_nonroad_neighbours.geojson",
    similarPlots: "dist/data/SITE2-like_similar_plots_v2.geojson"
  }
];

const FILTER_STAGES = ["Filter 1+2", "Filter 1+2+3", "Filter 1+2+3+4"];

function roundCoordinates(value) {
  if (!Array.isArray(value)) return value;
  if (typeof value[0] === "number") return value.map((coordinate) => Number(coordinate.toFixed(6)));
  return value.map(roundCoordinates);
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function compactUriId(value) {
  const text = String(value || "");
  return text.split("/").filter(Boolean).pop() || null;
}

function schemeControls(regulations, zoningCase) {
  const matching = regulations.filter((regulation) => {
    const programmes = Array.isArray(regulation.programmes) ? regulation.programmes : [];
    return zoningCase ? programmes.includes(zoningCase) : programmes.length === 0;
  });
  return {
    gpr_values: unique(matching.flatMap((regulation) => Array.isArray(regulation.gpr_values) ? regulation.gpr_values : [])).sort((a, b) => a - b),
    storeys: unique(matching.flatMap((regulation) => Array.isArray(regulation.storeys) ? regulation.storeys : [])).sort((a, b) => a - b),
    setbacks_m: unique(matching.flatMap((regulation) => Array.isArray(regulation.setbacks_m) ? regulation.setbacks_m : [])).sort((a, b) => a - b)
  };
}

function compactGfaSchemes(source, regulations) {
  const records = Array.isArray(source.allowable_gfa_records) ? source.allowable_gfa_records : [];
  return records
    .filter((record) => Number.isFinite(Number(record.allowable_gfa_m2)))
    .map((record, index) => ({
      label: record.zoning_case || (records.length > 1 ? `General scheme ${index + 1}` : "General scheme"),
      allowable_gfa_m2: Number(record.allowable_gfa_m2),
      diff_from_reference_pct: record.diff_from_reference_pct === null || record.diff_from_reference_pct === undefined || !Number.isFinite(Number(record.diff_from_reference_pct)) ? null : Number(record.diff_from_reference_pct),
      buildable_space_id: compactUriId(record.buildable_space),
      ...schemeControls(regulations, record.zoning_case)
    }));
}

async function syncSimilarPlotFilters(collection, similarPlotsPath) {
  const sourceStages = new Map();
  collection.features.forEach((feature) => {
    (feature.properties?.source_relationships || []).forEach((relationship) => {
      if (relationship.source_role !== "Candidate") return;
      const uuid = relationship.source_similar_plot_uuid;
      const stages = sourceStages.get(uuid) || new Set();
      (relationship.source_filter_stages || []).forEach((stage) => stages.add(stage));
      sourceStages.set(uuid, stages);
    });
  });

  const similarPlots = JSON.parse(await fs.readFile(similarPlotsPath, "utf8"));
  const reference = similarPlots.features.find((feature) => feature.properties?.Role === "Reference");
  if (!reference) throw new Error(`${similarPlotsPath} does not contain a reference feature`);
  const candidates = new Map();
  similarPlots.features.forEach((feature) => {
    if (feature.properties?.Role !== "Candidate") return;
    const uuid = feature.properties.UUID;
    if (!candidates.has(uuid)) candidates.set(uuid, feature);
  });
  const missing = [...sourceStages.keys()].filter((uuid) => !candidates.has(uuid));
  if (missing.length) throw new Error(`${similarPlotsPath} is missing ${missing.length} candidate UUIDs from the neighbour data`);

  const expectedPairs = new Set();
  FILTER_STAGES.forEach((stage) => {
    sourceStages.forEach((stages, uuid) => {
      if (stages.has(stage)) expectedPairs.add(`${uuid}::${stage}`);
    });
  });
  const emittedPairs = new Set();
  const nextFeatures = [];
  similarPlots.features.forEach((feature) => {
    if (feature.properties?.Role === "Reference") {
      if (!nextFeatures.some((item) => item.properties?.Role === "Reference")) nextFeatures.push(feature);
      return;
    }
    if (feature.properties?.Role !== "Candidate") return;
    const pair = `${feature.properties.UUID}::${feature.properties["Filter stage"]}`;
    if (!expectedPairs.has(pair) || emittedPairs.has(pair)) return;
    emittedPairs.add(pair);
    nextFeatures.push(feature);
  });
  FILTER_STAGES.forEach((stage) => {
    sourceStages.forEach((stages, uuid) => {
      const pair = `${uuid}::${stage}`;
      if (!stages.has(stage) || emittedPairs.has(pair)) return;
      const clone = structuredClone(candidates.get(uuid));
      clone.properties["Filter stage"] = stage;
      emittedPairs.add(pair);
      nextFeatures.push(clone);
    });
  });
  similarPlots.features = nextFeatures;
  await fs.writeFile(similarPlotsPath, `${JSON.stringify(similarPlots, null, 2)}\n`, "utf8");
  return Object.fromEntries(FILTER_STAGES.map((stage) => [
    stage,
    [...sourceStages.values()].filter((stages) => stages.has(stage)).length
  ]));
}

function compactFeature(feature) {
  const source = feature.properties || {};
  const regulations = Array.isArray(source.regulations) ? source.regulations : [];
  const relationships = (Array.isArray(source.source_relationships) ? source.source_relationships : []).map((relationship) => ({
    uuid: relationship.source_similar_plot_uuid,
    routes: unique(Array.isArray(relationship.neighbour_route) ? relationship.neighbour_route : [])
  }));
  const programmes = unique(regulations.flatMap((regulation) => Array.isArray(regulation.programmes) ? regulation.programmes : []));
  const storeys = unique(regulations.flatMap((regulation) => Array.isArray(regulation.storeys) ? regulation.storeys : [])).sort((a, b) => a - b);
  const setbacks = unique(regulations.flatMap((regulation) => Array.isArray(regulation.setbacks_m) ? regulation.setbacks_m : [])).sort((a, b) => a - b);
  const zone = Array.isArray(source.zone) ? source.zone[0] : source.zone;

  return {
    type: "Feature",
    id: source.neighbour_uuid,
    geometry: {
      ...feature.geometry,
      coordinates: roundCoordinates(feature.geometry.coordinates)
    },
    properties: {
      neighbour_uuid: source.neighbour_uuid,
      sources: relationships,
      zone: zone || "Not specified",
      site_area_m2: source.kg_site_area_m2 ?? source.polygon_area_m2 ?? null,
      allowable_gfa_min_m2: source.minimum_allowable_gfa_m2 ?? null,
      allowable_gfa_max_m2: source.maximum_allowable_gfa_m2 ?? null,
      master_plan_gpr: source.master_plan_gpr ?? null,
      width_m: source.width_m ?? null,
      aspect_ratio: source.aspect_ratio ?? null,
      rectangularity: source.rectangularity ?? null,
      programmes,
      storeys,
      setbacks_m: setbacks,
      gfa_schemes: compactGfaSchemes(source, regulations),
      regulation_types: unique(Array.isArray(source.regulation_types) ? source.regulation_types : [])
    }
  };
}

async function main() {
  for (const dataset of DATASETS) {
    const inputPath = path.resolve(dataset.input);
    const outputPath = path.resolve(dataset.output);
    const similarPlotsPath = path.resolve(dataset.similarPlots);
    const collection = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const filterCounts = await syncSimilarPlotFilters(collection, similarPlotsPath);
    const compact = {
      type: "FeatureCollection",
      name: collection.name,
      metadata: {
        ...collection.metadata,
        filter_candidate_counts: filterCounts
      },
      features: collection.features.map(compactFeature)
    };
    await fs.writeFile(outputPath, `${JSON.stringify(compact)}\n`, "utf8");
    const inputSize = (await fs.stat(inputPath)).size;
    const outputSize = (await fs.stat(outputPath)).size;
    console.log(JSON.stringify({
      output: dataset.output,
      features: compact.features.length,
      filterCounts,
      inputMB: Number((inputSize / 1024 / 1024).toFixed(2)),
      outputMB: Number((outputSize / 1024 / 1024).toFixed(2))
    }));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
