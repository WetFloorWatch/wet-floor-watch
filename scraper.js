const admin = require("firebase-admin");
const Parser = require("rss-parser");
const { GoogleGenAI } = require("@google/genai");

// Initialize Firebase Admin securely from GitHub Secret
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const parser = new Parser();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = ai.getGenerativeModel({ model: "gemini-2.5-flash" }); // or gemini-3.7-flash

// Expanded RSS feed sources across Greater Hamilton public reporting
const FEEDS = [
  "https://rss.cbc.ca/lineup/canada-hamilton.xml"
  // You can add additional local RSS endpoints here as needed
];

async function run() {
  console.log("Starting maxed-out Hamilton safety intelligence scraper...");
  let totalProcessed = 0;

  for (const feedUrl of FEEDS) {
    try {
      console.log(`Parsing feed: ${feedUrl}`);
      const feed = await parser.parseURL(feedUrl);
      
      // Increased scan capacity to 25 items to maximize active pin generation
      for (const item of (feed.items || []).slice(0, 25)) {
        const docId = encodeURIComponent(item.link || item.guid || item.title);
        const docRef = db.collection("reports").doc(docId);
        
        // Skip already ingested records to optimize execution time and quota
        if ((await docRef.get()).exists) {
          continue;
        }

        const textToAnalyze = `${item.title}. ${item.contentSnippet || item.content || ""}`;
        
        const prompt = `Analyze this news item for Greater Hamilton, Ontario: "${textToAnalyze}". 
        Extract a precise real-world street address or intersection in Greater Hamilton (e.g., James St N, Jackson Square, Beasley Park, Gore Park, etc.). 
        Determine if it relates to public safety, crime, transit incidents, or hazards. 
        Return ONLY a valid JSON object with these exact keys:
        - "address": string (street location description)
        - "category": string (strictly one of: 'shootings', 'assaults', 'drugs', 'emergency')
        - "lat": number (precise latitude within Greater Hamilton bounds ~43.16 to 43.35)
        - "lng": number (precise longitude within Greater Hamilton bounds ~-80.02 to -79.72)
        - "severity": string (strictly one of: 'low', 'medium', 'high')
        - "valid": boolean (true only if it is genuinely located in Hamilton and pertains to safety/incidents, false otherwise)`;

        try {
          const result = await model.generateContent(prompt);
          const responseText = result.response.text().replace(/```json|```/g, "").trim();
          const report = JSON.parse(responseText);

          // Discard items not validated as local safety incidents or missing proper coordinate numbers
          if (!report.valid || typeof report.lat !== 'number' || typeof report.lng !== 'number') {
            continue;
          }

          // Strict coordinate sanitization to ensure pins stay locked inside Greater Hamilton geographic bounds
          const lat = Number(report.lat);
          const lng = Number(report.lng);
          if (isNaN(lat) || isNaN(lng) || lat < 43.15 || lat > 43.35 || lng < -80.1 || lng > -79.6) {
            console.warn(`[Skipped] Coordinates out of Hamilton bounds: [${lat}, ${lng}]`);
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
          console.log(`[Success] Mapped pin: ${item.title} at [${lat}, ${lng}]`);
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
