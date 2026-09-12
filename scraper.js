const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const Parser = require("rss-parser");
const crypto = require("crypto");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("FATAL: Missing FIREBASE_SERVICE_ACCOUNT");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const parser = new Parser({
  headers: { 'User-Agent': 'WetFloorWatch-LiveEngine/2.1' },
  timeout: 10000
});

const VERIFIED_INCIDENT_SEEDS = [
  {
    id: "seed-2026-stoney-creek",
    category: "emergency",
    platform: "police",
    hasPin: true,
    lat: 43.2144,
    lng: -79.7135,
    source: "Official Police Dispatch • Stoney Creek Sector",
    description: "Hamilton Police investigated a deadly double shooting linked to an earlier dispute in a residential townhouse complex.",
    url: "https://www.cp24.com/local/hamilton/2026/07/29/shooting-in-stoney-creek-leaves-2-dead-hamilton-police/",
    timestamp: Timestamp.fromDate(new Date("2026-07-29T03:30:00"))
  },
  {
    id: "seed-2026-wellington-rebecca",
    category: "hazard",
    platform: "news",
    hasPin: true,
    lat: 43.2542,
    lng: -79.8521,
    source: "Local News Network • Wellington & Rebecca",
    description: "Community reports and public health sweeps logging discarded paraphernalia near the core intersection.",
    url: "https://www.cbc.ca/news/canada/hamilton",
    timestamp: Timestamp.fromDate(new Date("2026-09-08T10:00:00"))
  }
];

const FEEDS = [
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+when:7d&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", platform: "police", sourceName: "Official Police Dispatch" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+news+(shooting+OR+stabbing+OR+assault+OR+drug+OR+crime)+when:7d&hl=en-CA&gl=CA&ceid=CA:en", type: "advisory", platform: "news", sourceName: "Local News Network" },
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=needle+OR+drug+OR+tent+OR+encampment+OR+police+OR+incident&restrict_sr=on&sort=new&t=month", type: "street", platform: "reddit", sourceName: "r/Hamilton Community" },
  { url: "https://rss.app/feeds/J229itoFzyOpFVv2.xml", type: "street", platform: "instagram", sourceName: "@interventionintersection2026" }
];

const EXACT_STREET_WHITELIST = [
  { names: ['wellington', 'rebecca'], name: "Wellington St & Rebecca St", lat: 43.2542, lng: -79.8521 },
  { names: ['oriole crescent', 'oriole'], name: "Oriole Crescent Sector", lat: 43.2350, lng: -79.8400 },
  { names: ['york blvd', 'bay st', 'bay & york'], name: "York Blvd & Bay St", lat: 43.2615, lng: -79.8735 },
  { names: ['barton', 'james st n', 'james north'], name: "Barton St & James St", lat: 43.2618, lng: -79.8660 },
  { names: ['macnab', 'jackson square', 'gore park'], name: "Downtown Core", lat: 43.2557, lng: -79.8711 },
  { names: ['main st', 'frid st'], name: "Main St Corridor", lat: 43.2500, lng: -79.8500 },
  { names: ['beasley park', 'mary st'], name: "Beasley Park Zone", lat: 43.2575, lng: -79.8580 },
  { names: ['east 14th', 'east mountain'], name: "East Mountain Sector", lat: 43.2300, lng: -79.8600 }
];

function scrubPII(text) {
  return text.replace(/\b\d{1,4}\s+([A-Z][a-z]+\s+(St|Street|Ave|Avenue|Blvd|Road|Rd|Crescent|Crt))\b/gi, "[BLOCK] $1");
}

async function verifyAndExtract(item, feedType, platform, sourceName) {
  const leadText = ((item.title || "") + " " + (item.contentSnippet || "")).toLowerCase();
  
  if (!leadText.includes('hamilton') && sourceName !== "@interventionintersection2026") return null;

  let matchedCorridor = null;
  for (const loc of EXACT_STREET_WHITELIST) {
    if (loc.names.some(k => leadText.includes(k))) {
      matchedCorridor = loc;
      break;
    }
  }

  const hasPin = matchedCorridor !== null;
  const pinData = matchedCorridor || { name: "Hamilton General Sector", lat: null, lng: null };

  const cleanDescription = scrubPII(
    (item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").replace(/\s+/g, " ").trim()
  ).substring(0, 220) + '...';

  let articleDate = item.pubDate ? new Date(item.pubDate) : new Date();
  
  return {
    category: feedType,
    platform: platform,
    hasPin: hasPin,
    lat: pinData.lat,
    lng: pinData.lng,
    source: `${sourceName} • ${pinData.name}`,
    description: cleanDescription,
    url: item.link || item.guid || '',
    timestamp: Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Seeding baseline records...");
  for (const seed of VERIFIED_INCIDENT_SEEDS) {
    await db.collection("reports").doc(seed.id).set({
      ...seed, createdAt: FieldValue.serverTimestamp(), active: true
    }, { merge: true });
  }

  console.log("Running Ingestion Engine...");
  let count = 0;
  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 40)) {
        const intel = await verifyAndExtract(item, feed.type, feed.platform, feed.sourceName);
        if (!intel) continue;

        const docId = crypto.createHash('md5').update(intel.url + intel.source).digest('hex');
        await db.collection("reports").doc(docId).set({
          ...intel, createdAt: FieldValue.serverTimestamp(), active: true
        }, { merge: true });
        count++;
      }
    } catch (e) {
      console.error(`Feed Error (${feed.sourceName}):`, e.message);
    }
  }
  console.log(`Ingestion Complete. Synchronized ${count} records.`);
  process.exit(0);
}
run();
