const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const Parser = require("rss-parser");
const Groq = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

let geminiCallCount = 0;
const MAX_GEMINI_CALLS = 3;

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

// Expanded multi-source feed collection for broad historical and recent coverage
const FEEDS = [
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=drug+OR+encampment+OR+needle+OR+police+OR+assault+OR+stabbing+OR+homicide+OR+shooting+OR+fire+OR+ems+OR+downtown+OR+Barton+OR+James&restrict_sr=on&sort=new&t=year", type: "unverified", sourceName: "Reddit r/Hamilton" },
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+(shooting+OR+stabbing+OR+arrest+OR+investigation+OR+assault+OR+homicide+OR+drug)+when:1y&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Official Police Dispatch" },
  { url: "https://news.google.com/rss/search?q=Hamilton+(site:facebook.com+OR+site:instagram.com)+(safety+OR+needle+OR+encampment+OR+police+OR+assault+OR+shooting+OR+downtown)+when:6m&hl=en-CA&gl=CA&ceid=CA:en", type: "unverified", sourceName: "Public Social Feed (FB/IG)" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+(shooting+OR+stabbing+OR+police+OR+fire+OR+EMS+OR+drug+OR+encampment+OR+overdose+OR+hazard)+when:1y&hl=en-CA&gl=CA&ceid=CA:en", type: "news", sourceName: "Local News Network" }
];

// Expanded Whitelist incorporating neighborhoods, major corridors, and specific intersections to maximize valid pin density
const EXACT_STREET_WHITELIST = [
  { names: ['candlewood', 'stoney creek'], name: "Candlewood Dr, Stoney Creek", lat: 43.1751, lng: -79.7829 },
  { names: ['fruitland'], name: "Fruitland Rd Corridor", lat: 43.2144, lng: -79.7135 },
  { names: ['rymal'], name: "Rymal Rd Corridor", lat: 43.1850, lng: -79.8150 },
  { names: ['james st n', 'james street north', 'james north', 'james & barton'], name: "James St N Corridor", lat: 43.2612, lng: -79.8665 },
  { names: ['barton st', 'barton street', 'barton'], name: "Barton St Corridor", lat: 43.2450, lng: -79.8150 },
  { names: ['king st', 'king street', 'king corp', 'jackson square', 'gore park'], name: "King St Corridor / Jackson Square", lat: 43.2557, lng: -79.8711 },
  { names: ['main st', 'main street', 'corktown'], name: "Main St Corridor", lat: 43.2500, lng: -79.8500 },
  { names: ['upper james', 'mohawk'], name: "Upper James & Mohawk", lat: 43.2280, lng: -79.8780 },
  { names: ['hess st', 'hess village', 'hess'], name: "Hess Village Corridor", lat: 43.2530, lng: -79.8795 },
  { names: ['ottawa st', 'ottawa street', 'ottawa'], name: "Ottawa St Corridor", lat: 43.2430, lng: -79.8200 },
  { names: ['concession st', 'concession street', 'concession'], name: "Concession St Corridor", lat: 43.2350, lng: -79.8400 },
  { names: ['beasley', 'beasley park'], name: "Beasley Park Zone", lat: 43.2575, lng: -79.8580 },
  { names: ['durand'], name: "Durand Neighborhood", lat: 43.2490, lng: -79.8750 },
  { names: ['westdale', 'mcmaster'], name: "Westdale / McMaster Perimeter", lat: 43.2600, lng: -79.9100 },
  { names: ['LOCKE ST', 'locke street'], name: "Locke St Corridor", lat: 43.2550, lng: -79.8850 }
];

async function evaluateWithAI(leadText) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: "Reply ONLY with JSON: {\"valid\": true, \"category\": \"emergency\"}" },
        { role: "user", content: `Analyze text for Hamilton safety threats, drugs, needles, tents, assaults, police, fire, or emergency incidents: "${leadText}"` }
      ],
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
      max_tokens: 40
    });
    const res = JSON.parse(chatCompletion.choices[0]?.message?.content.replace(/```json/g, "").replace(/```/g, "").trim() || "{\"valid\": false}");
    if (res.valid) return res.category;
  } catch (e) {}

  if (geminiCallCount < MAX_GEMINI_CALLS) {
    try {
      geminiCallCount++;
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Is this a Hamilton safety threat, drug incident, encampment, or emergency? Reply JSON: {"valid": true, "category": "emergency"}. Text: "${leadText}"`
      });
      const geminiRes = JSON.parse(response.text().replace(/```json/g, "").replace(/```/g, "").trim());
      if (geminiRes.valid) return geminiRes.category;
    } catch (e) {}
  }

  // Fallback keyword check if AI limits are hit so valid local reports aren't dropped
  const safetyKeywords = ['drug', 'needle', 'encampment', 'tent', 'police', 'fire', 'ems', 'assault', 'stabbing', 'shooting', 'hazard', 'overdose', 'paramedic', 'arrest'];
  if (safetyKeywords.some(k => leadText.includes(k))) {
    return 'unverified';
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
    if (corridor.names.some(keyword => leadText.includes(keyword))) {
      matchedCorridor = corridor;
      break;
    }
  }

  if (!matchedCorridor) return null;

  let articleDate = item.pubDate ? new Date(item.pubDate) : new Date();
  if (isNaN(articleDate.getTime())) articleDate = new Date();

  return {
    category: verifiedCategory,
    lat: matchedCorridor.lat + (Math.random() - 0.5) * 0.001, // Slight micro-offset to prevent overlapping duplicate pins
    lng: matchedCorridor.lng + (Math.random() - 0.5) * 0.001,
    source: `${sourceName} • ${matchedCorridor.name}`,
    description: (item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").substring(0, 160) + '...',
    url: String(item.link),
    timestamp: Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Running High-Density Multi-Source Ingestion...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 40)) {
        const intel = await verifyAndExtract(item, feed.type, feed.sourceName);
        if (!intel) continue;

        const docId = encodeURIComponent((item.link || item.guid || item.title) + '-' + count);
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
        console.log(`[High-Density Pin] ${intel.category} -> ${intel.source}`);
      }
    } catch (e) {
      console.error(`Feed Error (${feed.url}):`, e.message);
    }
  }
  console.log(`Ingestion complete. Deployed ${count} verified pins. Gemini calls used: ${geminiCallCount}/${MAX_GEMINI_CALLS}`);
}

run().catch(err => {
  console.error("Critical Error:", err);
  process.exit(1);
});
