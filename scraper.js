const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const Parser = require("rss-parser");
const crypto = require("crypto");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("FATAL: FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WetFloorWatch-TacticalEngine/24.0',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  },
  timeout: 10000
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const VERIFIED_INCIDENT_SEEDS = [
  {
    id: "seed-2026-stoney-creek",
    category: "emergency",
    hasPin: true,
    lat: 43.2144,
    lng: -79.7135,
    source: "Official Police Dispatch • Stoney Creek Sector",
    description: "Hamilton Police investigated a deadly double shooting linked to an earlier dispute in a residential townhouse complex.",
    url: "https://www.cp24.com/local/hamilton/2026/07/29/shooting-in-stoney-creek-leaves-2-dead-hamilton-police/",
    timestamp: Timestamp.fromDate(new Date("2026-07-29T03:30:00"))
  },
  {
    id: "seed-2026-main-st-homicide",
    category: "emergency",
    hasPin: true,
    lat: 43.2500,
    lng: -79.8500,
    source: "Official Police Dispatch • Main St W & Frid St",
    description: "Homicide unit investigated a fatal overnight downtown stabbing incident near King Street West and Paradise Road North.",
    url: "https://hamiltonpolice.on.ca/news/hamilton-police-investigating-overnight-homicide/",
    timestamp: Timestamp.fromDate(new Date("2026-08-09T02:30:00"))
  },
  {
    id: "seed-2026-oriole-shooting",
    category: "emergency",
    hasPin: true,
    lat: 43.2350,
    lng: -79.8400,
    source: "Official Police Dispatch • Oriole Crescent",
    description: "Shots fired at a residential dwelling; Hamilton Police recovered spent casings and appealed for neighborhood security footage.",
    url: "https://hamiltonpolice.on.ca/news/hamilton-police-seek-witnesses-in-overnight-shooting-in-oriole-crescent/",
    timestamp: Timestamp.fromDate(new Date("2026-09-03T22:30:00"))
  },
  {
    id: "seed-2026-macnab-stabbing",
    category: "emergency",
    hasPin: true,
    lat: 43.2557,
    lng: -79.8711,
    source: "Official Police Dispatch • MacNab Transit Terminal",
    description: "Daytime string of stabbings near King & James and the MacNab transit terminal sent four individuals to the hospital.",
    url: "https://www.cp24.com/local/hamilton/2026/07/14/suspect-charged-in-connection-with-string-of-daytime-stabbings-in-downtown-hamilton-that-injured-4/",
    timestamp: Timestamp.fromDate(new Date("2026-07-14T14:10:00"))
  },
  {
    id: "seed-2026-east14-bearspray",
    category: "emergency",
    hasPin: true,
    lat: 43.2300,
    lng: -79.8600,
    source: "Official Police Dispatch • East Mountain / East 14th St",
    description: "Violent knifepoint ambush and bear spray attack on the East Mountain targeting a teenager and intervening residents.",
    url: "https://toronto.citynews.ca/2026/01/27/hamilton-police-youths-charged-bear-spray-assault-mountain/",
    timestamp: Timestamp.fromDate(new Date("2026-01-21T20:45:00"))
  },
  {
    id: "seed-2026-news-needles",
    category: "hazard",
    hasPin: true,
    lat: 43.2618,
    lng: -79.8660,
    source: "Local News Network • Barton St & James St N",
    description: "Paramedic data and public health reports show sharp surges in opioid poisonings and discarded biohazard needles across core transit stops.",
    url: "https://www.cbc.ca/news/investigates/ontario-paramedic-non-fatal-overdose-calls-rise-data-analysis-9.7258237",
    timestamp: Timestamp.fromDate(new Date("2026-09-06T10:00:00"))
  }
];

const FEEDS = [
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+when:6m&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Official Police Dispatch" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+news+(shooting+OR+stabbing+OR+assault+OR+drug+OR+fire+OR+crime+OR+encampment)+when:3m&hl=en-CA&gl=CA&ceid=CA:en", type: "advisory", sourceName: "Local News Network" },
  { url: "https://news.google.com/rss/search?q=site:thespec.com+Hamilton+when:3m&hl=en-CA&gl=CA&ceid=CA:en", type: "advisory", sourceName: "The Hamilton Spectator" },
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=needle+OR+drug+OR+tent+OR+encampment+OR+paraphernalia+OR+overdose+OR+police+OR+incident&restrict_sr=on&sort=new&t=year", type: "street", sourceName: "Community Chatter (r/Hamilton)" },
  { url: "https://rss.app/feeds/J229itoFzyOpFVv2.xml", type: "street", sourceName: "@interventionintersection2026" }
];

const EXACT_STREET_WHITELIST = [
  { names: ['oriole', 'oriole crescent'], name: "Oriole Crescent Sector", lat: 43.2350, lng: -79.8400 },
  { names: ['york & bay', 'york blvd', 'bay st', 'bay street'], name: "York Blvd & Bay St Corridor", lat: 43.2625, lng: -79.8732 },
  { names: ['barton & james', 'barton street', 'james north', 'james st n', 'james st'], name: "Barton St & James St Corridor", lat: 43.2618, lng: -79.8660 },
  { names: ['jackson square', 'king st', 'macnab', 'gore park', 'downtown'], name: "Jackson Square / Downtown Core", lat: 43.2557, lng: -79.8711 },
  { names: ['orchard park', 'dewitt', 'fruitland', 'stoney creek'], name: "Stoney Creek / Fruitland Sector", lat: 43.2144, lng: -79.7135 },
  { names: ['beasley', 'mary st', 'beasley park'], name: "Beasley Park Zone", lat: 43.2575, lng: -79.8580 },
  { names: ['hess village', 'hess st'], name: "Hess Village Corridor", lat: 43.2530, lng: -79.8795 },
  { names: ['central memorial', 'wellington'], name: "Central Memorial Park", lat: 43.2490, lng: -79.8520 },
  { names: ['ottawa st', 'ottawa street'], name: "Ottawa St N Corridor", lat: 43.2435, lng: -79.8185 },
  { names: ['main st e', 'victoria ave', 'main st w', 'frid st'], name: "Main St Corridor", lat: 43.2500, lng: -79.8500 },
  { names: ['gage park', 'gage ave'], name: "Gage Park Sector", lat: 43.2450, lng: -79.8350 },
  { names: ['cannon st'], name: "Cannon St E Corridor", lat: 43.2600, lng: -79.8660 },
  { names: ['locke st', 'locke street'], name: "Locke St South", lat: 43.2550, lng: -79.8850 },
  { names: ['queenston', 'eastgate'], name: "Queenston Rd Corridor", lat: 43.2250, lng: -79.7650 },
  { names: ['kenilworth', 'centre mall'], name: "Kenilworth Ave Sector", lat: 43.2450, lng: -79.8050 },
  { names: ['upper james', 'mohawk'], name: "Upper James & Mohawk", lat: 43.2280, lng: -79.8780 },
  { names: ['concession', 'juravinski'], name: "Concession St / Hospital Zone", lat: 43.2350, lng: -79.8400 },
  { names: ['east 14th', 'east mountain'], name: "East Mountain Sector", lat: 43.2300, lng: -79.8600 }
];

function sanitizeUrl(rawUrl) {
  if (!rawUrl) return 'https://hamiltonpolice.on.ca/news/';
  let url = rawUrl.trim();
  if (url.includes('reddit.com')) {
    url = url.replace('http://', 'https://');
    if (!url.startsWith('https://www.reddit.com')) {
      url = url.replace(/https:\/\/[^\/]*reddit\.com/, 'https://www.reddit.com');
    }
  }
  return url;
}

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
  const pinData = matchedCorridor || { name: "Hamilton General Core", lat: 43.2557, lng: -79.8711 };

  let articleDate = item.pubDate ? new Date(item.pubDate) : new Date();
  if (isNaN(articleDate.getTime())) articleDate = new Date();

  const cleanDescription = (item.contentSnippet || item.title || '')
    .replace(/(<([^>]+)>)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 220) + '...';

  const cleanUrl = sanitizeUrl(item.link || item.guid);

  return {
    category: feedType,
    hasPin: hasPin,
    lat: pinData.lat,
    lng: pinData.lng,
    source: `${sourceName} • ${pinData.name}`,
    description: cleanDescription,
    url: cleanUrl,
    timestamp: Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Seeding verified 2026 Hamilton incident baselines...");
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
    }, { merge: true });
  }

  console.log("Running Live Feed Ingestion...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      console.log(`Fetching feed: ${feed.sourceName}`);
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 50)) {
        const intel = await verifyAndExtract(item, feed.type, feed.sourceName);
        if (!intel) continue;

        const uniqueString = intel.url + '-' + intel.source;
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
        }, { merge: true });
        count++;
      }
      await sleep(1500);
    } catch (e) {
      console.error(`Feed Error (${feed.sourceName}):`, e.message);
    }
  }
  console.log(`Ingestion Complete. Synchronized ${count} live records to Firestore.`);
  process.exit(0);
}

run().catch(err => {
  console.error("Critical Execution Error:", err);
  process.exit(1);
});
