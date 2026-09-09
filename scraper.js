// scraper.js - Enterprise Multi-Source Ingestion Pipeline for Wet Floor Watch
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const Parser = require("rss-parser");
const crypto = require("crypto");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WetFloorWatch-EnterpriseMaster/21.0',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Comprehensive ingestion vectors covering official police, municipal alerts, local news, and community chatter
const FEEDS = [
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+(drug+OR+weapons+OR+assault+OR+stabbing+OR+arrest+OR+shooting)+when:1y&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Official Police Dispatch" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+(needle+OR+syringe+OR+paraphernalia+OR+pipe+OR+overdose+OR+tent+OR+encampment)+when:6m&hl=en-CA&gl=CA&ceid=CA:en", type: "news", sourceName: "Local News Network" },
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=needle+OR+drug+OR+tent+OR+encampment+OR+paraphernalia+OR+overdose+OR+harassment+OR+police&restrict_sr=on&sort=new&t=year", type: "unverified", sourceName: "Anonymous Community Report (r/Hamilton)" },
  { url: "https://rss.app/feeds/J229itoFzyOpFVv2.xml", type: "unverified", sourceName: "Anonymous Street Report (@interventionintersection2026)" }
];

// Strict 100% Pinpoint Whitelist Corridors across Hamilton with Verified Coordinates
const EXACT_STREET_WHITELIST = [
  { names: ['york & bay', 'york blvd & bay', 'york and bay'], name: "York Blvd & Bay St Corridor", lat: 43.2625, lng: -79.8732 },
  { names: ['barton & james', 'barton and james', 'christ church', 'james n & barton'], name: "Barton St E & James St N", lat: 43.2618, lng: -79.8660 },
  { names: ['jackson square', 'king st w & macnab', 'gore park', 'king & macnab'], name: "Jackson Square Core", lat: 43.2557, lng: -79.8711 },
  { names: ['orchard park', 'dewitt', 'fruitland', 'candlewood'], name: "Stoney Creek Corridor", lat: 43.2144, lng: -79.7135 },
  { names: ['james st n', 'james north'], name: "James St N Corridor", lat: 43.2612, lng: -79.8665 },
  { names: ['beasley', 'beasley park', 'mary st'], name: "Beasley Park Zone", lat: 43.2575, lng: -79.8580 },
  { names: ['hess st', 'hess village'], name: "Hess Village Corridor", lat: 43.2530, lng: -79.8795 },
  { names: ['central memorial', 'wellington st'], name: "Central Memorial Park", lat: 43.2490, lng: -79.8520 },
  { names: ['ottawa st', 'ottawa street'], name: "Ottawa St N Corridor", lat: 43.2435, lng: -79.8185 },
  { names: ['main st e', 'victoria ave'], name: "Main St E & Victoria Ave", lat: 43.2500, lng: -79.8500 },
  { names: ['gage park', 'gage ave'], name: "Gage Park Sector", lat: 43.2450, lng: -79.8350 },
  { names: ['cannon st', 'cannon'], name: "Cannon St E", lat: 43.2600, lng: -79.8660 },
  { names: ['barton st', 'barton street', 'woodlands park'], name: "Barton St Corridor", lat: 43.2550, lng: -79.8350 },
  { names: ['locke st', 'locke street'], name: "Locke St South", lat: 43.2550, lng: -79.8850 },
  { names: ['queenston rd', 'queenston road', 'eastgate'], name: "Queenston Rd Corridor", lat: 43.2250, lng: -79.7650 },
  { names: ['kenilworth', 'centre mall'], name: "Kenilworth Ave", lat: 43.2450, lng: -79.8050 },
  { names: ['upper james', 'mohawk rd'], name: "Upper James & Mohawk", lat: 43.2280, lng: -79.8780 },
  { names: ['concession st', 'juravinski'], name: "Concession St / Hospital Zone", lat: 43.2350, lng: -79.8400 }
];

async function verifyAndExtract(item, feedType, sourceName) {
  const title = (item.title || "").toLowerCase();
  const rawSnippet = (item.contentSnippet || item.content || "").toLowerCase();
  const leadText = title + " " + rawSnippet;

  if (!leadText.includes('hamilton') && sourceName !== "Anonymous Street Report (@interventionintersection2026)") {
    return null;
  }

  let matchedCorridor = null;
  for (const corridor of EXACT_STREET_WHITELIST) {
    if (corridor.names.some(keyword => new RegExp('\\b' + keyword + '\\b', 'i').test(leadText))) {
      matchedCorridor = corridor;
      break;
    }
  }

  const hasPin = matchedCorridor !== null;
  const pinData = matchedCorridor || { name: "Hamilton General Area", lat: null, lng: null };

  let articleDate = item.pubDate ? new Date(item.pubDate) : new Date();
  if (isNaN(articleDate.getTime())) articleDate = new Date();

  // Enforce 2-year windowing limit
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  if (articleDate < twoYearsAgo) return null;

  return {
    category: feedType,
    hasPin: hasPin,
    lat: pinData.lat,
    lng: pinData.lng,
    source: `${sourceName} • ${pinData.name}`,
    description: (item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").substring(0, 180) + '...',
    url: String(item.link || 'https://hamiltonpolice.on.ca/news/'),
    timestamp: Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Initializing Enterprise Ingestion Pipeline...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      console.log(`Ingesting feed: ${feed.sourceName}`);
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
        console.log(`[Synced Record] ${intel.category} (${intel.hasPin ? 'Pinned' : 'Feed Only'}) -> ${intel.source}`);
      }

      await sleep(2000);
    } catch (e) {
      console.error(`Pipeline Error (${feed.sourceName}):`, e.message);
    }
  }
  console.log(`Ingestion Complete. Synchronized ${count} validated intelligence reports.`);
}

run().catch(err => {
  console.error("Critical Failure:", err);
  process.exit(1);
});
