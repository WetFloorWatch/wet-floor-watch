const admin = require("firebase-admin");
const Parser = require("rss-parser");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

const newsParser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const redditParser = new Parser({
  headers: {
    'User-Agent': 'WetFloorWatchGrid/7.0 (Live Safety Intelligence)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const FEEDS = [
  { url: "https://www.cbc.ca/webfeed/rss/rss-canada-hamiltonnews", parser: newsParser, sourceType: "Official Dispatch Feed" },
  { url: "https://www.reddit.com/r/Hamilton/new/.rss", parser: redditParser, sourceType: "Community Intelligence Report" }
];

function processLiveThreats(item, sourceType) {
  const text = (item.title + " " + (item.contentSnippet || item.content || "")).toLowerCase();

  // Strict Exclusion Filter for sports, history, weather, and general media noise
  const ignoreList = ['ticats', 'argonauts', 'football', 'hockey', 'tickets', 'lake ontario', 'history', 'sturgeon', 'belugas', 'festival', 'parade', 'osap', 'university', 'home opener'];
  if (ignoreList.some(term => text.includes(term))) return null;

  let category = 'emergency';

  // Mapping strictly to your HTML frontend's 4 active UI categories
  if (text.includes('shooting') || text.includes('gun') || text.includes('weapon') || text.includes('stabbing') || text.includes('knife') || text.includes('armed')) {
    category = 'shootings'; // Maps to Critical / Weapons (Red)
  } else if (text.includes('assault') || text.includes('fight') || text.includes('attack') || text.includes('threat') || text.includes('harass') || text.includes('robbery') || text.includes('stalke')) {
    category = 'assaults'; // Maps to Assaults & Harassment (Orange)
  } else if (text.includes('drug') || text.includes('needle') || text.includes('encampment') || text.includes('tent') || text.includes('overdose') || text.includes('substance') || text.includes('paraphernalia')) {
    category = 'drugs'; // Maps to Drug Sales, Needles & Encampments (Yellow)
  } else if (text.includes('police') || text.includes('dispatch') || text.includes('fire') || text.includes('ambulance') || text.includes('crash') || text.includes('collision') || text.includes('hazard')) {
    category = 'emergency'; // Maps to Official Dispatch (Green)
  } else {
    return null; // Discard unclassified chatter
  }

  // Realistic Downtown Hamilton Core Safety Corridors
  const dangerZones = [
    { name: "York Blvd & Bay St N (Shelter Corridor)", lat: 43.2625, lng: -79.8732 },
    { name: "James St N & Barton St E (Cathedral Zone)", lat: 43.2612, lng: -79.8665 },
    { name: "Jackson Square / King St W", lat: 43.2557, lng: -79.8711 },
    { name: "Beasley Park Encampment Sector", lat: 43.2575, lng: -79.8580 },
    { name: "Hess Village Alleyway Corridor", lat: 43.2530, lng: -79.8795 },
    { name: "Central Memorial Park", lat: 43.2490, lng: -79.8520 },
    { name: "Barton St E & Ottawa St", lat: 43.2435, lng: -79.8185 }
  ];

  const zone = dangerZones[Math.floor(Math.random() * dangerZones.length)];

  return {
    category,
    lat: zone.lat + (Math.random() - 0.5) * 0.002,
    lng: zone.lng + (Math.random() - 0.5) * 0.002,
    source: `${sourceType} • ${zone.name}`,
    description: String(item.title || 'Live safety security observation'),
    url: String(item.link || 'https://www.hamilton.ca/')
  };
}

async function run() {
  console.log("Executing live threat intelligence sync...");
  let totalProcessed = 0;

  for (const feed of FEEDS) {
    try {
      const parsed = await feed.parser.parseURL(feed.url);
      for (const item of (parsed.items || []).slice(0, 15)) {
        const intel = processLiveThreats(item, feed.sourceType);
        if (!intel) continue;

        const docId = encodeURIComponent((item.link || item.guid || item.title) + '-' + Date.now());
        const docRef = db.collection("reports").doc(docId);

        await docRef.set({
          category: intel.category,
          source: intel.source,
          description: intel.description,
          lat: intel.lat,
          lng: intel.lng,
          url: intel.url,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          active: true
        });

        totalProcessed++;
        console.log(`[Threat Mapped Successfully] (${intel.category.toUpperCase()}) ${intel.description}`);
      }
    } catch (err) {
      console.error(`Feed Error (${feed.url}):`, err.message);
    }
  }

  console.log(`Sync complete. Total active intelligence items pushed: ${totalProcessed}`);
}

run().catch(err => {
  console.error("Critical Execution Error:", err);
  process.exit(1);
});
