const admin = require("firebase-admin");
const Parser = require("rss-parser");
const { GoogleGenAI } = require("@google/genai");

// Initialize Firebase Admin securely from GitHub Secret
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

// Fixed: Added custom headers so CBC and other feeds don't return 406 errors
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const FEEDS = [
  "https://rss.cbc.ca/lineup/canada-hamilton.xml"
];

async function run() {
  console.log("Starting maxed-out Greater Hamilton safety intelligence scraper...");
  let totalProcessed = 0;

  for (const feedUrl of FEEDS) {
    try {
      console.log(`Parsing feed: ${feedUrl}`);
      const feed = await parser.parseURL(feedUrl);
      
      for (const item of (feed.items || []).slice(0, 35)) {
        const docId = encodeURIComponent(item.link || item.guid || item.title);
        const docRef = db.collection("reports").doc(docId);
        
        if ((await docRef.get()).exists) {
          continue;
        }

        const textToAnalyze = `${item.title}. ${item.contentSnippet || item.content || ""}`;
        
        const prompt = `Analyze this news item for Greater Hamilton, Ontario: "${textToAnalyze}". 
        Extract a precise real-world street address, intersection, or landmark anywhere across Greater Hamilton (including Downtown, Stoney Creek, Ancaster, Dundas, Waterdown, Flamborough, or the Hamilton Mountain). 
        Determine if it relates to public safety, crime, road work, transit incidents, or hazards. 
        Return ONLY a valid JSON object with these exact keys:
        - "address": string (street location description)
        - "category": string (strictly one of: 'shootings', 'assaults', 'drugs', 'emergency')
        - "lat": number (precise latitude anywhere within Greater Hamilton bounds ~43.12 to 43.50)
        - "lng": number (precise longitude anywhere within Greater Hamilton bounds ~-80.35 to -79.50)
        - "severity": string (strictly one of: 'low', 'medium', 'high')
        - "valid": boolean (true only if it is genuinely located in Greater Hamilton and pertains to safety, hazards, or incidents, false otherwise)`;

        try {
          const result = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: { responseMimeType: "application/json" }
          });

          const responseText = result.text.replace(/```json|```/g, "").trim();
          const report = JSON.parse(responseText);

          if (!report.valid || typeof report.lat !== 'number' || typeof report.lng !== 'number') {
            continue;
          }

          const lat = Number(report.lat);
          const lng = Number(report.lng);
          if (isNaN(lat) || isNaN(lng) || lat < 43.12 || lat > 43.50 || lng < -80.35 || lng > -79.50) {
            console.warn(`[Skipped] Coordinates out of Greater Hamilton bounds: [${lat}, ${lng}]`);
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
