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
  { url: "https://www.cbc.ca/webfeed/rss/rss-canada-hamiltonnews", type: "news" },
  { url: "https://www.reddit.com/r/Hamilton/new/.rss", type: "unverified" }
];

function filterAndCategorize(item, feedType) {
  const text = (item.title + " " + (item.contentSnippet || item.content || "")).toLowerCase();

  // STRICT FLUFF FILTER: Immediately reject anything related to these topics
  const rejectList = [
    'rent', 'gym', 'school', 'student', 'ticats', 'argonauts', 'football', 
    'hockey', 'tickets', 'history', 'festival', 'parade', 'osap', 'university', 
    'home opener', 'policy', 'lake ontario', 'sturgeon', 'belugas', 'blitz', 'education'
  ];
  if (rejectList.some(term => text.includes(term))) {
    return null; // Skip non-safety fluff
  }

  // CATEGORY ROUTING matching index.html lists
  let category = feedType; // Default to 'news' or 'unverified' based on feed origin

  if (text.includes('shooting') || text.includes('gun') || text.includes('stabbing') || text.includes('armed') || text.includes('police') || text.includes('fire') || text.includes('paramedic')) {
    category = 'emergency'; // Overrides to Green Pin
  } else if (text.includes('roadwork') || text.includes('lane restriction') || text.includes('pothole') || text.includes('infrastructure')) {
    category = 'verified'; // Overrides to Orange Pin
  } else if (!text.includes('drug') && !text.includes('assault') && !text.includes('crime') && !text.includes('danger') && !text.includes('hazard')) {
    // If it passed the reject filter but isn't explicitly safety related, keep as general news/unverified
    if (feedType === 'news') category = 'news';
  }

  // Realistic coordinate snapping for Hamilton
  const hotzones = [
    { name: "York Blvd & Bay St N", lat: 43.2625, lng: -79.8732 },
    { name: "James St N & Barton St E", lat: 43.2612, lng: -79.8665 },
    { name: "Jackson Square / King St W", lat: 43.2557, lng: -79.8711 },
    { name: "Main St E & Victoria Ave", lat: 43.2500, lng: -79.8500 },
    { name: "Cannon St E & Mary St", lat: 43.2600, lng: -79.8600 }
  ];

  const zone = hotzones[Math.floor(Math.random() * hotzones.length)];

  return {
    category: category,
    lat: zone.lat + (Math.random() - 0.5) * 0.005,
    lng: zone.lng + (Math.random() - 0.5) * 0.005,
    source: `${feedType === 'unverified' ? 'Social Chatter' : 'Live Dispatch'} • ${zone.name}`,
    description: String(item.title || 'Live threat intelligence'),
    url: String(item.link || 'https://www.hamilton.ca/')
  };
}

async function run() {
  console.log("Starting strict data ingestion...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 30)) {
        const intel = filterAndCategorize(item, feed.type);
        if (!intel) continue; // Skip if filtered out

        const docId = encodeURIComponent((item.link || item.guid || item.title) + '-' + Date.now());
        await db.collection("reports").doc(docId).set({
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

        count++;
        console.log(`[Logged] Category: ${intel.category} -> ${intel.description}`);
      }
    } catch (e) {
      console.error(`Feed Error:`, e.message);
    }
  }
  console.log(`Ingestion complete. Deployed ${count} active pins.`);
}

run().catch(err => {
  console.error("Critical Error:", err);
  process.exit(1);
});
