import fs from "node:fs/promises";
import path from "node:path";

const DATASETS = [
  {
    input: "SITE1_similar_plot_nonroad_neighbours.geojson",
    output: "dist/data/SITE1_similar_plot_nonroad_neighbours.geojson"
  },
  {
    input: "SITE2_similar_plot_nonroad_neighbours.geojson",
    output: "dist/data/SITE2_similar_plot_nonroad_neighbours.geojson"
  }
];

function roundCoordinates(value) {
  if (!Array.isArray(value)) return value;
  if (typeof value[0] === "number") return value.map((coordinate) => Number(coordinate.toFixed(6)));
  return value.map(roundCoordinates);
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
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
      regulation_types: unique(Array.isArray(source.regulation_types) ? source.regulation_types : [])
    }
  };
}

async function main() {
  for (const dataset of DATASETS) {
    const inputPath = path.resolve(dataset.input);
    const outputPath = path.resolve(dataset.output);
    const collection = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const compact = {
      type: "FeatureCollection",
      name: collection.name,
      metadata: collection.metadata,
      features: collection.features.map(compactFeature)
    };
    await fs.writeFile(outputPath, `${JSON.stringify(compact)}\n`, "utf8");
    const inputSize = (await fs.stat(inputPath)).size;
    const outputSize = (await fs.stat(outputPath)).size;
    console.log(JSON.stringify({
      output: dataset.output,
      features: compact.features.length,
      inputMB: Number((inputSize / 1024 / 1024).toFixed(2)),
      outputMB: Number((outputSize / 1024 / 1024).toFixed(2))
    }));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
