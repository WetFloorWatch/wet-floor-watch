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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WetFloorWatch/10.0',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

// Highly targeted feeds focusing explicitly on drugs, needles, paraphernalia, encampments, and assaults
const FEEDS = [
  { url: "https://www.reddit.com/r/Hamilton/search.rss?q=drug+OR+needle+OR+paraphernalia+OR+encampment+OR+tent+OR+overdose+OR+assault+OR+stabbing+OR+weapons+OR+harassment&restrict_sr=on&sort=new&t=year", type: "unverified", sourceName: "Reddit r/Hamilton Safety Log" },
  { url: "https://news.google.com/rss/search?q=Hamilton+Ontario+(drug+OR+needle+OR+encampment+OR+overdose+OR+assault+OR+stabbing+OR+weapons+OR+safety)+when:6m&hl=en-CA&gl=CA&ceid=CA:en", type: "news", sourceName: "Local News Watch" },
  { url: "https://news.google.com/rss/search?q=site:hamiltonpolice.on.ca+(drug+OR+weapons+OR+assault+OR+stabbing+OR+arrest+OR+investigation)+when:6m&hl=en-CA&gl=CA&ceid=CA:en", type: "emergency", sourceName: "Hamilton Police Official Log" },
  { url: "https://news.google.com/rss/search?q=Hamilton+(site:facebook.com+OR+site:instagram.com)+(needle+OR+drug+OR+encampment+OR+assault+OR+hazard)+when:3m&hl=en-CA&gl=CA&ceid=CA:en", type: "unverified", sourceName: "Community Social Report" }
];

const EXACT_STREET_WHITELIST = [
  { names: ['james st n', 'james street north', 'james north', 'barton & james', 'james & barton'], name: "James St N & Barton Corridor", lat: 43.2612, lng: -79.8665 },
  { names: ['york', 'bay st', 'bay street', 'shelter'], name: "York Blvd & Bay St Shelter Corridor", lat: 43.2625, lng: -79.8732 },
  { names: ['jackson square', 'king st w', 'king west', 'gore park'], name: "Jackson Square / King St W", lat: 43.2557, lng: -79.8711 },
  { names: ['beasley', 'beasley park'], name: "Beasley Park Encampment Zone", lat: 43.2575, lng: -79.8580 },
  { names: ['hess st', 'hess village'], name: "Hess Village Corridor", lat: 43.2530, lng: -79.8795 },
  { names: ['central memorial', 'Wellington st'], name: "Central Memorial Park", lat: 43.2490, lng: -79.8520 },
  { names: ['ottawa st', 'ottawa street', 'barton & ottawa'], name: "Ottawa St N & Barton", lat: 43.2435, lng: -79.8185 },
  { names: ['main st e', 'victoria ave', 'st. joseph'], name: "Main St E & Victoria Ave", lat: 43.2500, lng: -79.8500 },
  { names: ['gage park', 'gage ave'], name: "Gage Park Sector", lat: 43.2450, lng: -79.8350 },
  { names: ['cannon st', 'mary st'], name: "Cannon St E & Mary St", lat: 43.2600, lng: -79.8660 }
];

async function evaluateWithAI(leadText) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: "You are a strict safety intelligence classifier for public awareness. Reply ONLY with JSON: {\"valid\": true, \"category\": \"emergency\"}" },
        { role: "user", content: `Does this text report open-air drug use, needles, paraphernalia, bent spoons, encampments, tents, assaults, harassment, or street danger in Hamilton? Text: "${leadText}"` }
      ],
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
      max_tokens: 50
    });
    const res = JSON.parse(chatCompletion.choices[0]?.message?.content.replace(/```json/g, "").replace(/```/g, "").trim() || "{\"valid\": false}");
    if (res.valid) return res.category;
  } catch (e) {}

  if (geminiCallCount < MAX_GEMINI_CALLS) {
    try {
      geminiCallCount++;
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Does this report drug use, needles, paraphernalia, tents, assaults, or safety hazards in Hamilton? Reply JSON: {"valid": true, "category": "emergency"}. Text: "${leadText}"`
      });
      const geminiRes = JSON.parse(response.text().replace(/```json/g, "").replace(/```/g, "").trim());
      if (geminiRes.valid) return geminiRes.category;
    } catch (e) {}
  }

  const dangerKeywords = ['drug', 'needle', 'paraphernalia', 'spoon', 'syringe', 'encampment', 'tent', 'overdose', 'substance', 'assault', 'weapon', 'stabbing', 'shooting', 'hazard', 'threat', 'harass', 'police', 'ems'];
  if (dangerKeywords.some(k => leadText.includes(k))) {
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
    lat: matchedCorridor.lat + (Math.random() - 0.5) * 0.0015,
    lng: matchedCorridor.lng + (Math.random() - 0.5) * 0.0015,
    source: `${sourceName} • ${matchedCorridor.name}`,
    description: (item.contentSnippet || item.title || '').replace(/(<([^>]+)>)/gi, "").substring(0, 160) + '...',
    url: String(item.link),
    timestamp: Timestamp.fromDate(articleDate)
  };
}

async function run() {
  console.log("Running High-Density Drug & Safety Awareness Ingestion...");
  let count = 0;

  for (const feed of FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of (parsedFeed.items || []).slice(0, 50)) {
        const intel = await verifyAndExtract(item, feed.type, feed.sourceName);
        if (!intel) continue;

        // Unique MD5 hash based on URL or title to prevent duplicate entries completely
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
        console.log(`[Awareness Pin Mapped] ${intel.category} -> ${intel.source}`);
      }
    } catch (e) {
      console.error(`Feed Error (${feed.url}):`, e.message);
    }
  }
  console.log(`Ingestion complete. Deployed ${count} unique safety and drug awareness pins. Gemini calls used: ${geminiCallCount}/${MAX_GEMINI_CALLS}`);
}

run().catch(err => {
  console.error("Critical Error:", err);
  process.exit(1);
});
