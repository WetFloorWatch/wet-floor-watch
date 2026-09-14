const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const Parser = require("rss-parser");
const crypto = require("crypto");
const Groq = require("groq-sdk");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("FATAL: Missing FIREBASE_SERVICE_ACCOUNT");
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) {
  console.error("FATAL: Missing GROQ_API_KEY");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const parser = new Parser({
  headers: { 'User-Agent': 'WetFloorWatch-AIEngine/4.0' },
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
  }
];

const FEEDS = [
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+when:7d&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", platform: "police", sourceName: "Official Police Dispatch" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+news+(shooting+OR+stabbing+OR+assault+OR+drug+OR+crime)+when:7d&hl=en-CA&gl=CA&ceid=CA:en", type: "advisory", platform: "news", sourceName: "Local News Network" },
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=needle+OR+drug+OR+tent+OR+encampment+OR+police+OR+incident&restrict_sr=on&sort=new&t=month", type: "street", platform: "reddit", sourceName: "r/Hamilton Community" },
  { url: "https://rss.app/feeds/J229itoFzyOpFVv2.xml", type: "street", platform: "intervention", sourceName: "@interventionintersection2026" }
];

async function analyzeWithGroq(text) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are a public safety intelligence AI for Hamilton, Ontario. Extract data from the report into strict JSON. Keys: 'isHamilton' (boolean), 'intersection' (string, best estimate of street intersection or neighborhood, null if unknown), 'summary' (string, max 200 chars, rewrite the text to remove specific house numbers and victim names for privacy)."
        },
        { role: "user", content: text }
      ],
      model: "llama3-8b-8192", 
      temperature: 0.1,
      response_format: { type: "json_object" }
    });
    return JSON.parse(chatCompletion.choices[0].message.content);
  } catch (err) {
    console.error("Groq Analysis Failed:", err.message);
    return null;
  }
}

async function geocode(locationStr) {
  if (!locationStr) return null;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationStr)}+Hamilton,+Ontario&format=json&limit=1`, {
      headers: { 'User-Agent': 'WetFloorWatch-DataBot/2.0' }
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
  const fullText = ((item.title || "") + " " + (item.contentSnippet || ""));
  
  if (sourceName === "@interventionintersection2026" || item.link?.includes("interventionintersection")) {
      platform = "intervention"; 
  }

  // 1. Pass the messy text to Groq for strict data extraction
  const aiAnalysis = await analyzeWithGroq(fullText);
  if (!aiAnalysis || (!aiAnalysis.isHamilton && platform !== "intervention")) return null;

  // 2. Geocode the AI-extracted location
  let pinData = null;
  if (aiAnalysis.intersection) {
    pinData = await geocode(aiAnalysis.intersection);
    await sleep(1100); 
  }

  const hasPin = pinData !== null;
  const finalLocName = hasPin ? pinData.name : "Hamilton Sector (Location Approx)";
  const exactUrl = item.link || item.guid || '';

  return {
    category: feedType,
    platform: platform,
    hasPin: hasPin,
    lat: hasPin ? pinData.lat : null,
    lng: hasPin ? pinData.lng : null,
    source: `${sourceName} • ${finalLocName}`,
    description: aiAnalysis.summary, // Utilizing the AI-scrubbed summary
    url: exactUrl,
    timestamp: Timestamp.fromDate(item.pubDate ? new Date(item.pubDate) : new Date())
  };
}

async function run() {
  console.log("Seeding verified historical records...");
  for (const seed of HISTORICAL_SEEDS) {
    await db.collection("reports").doc(seed.id).set({
      ...seed, createdAt: FieldValue.serverTimestamp(), active: true
    }, { merge: true });
  }

  console.log("Running Live AI Ingestion & Geocoding Engine...");
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
  console.log(`Ingestion Complete. Synchronized ${count} AI-verified records.`);
  process.exit(0);
}
run();
