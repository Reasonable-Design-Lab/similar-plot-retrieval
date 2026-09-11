import fs from "node:fs/promises";
import path from "node:path";

const DATASETS = [
  { id: "site1", label: "Site 1", file: "dist/data/SITE1-like_similar_plots_v2.geojson" },
  { id: "site2", label: "Site 2", file: "dist/data/SITE2-like_similar_plots_v2.geojson" }
];

function ringAreaAndCentroid(ring) {
  let twiceArea = 0;
  let xTotal = 0;
  let yTotal = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    xTotal += (x1 + x2) * cross;
    yTotal += (y1 + y2) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) {
    const points = ring.slice(0, -1);
    return {
      area: 0,
      center: points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0])
    };
  }
  return {
    area: Math.abs(twiceArea / 2),
    center: [xTotal / (3 * twiceArea), yTotal / (3 * twiceArea)]
  };
}

function featureCenter(feature) {
  const geometry = feature.geometry;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const largest = polygons
    .map((polygon) => ringAreaAndCentroid(polygon[0]))
    .sort((a, b) => b.area - a.area)[0];
  return largest.center;
}

function readToken(configText) {
  const match = configText.match(/accessToken\s*:\s*["']([^"']+)["']/);
  if (!match || !match[1].startsWith("pk.")) throw new Error("A valid public Mapbox token was not found in dist/config.js");
  return match[1];
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function addressFromResponse(collection, fallback) {
  const features = Array.isArray(collection?.features) ? collection.features : [];
  const address = features.find((feature) => feature.properties?.feature_type === "address");
  const street = features.find((feature) => feature.properties?.feature_type === "street");

  if (address) {
    const properties = address.properties || {};
    const short = clean(properties.context?.address?.name) || clean(properties.name);
    const full = clean(properties.full_address) || [clean(properties.name), clean(properties.place_formatted)].filter(Boolean).join(", ");
    if (short) return { short, full: full || short, type: "address" };
  }

  const streetName = clean(street?.properties?.name) || clean(features[0]?.properties?.context?.street?.name);
  if (streetName) return { short: `Near ${streetName}`, full: `${streetName}, Singapore`, type: "street" };

  const context = features[0]?.properties?.context || {};
  const area = clean(context.neighborhood?.name) || clean(context.locality?.name) || clean(context.district?.name);
  if (area && area.toLowerCase() !== "singapore") return { short: area, full: `${area}, Singapore`, type: "area" };

  return { short: fallback, full: "Address not available", type: "fallback" };
}

function deduplicateNames(records) {
  const groups = new Map();
  records.forEach((record) => {
    const key = `${record.siteId}::${record.address.short.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  groups.forEach((group) => {
    if (group.length < 2) return;
    group.sort((a, b) => a.uuid.localeCompare(b.uuid));
    group.forEach((record, index) => {
      record.address.short = `${record.address.short} · ${String(index + 1).padStart(2, "0")}`;
    });
  });
}

async function main() {
  const projectRoot = process.cwd();
  const configText = await fs.readFile(path.join(projectRoot, "dist/config.js"), "utf8");
  const token = readToken(configText);
  const loaded = [];
  const records = [];

  for (const dataset of DATASETS) {
    const filePath = path.join(projectRoot, dataset.file);
    const geojson = JSON.parse(await fs.readFile(filePath, "utf8"));
    loaded.push({ ...dataset, filePath, geojson });
    const byUuid = new Map();
    geojson.features
      .filter((feature) => feature.properties?.Role === "Candidate")
      .forEach((feature) => {
        const uuid = feature.properties.UUID;
        if (!byUuid.has(uuid)) byUuid.set(uuid, feature);
      });
    [...byUuid.entries()].forEach(([uuid, feature], index) => {
      records.push({
        siteId: dataset.id,
        siteLabel: dataset.label,
        uuid,
        feature,
        fallback: `${dataset.label} Plot ${String(index + 1).padStart(2, "0")}`
      });
    });
  }

  const requests = records.map((record) => {
    const [longitude, latitude] = featureCenter(record.feature);
    return {
      longitude,
      latitude,
      country: "sg",
      language: "en",
      types: ["address", "street", "neighborhood", "locality", "district", "place"]
    };
  });

  const response = await fetch(`https://api.mapbox.com/search/geocode/v6/batch?permanent=true&access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requests)
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Mapbox batch geocoding failed (${response.status}): ${message.slice(0, 300)}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.batch) || payload.batch.length !== records.length) {
    throw new Error("Mapbox returned an unexpected batch response");
  }

  records.forEach((record, index) => {
    record.address = addressFromResponse(payload.batch[index], record.fallback);
  });
  deduplicateNames(records);
  const addressByKey = new Map(records.map((record) => [`${record.siteId}::${record.uuid}`, record.address]));

  for (const dataset of loaded) {
    dataset.geojson.features.forEach((feature) => {
      if (feature.properties?.Role !== "Candidate") return;
      const address = addressByKey.get(`${dataset.id}::${feature.properties.UUID}`);
      feature.properties["Short address"] = address.short;
      feature.properties["Full address"] = address.full;
      feature.properties["Address feature type"] = address.type;
      feature.properties["Address source"] = "Mapbox Geocoding v6";
    });
    await fs.writeFile(dataset.filePath, `${JSON.stringify(dataset.geojson, null, 2)}\n`, "utf8");
  }

  const counts = records.reduce((summary, record) => {
    summary[record.address.type] = (summary[record.address.type] || 0) + 1;
    return summary;
  }, {});
  console.log(JSON.stringify({ enriched: records.length, counts, samples: records.slice(0, 8).map((record) => record.address.short) }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
