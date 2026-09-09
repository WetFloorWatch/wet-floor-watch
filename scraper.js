const admin = require("firebase-admin");
const Parser = require("rss-parser");
const Groq = require("groq-sdk");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Free AI Layer: Groq SDK (OpenAI-compatible, 14,400 free requests/day)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const FEEDS = [
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=drug+OR+encampment+OR+needle+OR+police+OR+assault+OR+stabbing+OR+homicide+OR+shooting&restrict_sr=on&sort=new&t=year", type: "unverified", sourceName: "Reddit r/Hamilton" },
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+(shooting+OR+stabbing+OR+arrest+OR+investigation+OR+assault+OR+homicide)+when:6m&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Official Police Dispatch" },
  // Public social web search query tracking public Facebook/Instagram safety reports indexed in news/search
  { url: "https://news.google.com/rss/search?q=Hamilton+(site:facebook.com+OR+site:instagram.com)+(safety+OR+needle+OR+encampment+OR+police+OR+assault)+when:1m&hl=en-CA&gl=CA&ceid=CA:en", type: "unverified", sourceName: "Public Social Feed" }
];

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

async function aiVerifyAndExtract(item, feedType, sourceName) {
  const title = (item.title || "").toLowerCase();
  const rawSnippet = (item.contentSnippet || item.content || "").toLowerCase();
  const leadText = title + " " + rawSnippet.substring(0, 200);

  const urlLower = (item.link || '').toLowerCase();
  if (urlLower.includes('/archive') || urlLower.includes('/tag') || urlLower.includes('/search') || urlLower.includes('/category')) {
    return null; 
  }

  // Use Groq's free LLM inference to validate safety relevance and weed out noise instantly
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are a strict safety data classifier. Reply ONLY with JSON: {\"valid\": true/false, \"category\": \"emergency\"|\"verified\"|\n\"news\"|\"unverified\"}"
        },
        {
          role: "user",
          content: `Analyze this text for explicit verified safety hazards, drug use, needles, tents, assaults, or police incidents in Hamilton: "${leadText}"`
        }
      ],
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
      max_tokens: 50
    });

    const result = JSON.parse(chatCompletion.choices[0]?.message?.content || "{\"valid\": false}");
    if (!result.valid) return null;
    
    if (result.category) feedType = result.category;
  } catch (e) {
    // Fallback if API rate limit is ever approached
    const blacklist = ['rent', 'gym', 'school', 'student', 'ticats', 'argonauts', 'football', 'hockey', 'tickets'];
    if (blacklist.some(term => leadText.includes(term))) return null;
  }

  let matchedCorridor = null;
  for (const corridor of EXACT_STREET_WHITELIST) {
    if (corridor.names.some(streetName => leadText.includes(streetName))) {
      matchedCorridor = corridor;
      break;
    }
  }

  // Zero-Tolerance Policy: Strict location matching required
  if (!matchedCorridor) return null;

  let articleDate = item.pubDate ? new Date(item.pubDate) : new Date();
  if (isNaN(articleDate.getTime())) articleDate = new Date();

  let cleanDesc = (item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").substring(0, 160) + '...';

  return {
    category: feedType,
    lat: matchedCorractor.lat,
    lng: matchedCorractor.lng,
    source: `${sourceName} • ${matchedCorridor.name}`,
    description: cleanDesc,
    url: String(item.link),
    timestamp: admin.firestore.Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Running Groq-powered multi-source ingestion...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 40)) {
        const intel = await aiVerifyAndExtract(item, feed.type, feed.sourceName);
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
        console.log(`[Groq Verified Pin] ${intel.category} -> ${intel.source}`);
      }
    } catch (e) {
      console.error(`Feed Error:`, e.message);
    }
  }
  console.log(`Ingestion complete. Deployed ${count} AI-verified pins.`);
}

run().catch(err => {
  console.error("Critical Error:", err);
  process.exit(1);
});
