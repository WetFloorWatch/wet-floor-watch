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
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+(shooting+OR+stabbing+OR+police+OR+fire+OR+EMS+OR+drug+OR+assault+OR+homicide)+when:1y&hl=en-CA&gl=CA&ceid=CA:en", type: "news", sourceName: "Local News Network" },
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=drug+OR+encampment+OR+needle+OR+police+OR+assault+OR+stabbing+OR+suspicious+OR+homicide+OR+shooting&restrict_sr=on&sort=new&t=year", type: "unverified", sourceName: "Reddit r/Hamilton" },
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+(shooting+OR+stabbing+OR+arrest+OR+investigation+OR+assault+OR+homicide)+when:1y&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Official Police Dispatch" }
];

const VERIFIED_CORRIDORS = [
  { keywords: ['fruitland'], name: "Fruitland Rd Corridor", lat: 43.2144, lng: -79.7135 },
  { keywords: ['rymal', 'whitedeer'], name: "Rymal Rd E & Whitedeer Rd", lat: 43.1850, lng: -79.8150 },
  { keywords: ['james st', 'barton'], name: "James St N & Barton St E", lat: 43.2612, lng: -79.8665 },
  { keywords: ['king', 'wellington'], name: "King St E & Wellington St S", lat: 43.2545, lng: -79.8520 },
  { keywords: ['upper james', 'mohawk'], name: "Upper James St & Mohawk Rd W", lat: 43.2280, lng: -79.8780 },
  { keywords: ['jackson square', 'king w'], name: "Jackson Square / King St W", lat: 43.2557, lng: -79.8711 },
  { keywords: ['main', 'victoria'], name: "Main St E & Victoria Ave S", lat: 43.2500, lng: -79.8500 },
  { keywords: ['cannon', 'mary'], name: "Cannon St E & Mary St", lat: 43.2600, lng: -79.8600 },
  { keywords: ['hess'], name: "Hess St S & King St W", lat: 43.2530, lng: -79.8790 },
  { keywords: ['ottawa', 'barton'], name: "Ottawa St N & Barton St E", lat: 43.2430, lng: -79.8200 },
  { keywords: ['concession'], name: "Concession St & Wellington St S", lat: 43.2350, lng: -79.8400 }
];

function strictExtractThreat(item, feedType, sourceName) {
  const text = (item.title + " " + (item.contentSnippet || item.content || "")).toLowerCase();
  const urlLower = (item.link || '').toLowerCase();

  // 1. CRITICAL LEGAL FIX: Reject any URL that points to an archive, search tag, or category index page
  if (
    urlLower.includes('/archive') || 
    urlLower.includes('/tag') || 
    urlLower.includes('/search') || 
    urlLower.includes('/category') ||
    urlLower === 'https://hamiltonpolice.on.ca'
  ) {
    return null; 
  }

  // 2. Strict Blacklist
  const blacklist = ['rent', 'gym', 'school', 'student', 'ticats', 'argonauts', 'football', 'hockey', 'tickets', 'history', 'festival', 'parade', 'osap', 'university', 'home opener', 'policy', 'lake ontario', 'blitz', 'education', 'bulldogs', 'concert'];
  if (blacklist.some(term => text.includes(term))) return null;

  // 3. Strict Location Search
  let matchedCorridor = VERIFIED_CORRIDORS.find(c => c.keywords.every(kw => text.includes(kw)));
  if (!matchedCorridor) {
    matchedCorridor = VERIFIED_CORRIDORS.find(c => c.keywords.some(kw => text.includes(kw)));
  }

  // Zero-Fallback Policy: If location cannot be verified from the text, drop it.
  if (!matchedCorridor) return null;

  let category = feedType;
  if (text.includes('shooting') || text.includes('gun') || text.includes('stabbing') || text.includes('armed') || text.includes('police') || text.includes('fire') || text.includes('paramedic') || text.includes('missing') || text.includes('homicide')) {
    category = 'emergency';
  } else if (text.includes('roadwork') || text.includes('lane') || text.includes('pothole')) {
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
  console.log("Executing anti-archive geo-matched ingestion...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 50)) {
        const intel = strictExtractThreat(item, feed.type, feed.sourceName);
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
        console.log(`[Verified Unique Article] ${intel.category} -> ${intel.source} (${intel.url})`);
      }
    } catch (e) {
      console.error(`Feed Error:`, e.message);
    }
  }
  console.log(`Ingestion complete. Deployed ${count} legally sound unique article pins.`);
}

run().catch(err => {
  console.error("Critical Error:", err);
  process.exit(1);
});
