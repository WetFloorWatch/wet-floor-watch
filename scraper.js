const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const Parser = require("rss-parser");
const Groq = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// AI Layers: Groq for bulk processing, Gemini strictly rate-limited
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

let geminiCallCount = 0;
const MAX_GEMINI_CALLS = 3; // Strict daily quota enforcement

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

// Expanded multi-source feed array covering social media, local news, and official dispatches
const FEEDS = [
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=drug+OR+encampment+OR+needle+OR+police+OR+assault+OR+stabbing+OR+homicide+OR+shooting&restrict_sr=on&sort=new&t=year", type: "unverified", sourceName: "Reddit r/Hamilton" },
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+OR+%22Hamilton+Police+Service%22+(shooting+OR+stabbing+OR+arrest+OR+investigation+OR+assault+OR+homicide)+when:6m&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Official Police Dispatch" },
  { url: "https://news.google.com/rss/search?q=Hamilton+(site:facebook.com+OR+site:instagram.com)+(safety+OR+needle+OR+encampment+OR+police+OR+assault+OR+shooting)+when:1m&hl=en-CA&gl=CA&ceid=CA:en", type: "unverified", sourceName: "Public Social Feed (FB/IG)" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+(shooting+OR+stabbing+OR+police+OR+fire+OR+EMS+OR+drug+OR+encampment)+when:1m&hl=en-CA&gl=CA&ceid=CA:en", type: "news", sourceName: "Local News Network" }
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

async function evaluateWithAI(leadText) {
  // 1. Process via Groq (Free, 14,400 req/day)
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: "Reply ONLY with JSON: {\"valid\": true, \"category\": \"emergency\"}" },
        { role: "user", content: `Analyze text for explicit Hamilton safety threats, drugs, needles, tents, assaults, police: "${leadText}"` }
      ],
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
      max_tokens: 40
    });
    const res = JSON.parse(chatCompletion.choices[0]?.message?.content.replace(/```json/g, "").replace(/```/g, "").trim() || "{\"valid\": false}");
    if (res.valid) return res.category;
  } catch (e) {}

  // 2. Fallback to Gemini IF under strict daily call limit
  if (geminiCallCount < MAX_GEMINI_CALLS) {
    try {
      geminiCallCount++;
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Is this a verified Hamilton safety threat, drug incident, encampment, or emergency? Reply JSON: {"valid": true, "category": "emergency"}. Text: "${leadText}"`
      });
      const geminiRes = JSON.parse(response.text().replace(/```json/g, "").replace(/```/g, "").trim());
      if (geminiRes.valid) return geminiRes.category;
    } catch (e) {}
  }

  return null;
}

async function verifyAndExtract(item, feedType, sourceName) {
  const title = (item.title || "").toLowerCase();
  const rawSnippet = (item.contentSnippet || item.content || "").toLowerCase();
  const leadText = title + " " + rawSnippet.substring(0, 200);

  const urlLower = (item.link || '').toLowerCase();
  if (urlLower.includes('/archive') || urlLower.includes('/tag') || urlLower.includes('/search') || urlLower.includes('/category')) {
    return null; 
  }

  const verifiedCategory = await evaluateWithAI(leadText);
  if (!verifiedCategory) return null;

  let matchedCorridor = null;
  for (const corridor of EXACT_STREET_WHITELIST) {
    if (corridor.names.some(streetName => leadText.includes(streetName))) {
      matchedCorridor = corridor;
      break;
    }
  }

  // Zero-Guesswork Location Policy: Discard if exact street is not in lead text
  if (!matchedCorridor) return null;

  let articleDate = item.pubDate ? new Date(item.pubDate) : new Date();
  if (isNaN(articleDate.getTime())) articleDate = new Date();

  return {
    category: verifiedCategory,
    lat: matchedCorridor.lat,
    lng: matchedCorridor.lng,
    source: `${sourceName} • ${matchedCorridor.name}`,
    description: (item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").substring(0, 160) + '...',
    url: String(item.link),
    timestamp: Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Running Multi-Source Hybrid Ingestion (Groq + Rate-Limited Gemini)...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 25)) {
        const intel = await verifyAndExtract(item, feed.type, feed.sourceName);
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
          createdAt: FieldValue.serverTimestamp(),
          active: true
        });

        count++;
        console.log(`[Multi-Source Pin] ${intel.category} -> ${intel.source}`);
      }
    } catch (e) {
      console.error(`Feed Error:`, e.message);
    }
  }
  console.log(`Ingestion complete. Deployed ${count} verified items. Gemini calls used: ${geminiCallCount}/${MAX_GEMINI_CALLS}`);
}

run().catch(err => {
  console.error("Critical Error:", err);
  process.exit(1);
});
