import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const outputPath = resolve(process.argv[2] || "data/road-live.json");
const tripBounds = {
  south: 63.2,
  west: -24.7,
  north: 65.55,
  east: -14.25,
};

const sources = {
  weather: "https://gagnaveita.vegagerdin.is/api/vedur2014_1",
  cameras: "https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1",
  hazards: "https://gagnaveita.vegagerdin.is/api/faerdpunktar2017_1",
};

const overpassMirrors = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

function inTripBounds(item) {
  const lat = Number(item.Breidd ?? item.lat ?? item.center?.lat);
  const lon = Number(item.Lengd ?? item.lon ?? item.center?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= tripBounds.south && lat <= tripBounds.north &&
    lon >= tripBounds.west && lon <= tripBounds.east;
}

async function fetchJson(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "MSC-Iceland-Itinerary/1.0 (+https://github.com/Ahmaddbaig/MSC)",
          ...options.headers,
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((done) => setTimeout(done, attempt * 1_000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Unable to fetch ${url}: ${lastError?.message || lastError}`);
}

async function fetchSpeedCameras() {
  const query = `[out:json][timeout:60];
area["ISO3166-1"="IS"][admin_level=2]->.iceland;
(
  node["highway"="speed_camera"](area.iceland);
  nwr["enforcement"="maxspeed"](area.iceland);
);
out center tags;`;
  let lastError;
  for (const base of overpassMirrors) {
    const url = `${base}?data=${encodeURIComponent(query)}`;
    try {
      const result = await fetchJson(url);
      return result.elements || [];
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to fetch OpenStreetMap speed cameras: ${lastError?.message || lastError}`);
}

function cleanText(value) {
  return value == null ? null : String(value).replace(/\uFFFD/g, "").trim() || null;
}

const [weatherRaw, camerasRaw, hazardsRaw, speedRaw] = await Promise.all([
  fetchJson(sources.weather),
  fetchJson(sources.cameras),
  fetchJson(sources.hazards),
  fetchSpeedCameras(),
]);

const weatherStations = weatherRaw.filter(inTripBounds).map((item) => ({
  id: Number(item.Nr),
  name: cleanText(item.Nafn),
  lat: Number(item.Breidd),
  lon: Number(item.Lengd),
  observedAt: cleanText(item.Dags),
  airC: item.Hiti == null ? null : Number(item.Hiti),
  roadC: item.Veghiti == null ? null : Number(item.Veghiti),
  windMps: item.Vindhradi == null ? null : Number(item.Vindhradi),
  gustMps: item.Vindhvida == null ? null : Number(item.Vindhvida),
  windDirection: cleanText(item.VindattAscEng || item.VindattAsc),
  vehicles10Min: item.Umf10Min == null ? null : Number(item.Umf10Min),
  vehiclesToday: item.UmfSum == null ? null : Number(item.UmfSum),
}));

const cameraSites = new Map();
for (const item of camerasRaw.filter(inTripBounds)) {
  const lat = Number(item.Breidd);
  const lon = Number(item.Lengd);
  const name = cleanText(item.Myndavel);
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${name || "camera"}`;
  if (!cameraSites.has(key)) {
    cameraSites.set(key, {
      id: key,
      name,
      road: cleanText(item.NrVegur),
      roadName: cleanText(item.Vegheiti),
      lat,
      lon,
      images: [],
    });
  }
  const imageUrl = cleanText(item.Slod);
  if (imageUrl) {
    cameraSites.get(key).images.push({
      direction: cleanText(item.Skyring),
      imageUrl,
    });
  }
}
const roadCameras = [...cameraSites.values()];

const roadHazards = hazardsRaw.filter(inTripBounds).map((item) => ({
  id: Number(item.IdPunktur),
  type: cleanText(item.Astand),
  title: cleanText(item.LysingEn || item.Lysing),
  details: cleanText(item.AthsEn || item.Aths),
  reportedAt: cleanText(item.DagsSkrad),
  validUntil: cleanText(item.GildirTil),
  lat: Number(item.Breidd),
  lon: Number(item.Lengd),
}));

const seenSpeedCameras = new Set();
const speedCameras = speedRaw.filter(inTripBounds).map((item) => {
  const lat = Number(item.lat ?? item.center?.lat);
  const lon = Number(item.lon ?? item.center?.lon);
  const tags = item.tags || {};
  return {
    id: `${item.type}/${item.id}`,
    lat,
    lon,
    name: cleanText(tags.name),
    maxSpeed: cleanText(tags.maxspeed),
    direction: cleanText(tags.direction),
    reference: cleanText(tags.ref),
    source: "OpenStreetMap",
  };
}).filter((item) => {
  const key = `${item.lat.toFixed(5)},${item.lon.toFixed(5)}`;
  if (seenSpeedCameras.has(key)) return false;
  seenSpeedCameras.add(key);
  return true;
});

const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  refreshTargetMinutes: 10,
  tripBounds,
  weatherStations,
  roadCameras,
  roadHazards,
  speedCameras,
  attribution: {
    roadData: "Icelandic Road and Coastal Administration (Vegagerðin)",
    roadDataUrl: "https://umferdin.is/en",
    speedCameras: "OpenStreetMap contributors",
    speedCameraUrl: "https://www.openstreetmap.org/copyright",
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
console.log(`Weather/traffic stations: ${weatherStations.length}`);
console.log(`Road cameras: ${roadCameras.length}`);
console.log(`Road hazards: ${roadHazards.length}`);
console.log(`Speed cameras: ${speedCameras.length}`);
