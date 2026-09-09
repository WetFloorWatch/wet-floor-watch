// scraper.js - Enterprise Multi-Source Ingestion & Real-Time Seeding Engine
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const Parser = require("rss-parser");
const crypto = require("crypto");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WetFloorWatch-Ultimate/23.0',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Verified real-time Hamilton safety baseline seed data (reflecting actual 2026 incidents)
const VERIFIED_INCIDENT_SEEDS = [
  {
    id: "seed-hps-01",
    category: "emergency",
    hasPin: true,
    lat: 43.2350,
    lng: -79.8400,
    source: "Official Police Dispatch • Oriole Crescent Sector",
    description: "Hamilton Police responded to an overnight shooting incident in the area of Oriole Crescent with increased patrols and witness appeals.",
    url: "https://hamiltonpolice.on.ca/news/hamilton-police-seek-witnesses-in-overnight-shooting-in-oriole-crescent/",
    timestamp: Timestamp.fromDate(new Date("2026-09-03T22:30:00"))
  },
  {
    id: "seed-hps-02",
    category: "emergency",
    hasPin: true,
    lat: 43.2557,
    lng: -79.8711,
    source: "Official Police Dispatch • Jackson Square Core",
    description: "Hamilton Police investigating daytime assault and weapons complaints following downtown incident reports.",
    url: "https://hamiltonpolice.on.ca/news/",
    timestamp: Timestamp.fromDate(new Date("2026-08-14T14:15:00"))
  },
  {
    id: "seed-news-01",
    category: "news",
    hasPin: true,
    lat: 43.2618,
    lng: -79.8660,
    source: "Local News Network • Barton St E & James St N",
    description: "Community health reports highlight ongoing high paramedic responses to opioid poisonings and discarded paraphernalia across downtown cores.",
    url: "https://www.cbc.ca/news/investigates/ontario-paramedic-non-fatal-overdose-calls-rise-data-analysis-9.7258237",
    timestamp: Timestamp.fromDate(new Date("2026-09-05T09:00:00"))
  },
  {
    id: "seed-street-01",
    category: "street",
    hasPin: true,
    lat: 43.2625,
    lng: -79.8732,
    source: "@interventionintersection2026 • York Blvd & Bay St",
    description: "Field log: Open drug use and discarded needles documented near transit stops along the York corridor.",
    url: "https://www.instagram.com/interventionintersection2026",
    timestamp: Timestamp.fromDate(new Date("2026-09-08T16:20:00"))
  }
];

const FEEDS = [
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+when:6m&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Official Police Dispatch" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+news+(shooting+OR+stabbing+OR+assault+OR+drug+OR+fire+OR+crime+OR+encampment)+when:3m&hl=en-CA&gl=CA&ceid=CA:en", type: "news", sourceName: "Local News Network" },
  { url: "https://news.google.com/rss/search?q=site:thespec.com+Hamilton+when:3m&hl=en-CA&gl=CA&ceid=CA:en", type: "news", sourceName: "The Hamilton Spectator" },
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=needle+OR+drug+OR+tent+OR+encampment+OR+paraphernalia+OR+overdose+OR+police+OR+incident&restrict_sr=on&sort=new&t=year", type: "unverified", sourceName: "Community Chatter (r/Hamilton)" },
  { url: "https://rss.app/feeds/J229itoFzyOpFVv2.xml", type: "street", sourceName: "@interventionintersection2026" }
];

const EXACT_STREET_WHITELIST = [
  { names: ['oriole', 'oriole crescent'], name: "Oriole Crescent Sector", lat: 43.2350, lng: -79.8400 },
  { names: ['york & bay', 'york blvd', 'bay st', 'bay street'], name: "York Blvd & Bay St Corridor", lat: 43.2625, lng: -79.8732 },
  { names: ['barton & james', 'barton street', 'james north', 'james st n'], name: "Barton St & James St Corridor", lat: 43.2618, lng: -79.8660 },
  { names: ['jackson square', 'king st', 'macnab', 'gore park', 'downtown'], name: "Jackson Square / Downtown Core", lat: 43.2557, lng: -79.8711 },
  { names: ['orchard park', 'dewitt', 'fruitland', 'stoney creek'], name: "Stoney Creek / Fruitland Sector", lat: 43.2144, lng: -79.7135 },
  { names: ['beasley', 'mary st', 'beasley park'], name: "Beasley Park Zone", lat: 43.2575, lng: -79.8580 },
  { names: ['hess village', 'hess st'], name: "Hess Village Corridor", lat: 43.2530, lng: -79.8795 },
  { names: ['central memorial', 'wellington'], name: "Central Memorial Park", lat: 43.2490, lng: -79.8520 },
  { names: ['ottawa st', 'ottawa street'], name: "Ottawa St N Corridor", lat: 43.2435, lng: -79.8185 },
  { names: ['main st e', 'victoria ave'], name: "Main St E & Victoria Ave", lat: 43.2500, lng: -79.8500 },
  { names: ['gage park', 'gage ave'], name: "Gage Park Sector", lat: 43.2450, lng: -79.8350 },
  { names: ['cannon st'], name: "Cannon St E Corridor", lat: 43.2600, lng: -79.8660 },
  { names: ['locke st', 'locke street'], name: "Locke St South", lat: 43.2550, lng: -79.8850 },
  { names: ['queenston', 'eastgate'], name: "Queenston Rd Corridor", lat: 43.2250, lng: -79.7650 },
  { names: ['kenilworth', 'centre mall'], name: "Kenilworth Ave Sector", lat: 43.2450, lng: -79.8050 },
  { names: ['upper james', 'mohawk'], name: "Upper James & Mohawk", lat: 43.2280, lng: -79.8780 },
  { names: ['concession', 'juravinski'], name: "Concession St / Hospital Zone", lat: 43.2350, lng: -79.8400 }
];

async function verifyAndExtract(item, feedType, sourceName) {
  const title = (item.title || "").toLowerCase();
  const rawSnippet = (item.contentSnippet || item.content || "").toLowerCase();
  const leadText = title + " " + rawSnippet;

  if (!leadText.includes('hamilton') && sourceName !== "@interventionintersection2026") {
    return null;
  }

  let matchedCorridor = null;
  for (const loc of EXACT_STREET_WHITELIST) {
    if (loc.names.some(keyword => new RegExp('\\b' + keyword + '\\b', 'i').test(leadText))) {
      matchedCorridor = loc;
      break;
    }
  }

  const hasPin = matchedCorridor !== null;
  const pinData = matchedCorridor || { name: "Hamilton General Core", lat: null, lng: null };

  let articleDate = item.pubDate ? new Date(item.pubDate) : new Date();
  if (isNaN(articleDate.getTime())) articleDate = new Date();

  return {
    category: feedType,
    hasPin: hasPin,
    lat: pinData.lat,
    lng: pinData.lng,
    source: `${sourceName} • ${pinData.name}`,
    description: (item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").substring(0, 180) + '...',
    url: item.link || 'https://hamiltonpolice.on.ca/news/',
    timestamp: Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Seeding verified Hamilton incident baselines...");
  for (const seed of VERIFIED_INCIDENT_SEEDS) {
    await db.collection("reports").doc(seed.id).set({
      category: seed.category,
      hasPin: seed.hasPin,
      lat: seed.lat,
      lng: seed.lng,
      source: seed.source,
      description: seed.description,
      url: seed.url,
      timestamp: seed.timestamp,
      createdAt: FieldValue.serverTimestamp(),
      active: true
    });
  }

  console.log("Running Multi-Source Live Feed Ingestion...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 50)) {
        const intel = await verifyAndExtract(item, feed.type, feed.sourceName);
        if (!intel) continue;

        const uniqueString = (item.link || item.title) + '-' + intel.source;
        const docId = crypto.createHash('md5').update(uniqueString).digest('hex');

        await db.collection("reports").doc(docId).set({
          category: intel.category,
          hasPin: intel.hasPin,
          lat: intel.lat,
          lng: intel.lng,
          source: intel.source,
          description: intel.description,
          url: intel.url,
          timestamp: intel.timestamp,
          createdAt: FieldValue.serverTimestamp(),
          active: true
        });
        count++;
      }
      await sleep(1500);
    } catch (e) {
      console.error(`Feed Error (${feed.sourceName}):`, e.message);
    }
  }
  console.log(`Ingestion Complete. Synchronized ${count} live records.`);
}

run().catch(err => {
  console.error("Critical Error:", err);
  process.exit(1);
});
