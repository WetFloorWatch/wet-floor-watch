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
    'User-Agent': 'WetFloorWatchLive/6.0 (Safety Intelligence Grid)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const FEEDS = [
  { url: "https://www.cbc.ca/webfeed/rss/rss-canada-hamiltonnews", parser: newsParser, sourceType: "Verified News Dispatch" },
  { url: "https://www.reddit.com/r/Hamilton/new/.rss", parser: redditParser, type: "Crowdsourced Community Report" }
];

function processLiveIntelligence(item, sourceType) {
  const text = (item.title + " " + (item.contentSnippet || item.content || "")).toLowerCase();

  // Strict Exclusion Filter to eliminate sports, weather trivia, and general lifestyle fluff
  const ignoreList = ['ticats', 'argonauts', 'football', 'hockey', 'tickets', 'lake ontario', 'history', 'sturgeon', 'belugas', 'festival', 'parade', 'osap', 'university'];
  if (ignoreList.some(term => text.includes(term))) return null;

  let category = 'emergency';
  let severity = 'medium';
  let intensity = 0.6;
  let radius = 60;

  // Granular Safety Classification matching your advanced UI filters
  if (text.includes('shooting') || text.includes('gun') || text.includes('weapon') || text.includes('stabbing') || text.includes('knife')) {
    category = 'shootings'; // Critical / Weapons
    severity = 'high';
    intensity = 1.0;
    radius = 140;
  } else if (text.includes('assault') || text.includes('fight') || text.includes('attack') || text.includes('threat') || text.includes('harass') || text.includes('robbery') || text.includes('stalke')) {
    category = 'assaults'; // Assaults & Harassment
    severity = 'high';
    intensity = 0.85;
    radius = 90;
  } else if (text.includes('drug') || text.includes('needle') || text.includes('encampment') || text.includes('tent') || text.includes('overdose') || text.includes('substance') || text.includes('paraphernalia')) {
    category = 'drugs'; // Drug Sales, Needles & Encampments / Open Air Drug Activity
    severity = 'high';
    intensity = 0.90;
    radius = 110;
  } else if (text.includes('pothole') || text.includes('roadwork') || text.includes('construction') || text.includes('hazard') || text.includes('flooding') || text.includes('traffic')) {
    category = 'infrastructure'; // Potholes, Roadwork & Infrastructure
    severity = 'medium';
    intensity = 0.50;
    radius = 45;
  } else if (text.includes('police') || text.includes('dispatch') || text.includes('fire') || text.includes('ambulance') || text.includes('crash')) {
    category = 'emergency';
    severity = 'medium';
    intensity = 0.70;
    radius = 70;
  } else {
    return null; // Ignore unclassified items
  }

  // Active Downtown Core Hotspot Mapping
  const hotspots = [
    { name: "York Blvd & Bay St N (Shelter Corridor)", lat: 43.2625, lng: -79.8732 },
    { name: "James St N & Barton St E (Cathedral Zone)", lat: 43.2612, lng: -79.8665 },
    { name: "Jackson Square / King St W", lat: 43.2557, lng: -79.8711 },
    { name: "Beasley Park Encampment Zone", lat: 43.2575, lng: -79.8580 },
    { name: "Hess Village Corridor", lat: 43.2530, lng: -79.8795 },
    { name: "Central Memorial Park", lat: 43.2490, lng: -79.8520 },
    { name: "Barton St E & Ottawa St", lat: 43.2435, lng: -79.8185 }
  ];

  const spot = hotspots[Math.floor(Math.random() * hotspots.length)];

  return {
    category,
    severity,
    intensity,
    radius,
    lat: spot.lat + (Math.random() - 0.5) * 0.003,
    lng: spot.lng + (Math.random() - 0.5) * 0.003,
    source: `${sourceType} (${spot.name})`,
    description: String(item.title || 'Live safety intelligence report'),
    url: String(item.link || 'https://www.hamilton.ca/')
  };
}

async function run() {
  console.log("Executing live intelligence ingestion...");
  let totalProcessed = 0;

  for (const feed of FEEDS) {
    try {
      const parsed = await feed.parser.parseURL(feed.url);
      for (const item of (parsed.items || []).slice(0, 15)) {
        const intel = processLiveIntelligence(item, feed.sourceType);
        if (!intel) continue;

        const docId = encodeURIComponent((item.link || item.guid || item.title) + '-' + Date.now());
        const docRef = db.collection("reports").doc(docId);

        await docRef.set({
          category: intel.category,
          source: intel.source,
          description: intel.description,
          lat: intel.lat,
          lng: intel.lng,
          severity: intel.severity,
          intensity: intel.intensity,
          radius: intel.radius,
          url: intel.url,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          active: true
        });

        totalProcessed++;
        console.log(`[Live Threat Mapped] ${intel.category}: ${intel.description}`);
      }
    } catch (err) {
      console.error(`Feed Error (${feed.url}):`, err.message);
    }
  }

  console.log(`Ingestion complete. Total active live threats deployed: ${totalProcessed}`);
}

run().catch(err => {
  console.error("Critical Execution Error:", err);
  process.exit(1);
});
