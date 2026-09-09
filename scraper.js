const admin = require("firebase-admin");
const Parser = require("rss-parser");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const FEEDS = [
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=drug+OR+encampment+OR+needle+OR+police+OR+assault+OR+stabbing+OR+suspicious+OR+homicide+OR+shooting&restrict_sr=on&sort=new&t=year", type: "unverified", sourceName: "Reddit r/Hamilton" },
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+(shooting+OR+stabbing+OR+arrest+OR+investigation+OR+assault+OR+homicide)+when:6m&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Official Police Dispatch" }
];

// Absolute Precision Whitelist with true coordinates
const EXACT_STREET_WHITELIST = [
  { names: ['candlewood drive', 'candlewood dr'], name: "Candlewood Dr, Stoney Creek", lat: 43.1751, lng: -79.7829 },
  { names: ['fruitland road', 'fruitland rd'], name: "Fruitland Rd Corridor", lat: 43.2144, lng: -79.7135 },
  { names: ['rymal road', 'rymal rd'], name: "Rymal Rd E Corridor", lat: 43.1850, lng: -79.8150 },
  { names: ['james street north', 'james st n'], name: "James St N Corridor", lat: 43.2612, lng: -79.8665 },
  { names: ['barton street', 'barton st'], name: "Barton St Corridor", lat: 43.2450, lng: -79.8150 },
  { names: ['king street', 'king st'], name: "King St Corridor", lat: 43.2557, lng: -79.8711 },
  { names: ['main street', 'main st'], name: "Main St Corridor", lat: 43.2500, lng: -79.8500 },
  { names: ['upper james', 'upper james st'], name: "Upper James St", lat: 43.2280, lng: -79.8780 },
  { names: ['hess street', 'hess st'], name: "Hess Village", lat: 43.2530, lng: -79.8795 },
  { names: ['ottawa street', 'ottawa st'], name: "Ottawa St N", lat: 43.2430, lng: -79.8200 },
  { names: ['concession street', 'concession st'], name: "Concession St", lat: 43.2350, lng: -79.8400 }
];

function strictVerifyLeadLocation(item, feedType, sourceName) {
  const title = (item.title || "").toLowerCase();
  
  // ISOLATE LEAD TEXT ONLY: Read title + first 200 chars of snippet. Ignores footers/related stories.
  const rawSnippet = (item.contentSnippet || item.content || "").toLowerCase();
  const leadText = title + " " + rawSnippet.substring(0, 200);

  const urlLower = (item.link || '').toLowerCase();
  if (urlLower.includes('/archive') || urlLower.includes('/tag') || urlLower.includes('/search') || urlLower.includes('/category')) {
    return null; 
  }

  const blacklist = ['rent', 'gym', 'school', 'student', 'ticats', 'argonauts', 'football', 'hockey', 'tickets', 'history', 'festival', 'parade', 'osap', 'university', 'home opener', 'policy', 'lake ontario', 'blitz', 'education'];
  if (blacklist.some(term => leadText.includes(term))) return null;

  // Match strictly against lead text
  let matchedCorridor = null;
  for (const corridor of EXACT_STREET_WHITELIST) {
    if (corridor.names.some(streetName => leadText.includes(streetName))) {
      matchedCorridor = corridor;
      break;
    }
  }

  // Zero-Tolerance Policy: If street is not in the lead text, drop the pin entirely.
  if (!matchedCorridor) return null;

  let category = feedType;
  if (leadText.includes('shooting') || leadText.includes('gun') || leadText.includes('stabbing') || leadText.includes('armed') || leadText.includes('police') || leadText.includes('homicide')) {
    category = 'emergency';
  } else if (leadText.includes('roadwork') || leadText.includes('pothole')) {
    category = 'verified';
  } else if (feedType === 'unverified') {
    category = 'unverified';
  } else {
    category = 'news';
  }

  let articleDate = item.pubDate ? new Date(item.pubDate) : new Date();
  if (isNaN(articleDate.getTime())) articleDate = new Date();

  let cleanDesc = (item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").substring(0, 160) + '...';

  return {
    category: category,
    lat: matchedCorridor.lat,
    lng: matchedCorridor.lng,
    source: `${sourceName} • ${matchedCorridor.name}`,
    description: cleanDesc,
    url: String(item.link),
    timestamp: admin.firestore.Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Running lead-verified intelligence ingestion...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 50)) {
        const intel = strictVerifyLeadLocation(item, feed.type, feed.sourceName);
        if (!intel) continue;

        const docId = encodeURIComponent((item.link || item.guid || item.title) + '-' + Date.now());
        await db.collection("reports").doc(docId).set({
          category: intel.category,
          source: intel.source,
          description: intel.description,
          lat: intel.lat,
          lng: intel.lng,
          url: intel.url,
          timestamp: intel.timestamp,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          active: true
        });

        count++;
        console.log(`[Lead-Verified Pin] ${intel.category} -> ${intel.source}`);
      }
    } catch (e) {
      console.error(`Feed Error:`, e.message);
    }
  }
  console.log(`Ingestion complete. Deployed ${count} lead-verified pins.`);
}

run().catch(err => {
  console.error("Critical Error:", err);
  process.exit(1);
});
