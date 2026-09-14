'use strict';

/*
 * WetFloorWatch - production-oriented ingestion worker
 *
 * Design principles:
 *   1. Never fabricate an incident.
 *   2. Never fabricate coordinates.
 *   3. Never retain residential house numbers when a location can be
 *      represented by an intersection / road / neighbourhood.
 *   4. Never substitute a homepage for a missing source URL.
 *   5. Historical ingestion is performed from real source archives/feeds.
 *   6. Geocoding is cached and throttled.
 *
 * Required:
 *   npm i firebase-admin rss-parser cheerio groq-sdk
 *
 * Environment:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
 *   GROQ_API_KEY=...
 *
 * Optional:
 *   FIRESTORE_COLLECTION=incidents
 *   NOMINATIM_URL=https://nominatim.openstreetmap.org/search
 *   NOMINATIM_USER_AGENT=WetFloorWatch/1.0 contact@example.com
 *   HAMILTON_POLICE_ARCHIVE=https://hamiltonpolice.on.ca/news/?h=1
 *   HISTORY_DAYS=730
 *   GROQ_MODEL=llama-3.3-70b-versatile
 *
 * Feed URLs:
 *   RSS_FEEDS='[
 *     {"name":"Hamilton Police","url":"https://hamiltonpolice.on.ca/news/feed/en-ca","type":"police"},
 *     {"name":"Hamilton Reddit","url":"...","type":"community"}
 *   ]'
 *
 * NOTE:
 * The Hamilton Police RSS endpoint is XML. Some HTTP tooling rejects it,
 * so this worker also has an HTML archive fallback.
 */

const Parser = require('rss-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');
const admin = require('firebase-admin');

let Groq = null;
try {
  Groq = require('groq-sdk');
} catch (_) {
  // Groq is optional. The ingestion pipeline remains deterministic without it.
}

const parser = new Parser({
  timeout: 20_000,
  headers: {
    'User-Agent': 'WetFloorWatch/1.0'
  }
});

const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 730);
const COLLECTION = process.env.FIRESTORE_COLLECTION || 'incidents';

const NOMINATIM_URL =
  process.env.NOMINATIM_URL ||
  'https://nominatim.openstreetmap.org/search';

const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ||
  'WetFloorWatch/1.0 (configure NOMINATIM_USER_AGENT with a contact address)';

const HAMILTON_POLICE_ARCHIVE =
  process.env.HAMILTON_POLICE_ARCHIVE ||
  'https://hamiltonpolice.on.ca/news/?h=1';

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  'llama-3.3-70b-versatile';

const HAMILTON_BOUNDS = {
  minLat: 43.05,
  maxLat: 43.55,
  minLon: -80.25,
  maxLon: -79.55
};

function initFirebase() {
  if (admin.apps.length) return admin.firestore();

  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error(
      'Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable.'
    );
  }

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  return admin.firestore();
}

const db = initFirebase();

const groq =
  Groq && process.env.GROQ_API_KEY
    ? new Groq({ apiKey: process.env.GROQ_API_KEY })
    : null;

/* ------------------------------------------------------------------ */
/* Utilities                                                          */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeWhitespace(value = '') {
  return String(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(value, base) {
  try {
    if (!value) return null;

    const u = new URL(value, base);

    if (!['http:', 'https:'].includes(u.protocol)) {
      return null;
    }

    return u.href;
  } catch {
    return null;
  }
}

function isHamiltonCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= HAMILTON_BOUNDS.minLat &&
    lat <= HAMILTON_BOUNDS.maxLat &&
    lon >= HAMILTON_BOUNDS.minLon &&
    lon <= HAMILTON_BOUNDS.maxLon
  );
}

function incidentId(sourceUrl, publishedAt, title) {
  return crypto
    .createHash('sha256')
    .update(
      [
        sourceUrl || '',
        publishedAt || '',
        title || ''
      ].join('|')
    )
    .digest('hex');
}

function cutoffDate() {
  return new Date(
    Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000
  );
}

/* ------------------------------------------------------------------ */
/* Privacy                                                            */
/* ------------------------------------------------------------------ */

/*
 * We deliberately avoid storing:
 *   - personal names where they aren't necessary
 *   - house numbers
 *   - phone numbers
 *   - emails
 *   - exact residential addresses
 *
 * Public intersections and public facilities can remain.
 */

function scrubPII(text = '') {
  let result = String(text);

  // Emails
  result = result.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    '[redacted]'
  );

  // Phone numbers
  result = result.replace(
    /\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-])\d{3}[\s.-]\d{4}\b/g,
    '[redacted]'
  );

  // Canadian postal codes
  result = result.replace(
    /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi,
    '[postal code redacted]'
  );

  return normalizeWhitespace(result);
}

function removeHouseNumbers(location = '') {
  return normalizeWhitespace(
    String(location)
      .replace(/^\s*\d{1,5}\s+/, '')
      .replace(/\b\d{1,5}\s+(?=[A-Za-z])/g, '')
  );
}

/* ------------------------------------------------------------------ */
/* Classification                                                     */
/* ------------------------------------------------------------------ */

const CATEGORY_RULES = [
  ['shooting', /\bshooting|gunfire|shots fired|firearm|bullet\b/i],
  ['assault', /\bassault|stabbing|attack|violent attack\b/i],
  ['collision', /\bcollision|crash|vehicle struck|pedestrian struck\b/i],
  ['fire', /\bfire|arson|structure fire\b/i],
  ['drug', /\bdrug|fentanyl|opioid|trafficking|overdose\b/i],
  ['theft', /\btheft|stolen|robbery|break.?in|break and enter\b/i],
  ['missing-person', /\bmissing person\b/i],
  ['hazard', /\bhazard|danger|unsafe|road closure|spill\b/i],
  ['suspicious', /\bsuspicious\b/i]
];

function classify(title, summary) {
  const text = `${title} ${summary}`;

  for (const [category, expression] of CATEGORY_RULES) {
    if (expression.test(text)) return category;
  }

  return 'community-safety';
}

/* ------------------------------------------------------------------ */
/* Hamilton location extraction                                       */
/* ------------------------------------------------------------------ */

function extractIntersection(text = '') {
  const clean = normalizeWhitespace(text);

  /*
   * Examples this recognizes:
   *   Main Street West and Frid Street
   *   Queenston Road / Parkdale Avenue
   *   Upper Centennial Parkway and Green Mountain Road
   *
   * It intentionally does not convert arbitrary numbers into coordinates.
   */

  const match = clean.match(
    /\b([A-Z][A-Za-z.'’-]{1,40}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Parkway|Pkwy|Crescent|Cres|Lane|Ln|Court|Ct|Way|Place|Pl|Trail|Highway|Hwy)(?:\s+(?:North|South|East|West))?)\s+(?:and|at|\/|&)\s+([A-Z][A-Za-z.'’-]{1,40}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Parkway|Pkwy|Crescent|Cres|Lane|Ln|Court|Ct|Way|Place|Pl|Trail|Highway|Hwy)(?:\s+(?:North|South|East|West))?)/i
  );

  if (!match) return null;

  return `${removeHouseNumbers(match[1])} & ${removeHouseNumbers(
    match[2]
  )}, Hamilton, Ontario, Canada`;
}

/* ------------------------------------------------------------------ */
/* Optional LLM extraction                                           */
/* ------------------------------------------------------------------ */

async function extractWithGroq(title, summary) {
  if (!groq) return null;

  const prompt = `
You are a location extraction component for a safety-awareness application.

Return ONLY valid JSON.

Rules:
- Determine whether the report is actually about Hamilton, Ontario.
- Never invent an intersection.
- Never infer coordinates.
- Prefer a public intersection or public facility.
- If only a residential street address is available, return null for location.
- Do not return personal names.
- Do not return coordinates.

Schema:
{
  "isHamilton": true,
  "category": "shooting|assault|collision|fire|drug|theft|missing-person|hazard|suspicious|community-safety",
  "locationText": "intersection or public place, or null",
  "confidence": 0.0
}

TITLE:
${title}

SUMMARY:
${summary}
`;

  try {
    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are a deterministic information extraction service.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const content =
      response.choices?.[0]?.message?.content || '';

    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');

    if (start < 0 || end <= start) return null;

    const parsed = JSON.parse(
      content.slice(start, end + 1)
    );

    if (
      parsed.isHamilton !== true ||
      typeof parsed.confidence !== 'number' ||
      parsed.confidence < 0.75
    ) {
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn(
      'Groq extraction failed:',
      error.message
    );

    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Geocoding                                                          */
/* ------------------------------------------------------------------ */

/*
 * IMPORTANT:
 * This cache exists to prevent repeated requests.
 *
 * For a serious production deployment, replace public Nominatim with
 * your own Nominatim instance or a commercial geocoder with appropriate
 * licensing/SLA.
 */

const geocodeCache = new Map();
let lastGeocodeAt = 0;

async function geocodeHamilton(locationText) {
  if (!locationText) return null;

  const query = removeHouseNumbers(locationText);

  if (geocodeCache.has(query)) {
    return geocodeCache.get(query);
  }

  const elapsed = Date.now() - lastGeocodeAt;

  if (elapsed < 1100) {
    await sleep(1100 - elapsed);
  }

  lastGeocodeAt = Date.now();

  const url = new URL(NOMINATIM_URL);

  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('q', query);
  url.searchParams.set('countrycodes', 'ca');

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': NOMINATIM_USER_AGENT,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(
        `Nominatim HTTP ${response.status}`
      );
    }

    const results = await response.json();

    const candidate = results?.[0];

    if (!candidate) {
      geocodeCache.set(query, null);
      return null;
    }

    const lat = Number(candidate.lat);
    const lon = Number(candidate.lon);

    if (!isHamiltonCoordinate(lat, lon)) {
      geocodeCache.set(query, null);
      return null;
    }

    const result = {
      lat,
      lon,
      displayName: candidate.display_name || query
    };

    geocodeCache.set(query, result);

    return result;
  } catch (error) {
    console.warn(
      `Geocoding failed for "${query}":`,
      error.message
    );

    geocodeCache.set(query, null);

    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Feed ingestion                                                     */
/* ------------------------------------------------------------------ */

function parseFeedItem(item, feed) {
  const sourceUrl =
    absoluteUrl(
      item.link ||
        item.guid ||
        item.id,
      feed.url
    );

  if (!sourceUrl) {
    // A record without its actual source is not accepted.
    return null;
  }

  const title = normalizeWhitespace(
    item.title || 'Untitled report'
  );

  const summary = scrubPII(
    normalizeWhitespace(
      item.contentSnippet ||
        item.content ||
        item.summary ||
        ''
    )
  );

  const publishedAt =
    item.isoDate ||
    item.pubDate ||
    item.published ||
    null;

  const date =
    publishedAt
      ? new Date(publishedAt)
      : null;

  if (
    date &&
    !Number.isNaN(date.getTime()) &&
    date < cutoffDate()
  ) {
    return null;
  }

  return {
    title,
    summary,
    sourceUrl,
    publishedAt: date?.toISOString() || null,
    source: feed.name,
    sourceType: feed.type || 'rss'
  };
}

async function ingestRSSFeed(feed) {
  console.log(`RSS: ${feed.name}`);

  try {
    const parsed = await parser.parseURL(feed.url);

    return parsed.items
      .map(item => parseFeedItem(item, feed))
      .filter(Boolean);
  } catch (error) {
    console.warn(
      `RSS failed for ${feed.name}:`,
      error.message
    );

    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Hamilton Police archive fallback                                   */
/* ------------------------------------------------------------------ */

async function ingestHamiltonPoliceArchive() {
  console.log('Hamilton Police archive');

  const response = await fetch(
    HAMILTON_POLICE_ARCHIVE,
    {
      headers: {
        'User-Agent': 'WetFloorWatch/1.0'
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Hamilton Police archive HTTP ${response.status}`
    );
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const results = [];
  const cutoff = cutoffDate();

  $('a').each((_, anchor) => {
    const href = $(anchor).attr('href');
    const text = normalizeWhitespace(
      $(anchor).text()
    );

    if (!href || !text) return;

    const sourceUrl = absoluteUrl(
      href,
      HAMILTON_POLICE_ARCHIVE
    );

    if (!sourceUrl) return;

    /*
     * Archive pages contain many navigation links.
     * Actual article links generally have a meaningful title.
     */
    const looksLikeArticle =
      text.length >= 12 &&
      !/read more|rss feed|search|filter|archive/i.test(text);

    if (!looksLikeArticle) return;

    const containerText = normalizeWhitespace(
      $(anchor)
        .closest('article, li, div')
        .text()
    );

    const dateMatch =
      containerText.match(
        /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/i
      );

    let publishedAt = null;

    if (dateMatch) {
      const candidate = new Date(
        dateMatch[0]
      );

      if (!Number.isNaN(candidate.getTime())) {
        publishedAt = candidate.toISOString();

        if (candidate < cutoff) {
          return;
        }
      }
    }

    results.push({
      title: text,
      summary: scrubPII(
        containerText.slice(0, 1500)
      ),
      sourceUrl,
      publishedAt,
      source: 'Hamilton Police Service',
      sourceType: 'police'
    });
  });

  /*
   * De-duplicate links discovered more than once.
   */
  return [
    ...new Map(
      results.map(item => [
        item.sourceUrl,
        item
      ])
    ).values()
  ];
}

/* ------------------------------------------------------------------ */
/* Normalize + enrich                                                  */
/* ------------------------------------------------------------------ */

async function enrichRecord(raw) {
  const summary = scrubPII(raw.summary);
  const title = scrubPII(raw.title);

  let extracted = null;

  if (groq) {
    extracted = await extractWithGroq(
      title,
      summary
    );
  }

  if (
    extracted &&
    extracted.isHamilton !== true
  ) {
    return null;
  }

  const locationText =
    extracted?.locationText ||
    extractIntersection(
      `${title} ${summary}`
    );

  /*
   * If we cannot establish a real location,
   * retain the source record but do not map it.
   */
  const coordinates =
    locationText
      ? await geocodeHamilton(locationText)
      : null;

  const category =
    extracted?.category ||
    classify(title, summary);

  const id = incidentId(
    raw.sourceUrl,
    raw.publishedAt,
    title
  );

  return {
    id,

    title,
    summary,

    category,

    source: raw.source,
    sourceType: raw.sourceType,

    /*
     * This is the actual originating article/feed URL.
     * There is deliberately NO fallback URL.
     */
    sourceUrl: raw.sourceUrl,

    publishedAt: raw.publishedAt
      ? new Date(raw.publishedAt)
      : null,

    locationText: locationText || null,

    coordinates: coordinates
      ? {
          lat: coordinates.lat,
          lon: coordinates.lon
        }
      : null,

    /*
     * Only records with actual coordinates should appear
     * as mapped incidents.
     */
    mapped: Boolean(coordinates),

    geocodeDisplayName:
      coordinates?.displayName || null,

    verifiedLocation:
      Boolean(coordinates),

    importedAt:
      admin.firestore.FieldValue.serverTimestamp(),

    updatedAt:
      admin.firestore.FieldValue.serverTimestamp()
  };
}

/* ------------------------------------------------------------------ */
/* Firestore                                                           */
/* ------------------------------------------------------------------ */

async function writeRecord(record) {
  if (!record?.id || !record?.sourceUrl) {
    return;
  }

  /*
   * Firestore document ID is deterministic.
   * Running the seeder repeatedly therefore updates rather than
   * multiplying duplicate incidents.
   */
  await db
    .collection(COLLECTION)
    .doc(record.id)
    .set(record, { merge: true });
}

async function processRawRecords(records) {
  let processed = 0;
  let mapped = 0;
  let skipped = 0;

  for (const raw of records) {
    try {
      const record = await enrichRecord(raw);

      if (!record) {
        skipped++;
        continue;
      }

      await writeRecord(record);

      processed++;

      if (record.mapped) {
        mapped++;
      }

      console.log(
        `${record.mapped ? 'MAP' : 'TEXT'} ${record.category}: ${record.title}`
      );
    } catch (error) {
      skipped++;

      console.warn(
        'Record processing failed:',
        error.message
      );
    }
  }

  return {
    processed,
    mapped,
    skipped
  };
}

/* ------------------------------------------------------------------ */
/* Instagram                                                          */
/* ------------------------------------------------------------------ */

/*
 * Do NOT scrape Instagram HTML and pretend it is an RSS feed.
 *
 * Instagram's supported API requires appropriate authentication and
 * permissions. The application therefore accepts a genuine feed/API
 * adapter through:
 *
 *   INSTAGRAM_FEED_URL
 *
 * The returned entries must contain their real permalink.
 *
 * This prevents the common failure mode where every card links to
 * instagram.com instead of the actual post.
 */

async function ingestInstagramFeed() {
  const feedUrl =
    process.env.INSTAGRAM_FEED_URL;

  if (!feedUrl) {
    console.log(
      'Instagram: no supported feed configured; skipping.'
    );

    return [];
  }

  const feed = {
    name: '@interventionintersection2026',
    url: feedUrl,
    type: 'instagram'
  };

  return ingestRSSFeed(feed);
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(
    `WetFloorWatch ingestion starting; historical depth=${HISTORY_DAYS} days`
  );

  const feeds = [];

  if (process.env.RSS_FEEDS) {
    try {
      const configured =
        JSON.parse(process.env.RSS_FEEDS);

      if (Array.isArray(configured)) {
        feeds.push(...configured);
      }
    } catch (error) {
      throw new Error(
        `Invalid RSS_FEEDS JSON: ${error.message}`
      );
    }
  }

  const [rssRecords, policeRecords, instagramRecords] =
    await Promise.all([
      Promise.all(
        feeds.map(ingestRSSFeed)
      ).then(groups => groups.flat()),

      ingestHamiltonPoliceArchive(),

      ingestInstagramFeed()
    ]);

  const allRecords = [
    ...rssRecords,
    ...policeRecords,
    ...instagramRecords
  ];

  const unique = [
    ...new Map(
      allRecords
        .filter(item => item?.sourceUrl)
        .map(item => [
          `${item.sourceUrl}|${item.title}`,
          item
        ])
    ).values()
  ];

  console.log(
    `Collected ${unique.length} unique source records.`
  );

  const result =
    await processRawRecords(unique);

  console.log(
    JSON.stringify(
      {
        ok: true,
        historyDays: HISTORY_DAYS,
        collected: unique.length,
        ...result
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
