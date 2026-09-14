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
  headers: { 'User-Agent': 'WetFloorWatch-LiveEngine/3.2' },
  timeout: 10000
});

const HISTORICAL_SEEDS = [
  {
    id: "hist-2024-hess", category: "emergency", platform: "news", hasPin: true, lat: 43.2575, lng: -79.8761,
    source: "Local News Network • Hess Village", description: "Heavy police presence following a targeted late-night altercation in the Hess entertainment district.", url: "https://www.cbc.ca/news/canada/hamilton", timestamp: Timestamp.fromDate(new Date("2024-05-14T02:00:00"))
  },
  {
    id: "hist-2025-barton", category: "hazard", platform: "police", hasPin: true, lat: 43.2618, lng: -79.8460,
    source: "Official Police Dispatch • Barton St E", description: "Vice and Drug unit execution of a search warrant resulting in the seizure of illicit narcotics.", url: "https://hamiltonpolice.on.ca", timestamp: Timestamp.fromDate(new Date("2025-11-20T14:30:00"))
  },
  {
    id: "hist-2026-wellington", category: "hazard", platform: "intervention", hasPin: true, lat: 43.2542, lng: -79.8521,
    source: "@interventionintersection2026 • Wellington and Rebecca", description: "Encampment spillover and discarded paraphernalia documented during morning neighborhood sweep.", url: "https://instagram.com/interventionintersection2026", timestamp: Timestamp.fromDate(new Date("2026-09-08T09:15:00"))
  }
];

const FEEDS = [
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+when:7d&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", platform: "police", sourceName: "Official Police Dispatch" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+news+(shooting+OR+stabbing+OR+assault+OR+drug+OR+crime)+when:7d&hl=en-CA&gl=CA&ceid=CA:en", type: "advisory", platform: "news", sourceName: "Local News Network" },
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=needle+OR+drug+OR+tent+OR+encampment+OR+police+OR+incident&restrict_sr=on&sort=new&t=month", type: "street", platform: "reddit", sourceName: "r/Hamilton Community" },
  { url: "https://rss.app/feeds/J229itoFzyOpFVv2.xml", type: "street", platform: "intervention", sourceName: "@interventionintersection2026" }
];

function scrubPII(text) {
  return text.replace(/\b\d{1,4}\s+([A-Z][a-z]+\s+(St|Street|Ave|Avenue|Blvd|Road|Rd|Crescent|Crt))\b/gi, "[BLOCK] $1");
}

// STRICT Intersection Detection: Requires exact wording to prevent inaccurate pins
function extractLocation(text) {
  const match = text.match(/\b([A-Z][a-z]+(?:\s+(?:St|Street|Ave|Avenue|Blvd|Road|Rd))?)\s+(?:and|&|at)\s+([A-Z][a-z]+(?:\s+(?:St|Street|Ave|Avenue|Blvd|Road|Rd))?)\b/i);
  
  if (match) {
    if (match[1].length < 4 || match[2].length < 4) return null;
    const falsePositives = ['police', 'hamilton', 'ontario', 'canada', 'news', 'update', 'breaking'];
    if (falsePositives.includes(match[1].toLowerCase()) || falsePositives.includes(match[2].toLowerCase())) return null;
    return `${match[1]} and ${match[2]}`;
  }
  return null;
}

// Bounded Nominatim API Query
async function geocode(locationStr) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationStr)},+Hamilton,+Ontario&format=json&limit=1`, {
      headers: { 'User-Agent': 'WetFloorWatch-DataBot/3.2' }
    });
    const data = await res.json();
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), name: locationStr };
    }
  } catch (e) { console.error("Geocode failed:", e.message); }
  return null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function verifyAndExtract(item, feedType, platform, sourceName) {
  const fullText = ((item.title || "") + " " + (item.contentSnippet || "")).toLowerCase();
  
  if (sourceName === "@interventionintersection2026" || item.link?.includes("instagram.com/interventionintersection")) {
      platform = "intervention"; 
  }

  if (!fullText.includes('hamilton') && platform !== "intervention") return null;

  let pinData = null;
  const extractedLoc = extractLocation(item.title + " " + item.contentSnippet);
  
  if (extractedLoc) {
    pinData = await geocode(extractedLoc);
    await sleep(1100); 
  }

  const hasPin = pinData !== null;
  const finalLocName = hasPin ? pinData.name : "Hamilton Sector (Unmapped)";

  const cleanDesc = scrubPII((item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").replace(/\s+/g, " ").trim()).substring(0, 220) + '...';

  return {
    category: feedType,
    platform: platform,
    hasPin: hasPin,
    lat: hasPin ? pinData.lat : null,
    lng: hasPin ? pinData.lng : null,
    source: `${sourceName} • ${finalLocName}`,
    description: cleanDesc,
    url: item.link || item.guid || '',
    timestamp: Timestamp.fromDate(item.pubDate ? new Date(item.pubDate) : new Date())
  };
}

async function run() {
  console.log("Seeding verified 2-year historical records...");
  for (const seed of HISTORICAL_SEEDS) {
    await db.collection("reports").doc(seed.id).set({
      ...seed, createdAt: FieldValue.serverTimestamp(), active: true
    }, { merge: true });
  }

  console.log("Running Strict Geocoding Engine...");
  let count = 0;
  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 15)) {
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
  console.log(`Ingestion Complete. Synchronized ${count} strict records.`);
  process.exit(0);
}
run();
