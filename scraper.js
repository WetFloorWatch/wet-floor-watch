const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const Parser = require("rss-parser");
const Groq = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");
const crypto = require("crypto");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

let geminiCallCount = 0;
const MAX_GEMINI_CALLS = 3;

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WetFloorWatch-DeepScrape/11.0',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

// MASSIVE DEEP-SCRAPE FEEDS: Pulling historical (up to 2 years) and multi-platform data
const FEEDS = [
  // Reddit Deep Dives (All Time / Year)
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=drug+OR+needle+OR+paraphernalia+OR+encampment+OR+tent+OR+overdose&restrict_sr=on&sort=new&t=all", type: "unverified", sourceName: "Reddit r/Hamilton (Drugs/Encampments)" },
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=police+OR+assault+OR+stabbing+OR+weapons+OR+harassment+OR+shooting&restrict_sr=on&sort=new&t=all", type: "unverified", sourceName: "Reddit r/Hamilton (Crime/Safety)" },
  { url: "https://www.reddit.com/r/McMaster/search.rss?q=police+OR+assault+OR+safety+OR+robbery&restrict_sr=on&sort=new&t=all", type: "unverified", sourceName: "Reddit r/McMaster (Campus Safety)" },
  
  // Google News Deep Aggregation (Local News, 2 Years)
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+(drug+OR+needle+OR+encampment+OR+overdose)+when:2y&hl=en-CA&gl=CA&ceid=CA:en", type: "news", sourceName: "Local News (Substances/Encampments)" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+(assault+OR+stabbing+OR+weapons+OR+homicide+OR+shooting)+when:2y&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Local News (Violent Crime)" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+(crash+OR+collision+OR+fire+OR+EMS+OR+hazard)+when:1y&hl=en-CA&gl=CA&ceid=CA:en", type: "verified", sourceName: "Local News (Hazards/Fire/EMS)" },
  
  // Official Channels
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police%22+(drug+OR+weapons+OR+assault+OR+stabbing+OR+arrest)+when:2y&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Hamilton Police Official Log" },
  
  // Indexed Social Media (Facebook/Instagram/X public posts indexed by Google)
  { url: "https://news.google.com/rss/search?q=Hamilton+(site:facebook.com+OR+site:instagram.com+OR+site:twitter.com)+(needle+OR+drug+OR+encampment+OR+assault+OR+hazard+OR+police)+when:2y&hl=en-CA&gl=CA&ceid=CA:en", type: "unverified", sourceName: "Public Social Media Watch" }
];

// GREATER HAMILTON AREA (GHA) MASSIVE WHITELIST
// Maps strictly using word boundaries to prevent false positives (e.g., "main" doesn't match "domain")
const EXACT_STREET_WHITELIST = [
  // Lower City & Downtown Core
  { names: ['james st n', 'james north', 'james and barton', 'james st'], name: "James St N Corridor", lat: 43.2612, lng: -79.8665 },
  { names: ['york blvd', 'york boulevard', 'bay st', 'firstontario'], name: "York Blvd & Bay St", lat: 43.2625, lng: -79.8732 },
  { names: ['jackson square', 'king st w', 'king west', 'gore park', 'macnab'], name: "Jackson Square / King St W", lat: 43.2557, lng: -79.8711 },
  { names: ['beasley', 'beasley park', 'mary st', 'elgin'], name: "Beasley Park Zone", lat: 43.2575, lng: -79.8580 },
  { names: ['hess st', 'hess village', 'hess'], name: "Hess Village Corridor", lat: 43.2530, lng: -79.8795 },
  { names: ['central memorial', 'wellington st'], name: "Central Memorial Park", lat: 43.2490, lng: -79.8520 },
  { names: ['ottawa st', 'ottawa street', 'crown point'], name: "Ottawa St N Corridor", lat: 43.2435, lng: -79.8185 },
  { names: ['main st e', 'victoria ave', 'st. joseph'], name: "Main St E & Victoria Ave", lat: 43.2500, lng: -79.8500 },
  { names: ['gage park', 'gage ave', 'delta'], name: "Gage Park Sector", lat: 43.2450, lng: -79.8350 },
  { names: ['cannon st', 'cannon'], name: "Cannon St E", lat: 43.2600, lng: -79.8660 },
  { names: ['barton st', 'barton street', 'barton village', 'woodlands park'], name: "Barton St Corridor", lat: 43.2550, lng: -79.8350 },
  { names: ['locke st', 'locke street', 'locke'], name: "Locke St South", lat: 43.2550, lng: -79.8850 },
  { names: ['durand', 'charlton ave'], name: "Durand Neighborhood", lat: 43.2490, lng: -79.8750 },
  { names: ['westdale', 'mcmaster', 'sterling', 'cootes'], name: "Westdale / McMaster Perimeter", lat: 43.2600, lng: -79.9100 },
  { names: ['queenston rd', 'queenston road', 'eastgate'], name: "Queenston Rd Corridor", lat: 43.2250, lng: -79.7650 },
  { names: ['kenilworth', 'centre mall', 'barton centre'], name: "Kenilworth Ave", lat: 43.2450, lng: -79.8050 },
  { names: ['bayfront', 'pier 4', 'pier 8', 'discovery drive'], name: "Bayfront / Waterfront", lat: 43.2720, lng: -79.8700 },
  
  // Hamilton Mountain
  { names: ['upper james', 'mohawk rd', 'mohawk road'], name: "Upper James & Mohawk", lat: 43.2280, lng: -79.8780 },
  { names: ['upper wellington', 'fennell ave', 'fennell'], name: "Upper Wellington & Fennell", lat: 43.2377, lng: -79.8672 },
  { names: ['upper wentworth', 'lime ridge', 'limeridge', 'linc'], name: "Upper Wentworth / Lime Ridge", lat: 43.2160, lng: -79.8630 },
  { names: ['upper gage', 'rymal rd', 'rymal road'], name: "Upper Gage & Rymal", lat: 43.2000, lng: -79.8350 },
  { names: ['concession st', 'concession street', 'juravinski'], name: "Concession St / Hospital Zone", lat: 43.2350, lng: -79.8400 },
  { names: ['garth st', 'garth', 'stone church'], name: "Garth & Stone Church", lat: 43.2050, lng: -79.9100 },
  
  // Stoney Creek & East
  { names: ['stoney creek', 'hwy 8', 'highway 8'], name: "Stoney Creek (Hwy 8)", lat: 43.2180, lng: -79.7550 },
  { names: ['fruitland', 'fruitland rd'], name: "Fruitland Rd Corridor", lat: 43.2144, lng: -79.7135 },
  { names: ['fifty rd', 'fifty point'], name: "Fifty Rd / Winona", lat: 43.2100, lng: -79.6500 },
  { names: ['candlewood'], name: "Candlewood Dr, Stoney Creek", lat: 43.1751, lng: -79.7829 },
  { names: ['centennial pkwy', 'centennial parkway'], name: "Centennial Pkwy Corridor", lat: 43.2200, lng: -79.7600 },
  
  // Ancaster, Dundas & Waterdown
  { names: ['ancaster', 'wilson st', 'rousseaux'], name: "Ancaster Core", lat: 43.2250, lng: -79.9800 },
  { names: ['meadowlands', 'golf links'], name: "Meadowlands, Ancaster", lat: 43.2280, lng: -79.9400 },
  { names: ['dundas', 'king st w dundas', 'sydenham'], name: "Dundas Core", lat: 43.2660, lng: -79.9550 },
  { names: ['waterdown', 'hwy 5', 'dundas st waterdown'], name: "Waterdown Core", lat: 43.3330, lng: -79.8900 },
  
  // Airport / Glanbrook
  { names: ['mt hope', 'mount hope', 'airport rd'], name: "Mount Hope / Airport", lat: 43.1600, lng: -79.9200 },
  { names: ['binbrook', 'hwy 56'], name: "Binbrook Core", lat: 43.1200, lng: -79.8000 }
];

async function evaluateWithAI(leadText) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: "You are a safety data classifier. Reply ONLY with JSON: {\"valid\": true, \"category\": \"emergency\"}" },
        { role: "user", content: `Analyze text for Hamilton public safety threats (drugs, needles, encampments, assaults, police, fire, EMS, hazards): "${leadText}"` }
      ],
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
      max_tokens: 50
    });
    const res = JSON.parse(chatCompletion.choices[0]?.message?.content.replace(/```json/g, "").replace(/```/g, "").trim() || "{\"valid\": false}");
    if (res.valid) return res.category || 'unverified';
  } catch (e) {}

  if (geminiCallCount < MAX_GEMINI_CALLS) {
    try {
      geminiCallCount++;
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Is this a public safety threat, drug incident, encampment, or emergency in Hamilton? Reply JSON: {"valid": true, "category": "emergency"}. Text: "${leadText}"`
      });
      const geminiRes = JSON.parse(response.text().replace(/```json/g, "").replace(/```/g, "").trim());
      if (geminiRes.valid) return geminiRes.category || 'unverified';
    } catch (e) {}
  }

  // Deep Scrape Keyword Fallback (Captures high-value community reports if AI limits out)
  const dangerKeywords = ['drug', 'needle', 'paraphernalia', 'spoon', 'syringe', 'encampment', 'tent', 'overdose', 'assault', 'weapon', 'stabbing', 'shooting', 'hazard', 'harass', 'police', 'ems', 'fire', 'crash'];
  if (dangerKeywords.some(k => leadText.includes(k))) {
    return 'unverified'; // Default to unverified pin (red) for community chatter
  }

  return null;
}

async function verifyAndExtract(item, feedType, sourceName) {
  const title = (item.title || "").toLowerCase();
  const rawSnippet = (item.contentSnippet || item.content || "").toLowerCase();
  const leadText = title + " " + rawSnippet;

  const urlLower = (item.link || '').toLowerCase();
  if (urlLower.includes('/archive') || urlLower.includes('/tag') || urlLower.includes('/search') || urlLower.includes('/category')) {
    return null; 
  }

  const verifiedCategory = await evaluateWithAI(leadText);
  if (!verifiedCategory) return null;

  let matchedCorridor = null;
  for (const corridor of EXACT_STREET_WHITELIST) {
    // Uses word boundary regex (\b) so "main" doesn't falsely match "domain", ensuring extreme accuracy
    if (corridor.names.some(keyword => new RegExp('\\b' + keyword + '\\b', 'i').test(leadText))) {
      matchedCorridor = corridor;
      break;
    }
  }

  if (!matchedCorridor) return null;

  let articleDate = item.pubDate ? new Date(item.pubDate) : new Date();
  if (isNaN(articleDate.getTime())) articleDate = new Date();

  return {
    category: verifiedCategory,
    // Add micro-offset (.0015 to .0030) so hundreds of pins on the same corridor fan out visually in the heatmap
    lat: matchedCorridor.lat + (Math.random() - 0.5) * 0.0035,
    lng: matchedCorridor.lng + (Math.random() - 0.5) * 0.0035,
    source: `${sourceName} • ${matchedCorridor.name}`,
    description: (item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").substring(0, 180) + '...',
    url: String(item.link),
    timestamp: Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Running Massive GHA Deep Scrape Ingestion...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      // Fetch up to 100 items per feed to deeply populate historical data across Greater Hamilton
      for (const item of (parsedFeed.items || []).slice(0, 100)) {
        const intel = await verifyAndExtract(item, feed.type, feed.sourceName);
        if (!intel) continue;

        const uniqueString = (item.link || item.title) + '-' + intel.source;
        const docId = crypto.createHash('md5').update(uniqueString).digest('hex');

        await db.collection("reports").doc(docId).set({
          category: intel.category,
          source: intel.source,
          description: intel.description,
          lat: intel.lat,
          lng: intel.lng,
          url: intel.url,
          timestamp: intel.timestamp,
          createdAt: FieldValue.serverTimestamp(),
          active: true
        });

        count++;
        console.log(`[Deep Scrape Pin] ${intel.category} -> ${intel.source}`);
      }
    } catch (e) {
      console.error(`Feed Error (${feed.url}):`, e.message);
    }
  }
  console.log(`Deep Scrape Complete. Mapped ${count} unique safety and drug awareness pins across Greater Hamilton. Gemini calls used: ${geminiCallCount}/${MAX_GEMINI_CALLS}`);
}

run().catch(err => {
  console.error("Critical Error:", err);
  process.exit(1);
});
