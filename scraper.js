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
  headers: { 'User-Agent': 'WetFloorWatch-LiveEngine/1.0' },
  timeout: 10000
});

// Strict exact-coordinate mapping. 
const EXACT_STREET_WHITELIST = [
  { names: ['oriole crescent', 'oriole'], name: "Oriole Crescent Sector", lat: 43.2350, lng: -79.8400 },
  { names: ['york blvd & bay', 'york & bay', 'bay st n'], name: "York Blvd & Bay St", lat: 43.2615, lng: -79.8735 },
  { names: ['barton & james', 'james st n'], name: "Barton St & James St", lat: 43.2618, lng: -79.8660 },
  { names: ['macnab', 'jackson square', 'gore park'], name: "Downtown Core", lat: 43.2557, lng: -79.8711 },
  { names: ['main st w', 'frid st'], name: "Main St W Corridor", lat: 43.2500, lng: -79.8500 },
  { names: ['beasley park', 'mary st'], name: "Beasley Park Zone", lat: 43.2575, lng: -79.8580 },
  { names: ['east 14th', 'east mountain'], name: "East Mountain Sector", lat: 43.2300, lng: -79.8600 }
];

const FEEDS = [
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+when:1d&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", platform: "police", sourceName: "Official Police Dispatch" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+news+(shooting+OR+stabbing+OR+assault+OR+drug+OR+crime)+when:1d&hl=en-CA&gl=CA&ceid=CA:en", type: "advisory", platform: "news", sourceName: "Local News Network" },
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=needle+OR+drug+OR+tent+OR+encampment+OR+police+OR+incident&restrict_sr=on&sort=new&t=week", type: "street", platform: "reddit", sourceName: "r/Hamilton Community" }
];

// Scrub exact house numbers (e.g., "123 Main St" -> "[REDACTED] Main St")
function scrubPII(text) {
  return text.replace(/\b\d{1,4}\s+([A-Z][a-z]+\s+(St|Street|Ave|Avenue|Blvd|Road|Rd|Crescent|Crt))\b/gi, "[BLOCK] $1");
}

async function verifyAndExtract(item, feedType, platform, sourceName) {
  const leadText = ((item.title || "") + " " + (item.contentSnippet || "")).toLowerCase();
  
  if (!leadText.includes('hamilton')) return null;

  let matchedCorridor = null;
  for (const loc of EXACT_STREET_WHITELIST) {
    if (loc.names.some(k => new RegExp('\\b' + k + '\\b', 'i').test(leadText))) {
      matchedCorridor = loc;
      break;
    }
  }

  // STRICT REQUIREMENT: If no exact coordinate match is found, discard the report to prevent drifted/fake pins.
  if (!matchedCorridor) return null;

  const cleanDescription = scrubPII(
    (item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").replace(/\s+/g, " ").trim()
  ).substring(0, 220) + '...';

  let articleDate = item.pubDate ? new Date(item.pubDate) : new Date();
  
  return {
    category: feedType,
    platform: platform,
    hasPin: true,
    lat: matchedCorridor.lat,
    lng: matchedCorridor.lng,
    source: `${sourceName} • ${matchedCorridor.name}`,
    description: cleanDescription,
    url: item.link || item.guid || '',
    timestamp: Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Running Strict Geocoded Ingestion...");
  let count = 0;
  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 30)) {
        const intel = await verifyAndExtract(item, feed.type, feed.platform, feed.sourceName);
        if (!intel) continue; // Discarded due to lack of precise coordinates

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
  console.log(`Ingestion Complete. Synchronized ${count} precise live records.`);
  process.exit(0);
}
run();
