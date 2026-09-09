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

// Absolute Precision Whitelist: Maps exact street names and locations to their true geographic coordinates
const EXACT_STREET_WHITELIST = [
  { names: ['candlewood drive', 'candlewood dr'], name: "Candlewood Dr, Stoney Creek", lat: 43.1751, lng: -79.7829 },
  { names: ['fruitland road', 'fruitland rd'], name: "Fruitland Rd Corridor", lat: 43.2144, lng: -79.7135 },
  { names: ['rymal road', 'rymal rd'], name: "Rymal Rd E Corridor", lat: 43.1850, lng: -79.8150 },
  { names: ['james street north', 'james st n'], name: "James St N Corridor", lat: 43.2612, lng: -79.8665 },
  { names: ['barton street', 'barton st'], name: "Barton St Corridor", lat: 43.2450, lng: -79.8150 },
  { names: ['king street', 'king st'], name: "King St Corridor", lat: 43.2557, lng: -79.8711 },
  { names: ['main street', 'main st'], name: "Main St Corridor", lat: 43.2500, lng: -79.8500 },
  { names: ['upper james'], name: "Upper James St", lat: 43.2280, lng: -79.8780 },
  { names: ['hess street', 'hess st'], name: "Hess Village", lat: 43.2530, lng: -79.8795 },
  { names: ['ottawa street', 'ottawa st'], name: "Ottawa St N", lat: 43.2430, lng: -79.8200 },
  { names: ['concession street', 'concession st'], name: "Concession St", lat: 43.2350, lng: -79.8400 }
];

function verifyAndExtractLocation(item, feedType, sourceName) {
  const text = (item.title + " " + (item.contentSnippet || item.content || "")).toLowerCase();
  const urlLower = (item.link || '').toLowerCase();

  // Reject archives, tags, or general search index pages
  if (urlLower.includes('/archive') || urlLower.includes('/tag') || urlLower.includes('/search') || urlLower.includes('/category')) {
    return null; 
  }

  // Strict blacklist to eliminate noise
  const blacklist = ['rent', 'gym', 'school', 'student', 'ticats', 'argonauts', 'football', 'hockey', 'tickets', 'history', 'festival', 'parade', 'osap', 'university', 'home opener', 'policy', 'lake ontario', 'blitz', 'education'];
  if (blacklist.some(term => text.includes(term))) return null;

  // Strict Location Matching: Scan specifically for distinct street keys in order of length/specificity
  let matchedCorridor = null;
  for (const corridor of EXACT_STREET_WHITELIST) {
    if (corridor.names.some(streetName => text.includes(streetName))) {
      matchedCorridor = corridor;
      break;
    }
  }

  // Zero-Guesswork Policy: If the article text does not explicitly name a verified street, drop it entirely.
  if (!matchedCorridor) return null;

  let category = feedType;
  if (text.includes('shooting') || text.includes('gun') || text.includes('stabbing') || text.includes('armed') || text.includes('police') || text.includes('homicide')) {
    category = 'emergency';
  } else if (text.includes('roadwork') || text.includes('pothole')) {
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
  console.log("Running bulletproof precision intelligence ingestion...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 50)) {
        const intel = verifyAndExtractLocation(item, feed.type, feed.sourceName);
        if (!intel) continue; // Safely drops any ambiguous or unmapped stories

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
        console.log(`[Precision Pin] ${intel.category} -> ${intel.source}`);
      }
    } catch (e) {
      console.error(`Feed Error:`, e.message);
    }
  }
  console.log(`Ingestion complete. Deployed ${count} precision-matched pins.`);
}

run().catch(err => {
  console.error("Critical Error:", err);
  process.exit(1);
});
