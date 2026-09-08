const admin = require("firebase-admin");
const Parser = require("rss-parser");
const { GoogleGenAI } = require("@google/genai");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const parser = new Parser();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function run() {
  const feed = await parser.parseURL("https://rss.cbc.ca/lineup/canada-hamilton.xml");
  for (const item of feed.items.slice(0, 5)) {
    const docId = encodeURIComponent(item.link || item.guid);
    const docRef = db.collection("reports").doc(docId);
    if ((await docRef.get()).exists) continue;
    try {
      const textToAnalyze = `${item.title}. ${item.contentSnippet || ""}`;
      const response = await ai.models.generateContent({
        model: "gemini-3.7-flash",
        contents: `Analyze this Hamilton incident: "${textToAnalyze}". Return ONLY a JSON object with keys: address, category (strictly 'shootings', 'assaults', 'drugs', or 'emergency'), lat (number), lng (number), severity (strictly 'low', 'medium', or 'high').`,
        config: { responseMimeType: "application/json" }
      });
      const report = JSON.parse(response.text.replace(/```json|```/g, "").trim());
      await docRef.set({
        category: report.category,
        source: `Scraped News (${report.address})`,
        description: item.title,
        lat: report.lat,
        lng: report.lng,
        severity: report.severity,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`Successfully mapped: ${item.title}`);
    } catch (err) {
      console.error(`Error:`, err.message);
    }
  }
}
run();
