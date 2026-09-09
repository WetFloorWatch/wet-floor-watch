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
    'User-Agent': 'WetFloorWatchGrid/4.0 (Community Safety Monitor)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

// Expanded multi-source feed list to maximize pin generation volume
const FEEDS = [
  { url: "https://www.cbc.ca/webfeed/rss/rss-canada-hamiltonnews", parser: newsParser, type: "Verified News Feed" },
  { url: "https://www.cbc.ca/webfeed/rss/rss-canada-toronto", parser: newsParser, type: "Regional News Feed" },
  { url: "https://www.reddit.com/r/Hamilton/new/.rss", parser: redditParser, type: "Crowdsourced Community Report" }
];

async function run() {
  console.log("Starting high-volume multi-source intelligence generator...");
  let totalProcessed = 0;

  for (const feedConfig of FEEDS) {
    try {
      console.log(`Parsing feed: ${feedConfig.url}`);
      const feed = await feedConfig.parser.parseURL(feedConfig.url);
      
      // Increased slice limit to 12 items per feed for high density
      for (const item of (feed.items || []).slice(0, 12)) {
        const uniqueId = encodeURIComponent((item.link || item.guid || item.title) + '-' + Date.now() + '-' + Math.random());
        const docRef = db.collection("reports").doc(uniqueId);
        
        const text = (item.title + " " + (item.contentSnippet || item.content || "")).toLowerCase();
        
        let category = 'emergency';
        let severity = 'medium';

        if (text.includes('shooting') || text.includes('gun') || text.includes('firearm') || text.includes('weapon') || text.includes('stabbing')) {
          category = 'shootings';
          severity = 'high';
        } else if (text.includes('assault') || text.includes('fight') || text.includes('attack') || text.includes('threat') || text.includes('robbery') || text.includes('theft')) {
          category = 'assaults';
          severity = 'high';
        } else if (text.includes('drug') || text.includes('needle') || text.includes('encampment') || text.includes('overdose') || text.includes('substance')) {
          category = 'drugs';
          severity = 'medium';
        } else {
          category = 'emergency';
          severity = text.includes('crash') || text.includes('collision') || text.includes('police') || text.includes('blitz') ? 'high' : 'low';
        }

        const zones = [
          { name: "Downtown Core • James St N", lat: 43.2590, lng: -79.8660 },
          { name: "Hamilton Mountain • Upper Wellington", lat: 43.2350, lng: -79.8780 },
          { name: "East End • Barton St E", lat: 43.2450, lng: -79.8150 },
          { name: "West End • Dundas Corridor", lat: 43.2650, lng: -79.9550 },
          { name: "Stoney Creek Sector", lat: 43.2235, lng: -79.7520 },
          { name: "Ancaster Village", lat: 43.2250, lng: -79.9850 }
        ];
        
        const zone = zones[Math.floor(Math.random() * zones.length)];
        const lat = zone.lat + (Math.random() - 0.5) * 0.03;
        const lng = zone.lng + (Math.random() - 0.5) * 0.03;

        await docRef.set({
          category: category,
          source: `${feedConfig.type} (${zone.name})`,
          description: String(item.title || 'Regional safety report'),
          lat: lat,
          lng: lng,
          severity: severity,
          url: String(item.link || 'https://www.hamilton.ca/'),
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          active: true
        });

        totalProcessed++;
        console.log(`[Success] Deployed pin: ${item.title} at [${lat.toFixed(4)}, ${lng.toFixed(4)}]`);
      }
    } catch (feedErr) {
      console.error(`[Feed Error] Failed to fetch feed ${feedConfig.url}:`, feedErr.message);
    }
  }

  console.log(`Scraper run complete. Total new intelligence pins added: ${totalProcessed}`);
}

run().catch(err => {
  console.error("Critical Scraper Error:", err);
  process.exit(1);
});
