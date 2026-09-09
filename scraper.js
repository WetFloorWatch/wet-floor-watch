const admin = require("firebase-admin");
const Parser = require("rss-parser");
const { GoogleGenAI } = require("@google/genai");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const FEEDS = [
  "https://www.cbc.ca/webfeed/rss/rss-canada-hamiltonnews"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to retry API calls if Google servers throw a 503 or temporary overload
async function generateWithRetry(prompt, retries = 3, delay = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      return result.text;
    } catch (err) {
      if ((err.status === 503 || err.status === 429) && i < retries - 1) {
        console.warn(`[API Busy/Unavailable] Retrying in ${delay / 1000}s... (${i + 1}/${retries})`);
        await sleep(delay);
        delay *= 2; // Exponential backoff
      } else {
        throw err;
      }
    }
  }
}

async function run() {
  console.log("Starting resilient Greater Hamilton safety intelligence scraper...");
  let totalProcessed = 0;

  for (const feedUrl of FEEDS) {
    try {
      console.log(`Parsing feed: ${feedUrl}`);
      const feed = await parser.parseURL(feedUrl);
      
      // Increased to 8 items per run now that pacing is stable
      for (const item of (feed.items || []).slice(0, 8)) {
        const docId = encodeURIComponent(item.link || item.guid || item.title);
        const docRef = db.collection("reports").doc(docId);
        
        if ((await docRef.get()).exists) {
          console.log(`[Skipped - Already Exists]: ${item.title}`);
          continue;
        }

        const textToAnalyze = `${item.title}. ${item.contentSnippet || item.content || ""}`;
        
        const prompt = `Analyze this news item for Greater Hamilton or surrounding regional areas (Niagara, Halton, Toronto, or Hamilton proper): "${textToAnalyze}". 
        Extract a real-world street address, intersection, highway stretch, school zone, or landmark within or adjacent to Greater Hamilton. 
        Broadly include public safety, crime, police traffic blitzes, road work, transit disruptions, hazards, or weather/flooding warnings. 
        Return ONLY a valid JSON object with these exact keys:
        - "address": string (street location or region description)
        - "category": string (strictly one of: 'shootings', 'assaults', 'drugs', 'emergency')
        - "lat": number (precise latitude within regional bounds ~43.12 to 43.50)
        - "lng": number (precise longitude within regional bounds ~-80.35 to -79.50)
        - "severity": string (strictly one of: 'low', 'medium', 'high')
        - "valid": boolean (true if it relates to safety, traffic enforcement, road work, hazards, or public alerts; false only for pure sports, entertainment, or irrelevant fluff)`;

        try {
          const responseText = await generateWithRetry(prompt);
          const report = JSON.parse(responseText.replace(/```json|```/g, "").trim());

          if (!report.valid || typeof report.lat !== 'number' || typeof report.lng !== 'number') {
            console.log(`[AI Filtered Out]: ${item.title}`);
            continue;
          }

          const lat = Number(report.lat);
          const lng = Number(report.lng);
          if (isNaN(lat) || isNaN(lng) || lat < 43.12 || lat > 43.50 || lng < -80.35 || lng > -79.50) {
            console.warn(`[Skipped] Coordinates out of bounds: [${lat}, ${lng}]`);
            continue;
          }

          const allowedCategories = ['shootings', 'assaults', 'drugs', 'emergency'];
          let category = String(report.category || 'emergency').toLowerCase().trim();
          if (!allowedCategories.includes(category)) category = 'emergency';

          const allowedSeverities = ['low', 'medium', 'high'];
          let severity = String(report.severity || 'medium').toLowerCase().trim();
          if (!allowedSeverities.includes(severity)) severity = 'medium';

          await docRef.set({
            category: category,
            source: `Verified News Feed (${report.address || 'Hamilton Region'})`,
            description: String(item.title || 'Public safety report'),
            lat: lat,
            lng: lng,
            severity: severity,
            url: String(item.link || 'https://www.hamilton.ca/'),
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            active: true
          });

          totalProcessed++;
          console.log(`[Success] Mapped verified news pin: ${item.title} at [${lat}, ${lng}]`);
        } catch (parseErr) {
          console.warn(`[AI Parse Skip] Failed to parse item "${item.title}":`, parseErr.message);
        }

        // 12-second delay between items
        console.log("Waiting 12 seconds to respect API rate limits...");
        await sleep(12000);
      }
    } catch (feedErr) {
      console.error(`[Feed Error] Failed to fetch feed ${feedUrl}:`, feedErr.message);
    }
  }

  console.log(`Scraper run complete. Total new intelligence pins added: ${totalProcessed}`);
}

run().catch(err => {
  console.error("Critical Scraper Error:", err);
  process.exit(1);
});
