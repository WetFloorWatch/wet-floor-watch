'use strict';

/*
 * WetFloorWatch - Hamilton public-safety ingestion worker
 *
 * Production goals:
 *   - Never fabricate incidents.
 *   - Never fabricate coordinates.
 *   - Never intentionally publish residential house numbers.
 *   - Preserve the real direct source URL.
 *   - Keep up to HISTORY_DAYS (default 730) of source records.
 *   - Use official Hamilton Fire ArcGIS geometry directly for Fire incidents.
 *   - Use Groq only for non-Fire location/category extraction.
 *
 * Required:
 *   npm i firebase-admin rss-parser cheerio groq-sdk
 *
 * Environment:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
 *   GROQ_API_KEY=...
 *   NOMINATIM_USER_AGENT="WetFloorWatch/1.0 contact@example.com"
 *
 * Optional:
 *   FIRESTORE_COLLECTION=incidents
 *   HISTORY_DAYS=730
 *   GROQ_MODEL=openai/gpt-oss-120b
 *   HAMILTON_EMS_FEED_URL=https://...
 *   INSTAGRAM_FEED_URL=https://...
 *   RSS_FEEDS='[{"name":"Some Local Source","url":"https://...","type":"news"}]'
 *
 * Built-in news feeds:
 *   Global News Hamilton
 *   CBC Hamilton
 *
 * Built-in official Fire source:
 *   Hamilton Fire Department public ArcGIS incident layer
 */

const Parser = require('rss-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');
const admin = require('firebase-admin');

let Groq = null;

try {
  Groq = require('groq-sdk');
} catch (_) {
  // Groq remains optional; deterministic fallbacks still work.
}

const parser = new Parser({
  timeout: 20_000,
  headers: {
    'User-Agent': 'WetFloorWatch/1.0'
  }
});

const HISTORY_DAYS =
  Number(process.env.HISTORY_DAYS || 730);

const COLLECTION =
  process.env.FIRESTORE_COLLECTION || 'incidents';

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
  'openai/gpt-oss-120b';

const HAMILTON_FIRE_ARCGIS_URL =
  process.env.HAMILTON_FIRE_ARCGIS_URL ||
  'https://services.arcgis.com/v400IkDOw1ad7Yad/ArcGIS/rest/services/Fire_Incidents_Public/FeatureServer/0';

const HAMILTON_BOUNDS = {
  minLat: 43.05,
  maxLat: 43.55,
  minLon: -80.25,
  maxLon: -79.55
};

/*
 * Privacy:
 * The Fire ArcGIS source provides point geometry.
 * We deliberately round published coordinates to approximately
 * street-block scale rather than exposing the raw source point.
 */
const PUBLIC_COORDINATE_DECIMALS = 3;

const BUILTIN_NEWS_FEEDS = [
  {
    name: 'Global News Hamilton',
    url: 'https://globalnews.ca/hamilton/feed',
    type: 'news'
  },
  {
    name: 'CBC Hamilton',
    url: 'https://www.cbc.ca/cmlink/rss-canada-hamiltonnews',
    type: 'news'
  }
];

/* ------------------------------------------------------------------ */
/* Firebase                                                           */
/* ------------------------------------------------------------------ */

function initFirebase() {
  if (admin.apps.length) {
    return admin.firestore();
  }

  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error(
      'Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable.'
    );
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );
  } catch (error) {
    throw new Error(
      `FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  return admin.firestore();
}

const db = initFirebase();

const groq =
  Groq && process.env.GROQ_API_KEY
    ? new Groq({
        apiKey: process.env.GROQ_API_KEY
      })
    : null;

let groqDisabledForRun = false;
let groqFailureLogged = false;

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

function roundCoordinate(
  value,
  decimals = PUBLIC_COORDINATE_DECIMALS
) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function privacySafeCoordinates(lat, lon) {
  const roundedLat = roundCoordinate(lat);
  const roundedLon = roundCoordinate(lon);

  if (
    !isHamiltonCoordinate(
      roundedLat,
      roundedLon
    )
  ) {
    return null;
  }

  return {
    lat: roundedLat,
    lon: roundedLon
  };
}

function incidentId(
  sourceUrl,
  publishedAt,
  title
) {
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
    Date.now() -
      HISTORY_DAYS *
        24 *
        60 *
        60 *
        1000
  );
}

function toISOStringOrNull(value) {
  if (!value) return null;

  const d =
    value instanceof Date
      ? value
      : new Date(value);

  return Number.isNaN(d.getTime())
    ? null
    : d.toISOString();
}

/* ------------------------------------------------------------------ */
/* Privacy                                                            */
/* ------------------------------------------------------------------ */

function scrubPII(text = '') {
  let result = String(text);

  result = result.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    '[redacted]'
  );

  result = result.replace(
    /\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-])\d{3}[\s.-]\d{4}\b/g,
    '[redacted]'
  );

  result = result.replace(
    /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi,
    '[postal code redacted]'
  );

  return normalizeWhitespace(result);
}

function removeHouseNumbers(
  location = ''
) {
  return normalizeWhitespace(
    String(location)
      .replace(/^\s*\d{1,6}\s+/, '')
      .replace(
        /\b\d{1,6}\s+(?=[A-Za-z])/g,
        ''
      )
  );
}

function sanitizeLocationText(
  location = ''
) {
  const clean =
    normalizeWhitespace(
      String(location)
    );

  const withoutNumbers =
    clean
      .replace(
        /^\s*\d{1,6}[-\s]+(?=[A-Za-z])/,
        ''
      )
      .replace(
        /\b(?:unit|apt|apartment|suite|#)\s*[-A-Za-z0-9]+\b/gi,
        ''
      )
      .replace(/\s{2,}/g, ' ')
      .trim();

  return scrubPII(
    withoutNumbers
  );
}

function looksLikePrivateResidentialAddress(
  location = ''
) {
  const text =
    normalizeWhitespace(location);

  if (
    /^\d{1,6}\s+[A-Za-z][^,]*(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Lane|Ln|Crescent|Cres|Court|Ct|Place|Pl|Way|Terrace|Ter|Trail|Close)(?:\b|,)/i.test(
      text
    )
  ) {
    return true;
  }

  if (
    /\b(?:unit|apt|apartment|suite|#)\s*[-A-Za-z0-9]+\b/i.test(
      text
    )
  ) {
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Classification                                                     */
/* ------------------------------------------------------------------ */

const CATEGORY_RULES = [
  [
    'shooting',
    /\bshooting|gunfire|shots fired|firearm|bullet\b/i
  ],
  [
    'assault',
    /\bassault|stabbing|attack|violent attack\b/i
  ],
  [
    'collision',
    /\bcollision|crash|vehicle struck|pedestrian struck|traffic collision\b/i
  ],
  [
    'fire',
    /\bfire|arson|structure fire|building fire\b/i
  ],
  [
    'drug',
    /\bdrug|fentanyl|opioid|trafficking|overdose\b/i
  ],
  [
    'theft',
    /\btheft|stolen|robbery|break.?in|break and enter\b/i
  ],
  [
    'missing-person',
    /\bmissing person\b/i
  ],
  [
    'hazard',
    /\bhazard|danger|unsafe|road closure|spill|gas leak|power line\b/i
  ],
  [
    'suspicious',
    /\bsuspicious\b/i
  ]
];

function classify(
  title,
  summary
) {
  const text =
    `${title} ${summary}`;

  for (
    const [category, expression]
    of CATEGORY_RULES
  ) {
    if (
      expression.test(text)
    ) {
      return category;
    }
  }

  return 'community-safety';
}

/* ------------------------------------------------------------------ */
/* Hamilton location extraction                                       */
/* ------------------------------------------------------------------ */

function extractIntersection(
  text = ''
) {
  const clean =
    normalizeWhitespace(text);

  const match =
    clean.match(
      /\b([A-Z][A-Za-z.'’-]{1,40}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Parkway|Pkwy|Crescent|Cres|Lane|Ln|Court|Ct|Way|Place|Pl|Trail|Highway|Hwy)(?:\s+(?:North|South|East|West))?)\s+(?:and|at|\/|&)\s+([A-Z][A-Za-z.'’-]{1,40}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Parkway|Pkwy|Crescent|Cres|Lane|Ln|Court|Ct|Way|Place|Pl|Trail|Highway|Hwy)(?:\s+(?:North|South|East|West))?)/i
    );

  if (!match) {
    return null;
  }

  return (
    `${removeHouseNumbers(match[1])} & ` +
    `${removeHouseNumbers(match[2])}, ` +
    'Hamilton, Ontario, Canada'
  );
}

/* ------------------------------------------------------------------ */
/* Groq extraction                                                    */
/* ------------------------------------------------------------------ */

async function extractWithGroq(
  title,
  summary
) {
  if (
    !groq ||
    groqDisabledForRun
  ) {
    return null;
  }

  const prompt = `
You are a location extraction component for a Hamilton, Ontario safety-awareness application.

Return ONLY valid JSON.

Rules:
- Determine whether the report is actually about Hamilton, Ontario.
- Never invent an intersection.
- Never infer coordinates.
- Prefer a public intersection or public facility.
- If only a residential street address is available, return null for location.
- Never return personal names.
- Never return coordinates.

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
    const response =
      await groq.chat.completions.create({
        model: GROQ_MODEL,
        temperature: 0,
        response_format: {
          type: 'json_object'
        },
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
      response
        .choices?.[0]
        ?.message
        ?.content || '';

    const parsed =
      JSON.parse(content);

    if (
      parsed.isHamilton !== true ||
      typeof parsed.confidence !== 'number' ||
      parsed.confidence < 0.75
    ) {
      return null;
    }

    return parsed;

  } catch (error) {
    const status =
      error?.status;

    const code =
      error?.error?.code;

    const message =
      String(
        error?.message || ''
      );

    if (
      status === 404 ||
      code === 'model_not_found' ||
      /model.*does not exist|model_not_found/i.test(
        message
      )
    ) {
      groqDisabledForRun = true;

      if (
        !groqFailureLogged
      ) {
        groqFailureLogged = true;

        console.warn(
          `Groq model "${GROQ_MODEL}" is unavailable. ` +
          'Groq extraction is disabled for the remainder of this run; ' +
          'deterministic location/category fallbacks will continue.'
        );
      }

      return null;
    }

    if (
      !groqFailureLogged
    ) {
      groqFailureLogged = true;

      console.warn(
        'Groq extraction failed:',
        message
      );
    }

    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Geocoding                                                         */
/* ------------------------------------------------------------------ */

const geocodeCache =
  new Map();

let lastGeocodeAt = 0;

async function geocodeHamilton(
  locationText
) {
  if (!locationText) {
    return null;
  }

  const query =
    removeHouseNumbers(
      locationText
    );

  if (!query) {
    return null;
  }

  if (
    geocodeCache.has(query)
  ) {
    return geocodeCache.get(
      query
    );
  }

  const elapsed =
    Date.now() -
    lastGeocodeAt;

  if (elapsed < 1100) {
    await sleep(
      1100 - elapsed
    );
  }

  lastGeocodeAt =
    Date.now();

  const url =
    new URL(NOMINATIM_URL);

  url.searchParams.set(
    'format',
    'jsonv2'
  );

  url.searchParams.set(
    'limit',
    '1'
  );

  url.searchParams.set(
    'q',
    query
  );

  url.searchParams.set(
    'countrycodes',
    'ca'
  );

  try {
    const response =
      await fetch(
        url,
        {
          headers: {
            'User-Agent':
              NOMINATIM_USER_AGENT,
            'Accept':
              'application/json'
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        `Nominatim HTTP ${response.status}`
      );
    }

    const results =
      await response.json();

    const candidate =
      results?.[0];

    if (!candidate) {
      geocodeCache.set(
        query,
        null
      );

      return null;
    }

    const lat =
      Number(candidate.lat);

    const lon =
      Number(candidate.lon);

    const coordinates =
      privacySafeCoordinates(
        lat,
        lon
      );

    if (!coordinates) {
      geocodeCache.set(
        query,
        null
      );

      return null;
    }

    const result = {
      ...coordinates,
      displayName:
        candidate.display_name ||
        query
    };

    geocodeCache.set(
      query,
      result
    );

    return result;

  } catch (error) {
    console.warn(
      `Geocoding failed for "${query}":`,
      error.message
    );

    geocodeCache.set(
      query,
      null
    );

    return null;
  }
}

/* ------------------------------------------------------------------ */
/* RSS / feed ingestion                                               */
/* ------------------------------------------------------------------ */

function parseFeedItem(
  item,
  feed
) {
  const sourceUrl =
    absoluteUrl(
      item.link ||
        item.guid ||
        item.id,
      feed.url
    );

  if (!sourceUrl) {
    return null;
  }

  const title =
    normalizeWhitespace(
      item.title ||
        'Untitled report'
    );

  const summary =
    scrubPII(
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
    !Number.isNaN(
      date.getTime()
    ) &&
    date < cutoffDate()
  ) {
    return null;
  }

  return {
    title,
    summary,
    sourceUrl,
    publishedAt:
      toISOStringOrNull(
        publishedAt
      ),
    source: feed.name,
    sourceType:
      feed.type || 'news'
  };
}

async function ingestRSSFeed(
  feed
) {
  console.log(
    `RSS: ${feed.name}`
  );

  try {
    const parsed =
      await parser.parseURL(
        feed.url
      );

    return parsed.items
      .map(item =>
        parseFeedItem(
          item,
          feed
        )
      )
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
/* Hamilton Police archive                                            */
/* ------------------------------------------------------------------ */

function fetchHeaders() {
  return {
    'User-Agent':
      NOMINATIM_USER_AGENT ||
      'WetFloorWatch/1.0',

    'Accept':
      'text/html,application/xhtml+xml'
  };
}

async function fetchText(
  url
) {
  const response =
    await fetch(
      url,
      {
        headers:
          fetchHeaders()
      }
    );

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} for ${url}`
    );
  }

  return response.text();
}

function extractArchivePageLinks(
  html,
  pageUrl
) {
  const $ =
    cheerio.load(html);

  const links = [];

  $('a[href]').each(
    (_, a) => {
      const href =
        $(a).attr('href');

      const text =
        normalizeWhitespace(
          $(a).text()
        );

      if (!href) {
        return;
      }

      const absolute =
        absoluteUrl(
          href,
          pageUrl
        );

      if (!absolute) {
        return;
      }

      const looksPagination =
        /next|older|previous|prev|page/i.test(
          text
        ) ||
        /[?&](?:page|p)=\d+/i.test(
          absolute
        );

      if (
        looksPagination
      ) {
        links.push(
          absolute
        );
      }
    }
  );

  return [
    ...new Set(links)
  ];
}

async function ingestHamiltonPoliceArchive() {
  console.log(
    'Hamilton Police archive'
  );

  const cutoff =
    cutoffDate();

  const queue = [
    HAMILTON_POLICE_ARCHIVE
  ];

  const visited =
    new Set();

  const results =
    new Map();

  const maxPages = 100;

  let pagesRead = 0;

  while (
    queue.length &&
    pagesRead < maxPages
  ) {
    const pageUrl =
      queue.shift();

    if (
      visited.has(pageUrl)
    ) {
      continue;
    }

    visited.add(
      pageUrl
    );

    pagesRead++;

    let html;

    try {
      html =
        await fetchText(
          pageUrl
        );

    } catch (error) {
      console.warn(
        `Hamilton Police archive page failed: ${pageUrl}`,
        error.message
      );

      continue;
    }

    const $ =
      cheerio.load(html);

    $('a').each(
      (_, anchor) => {
        const href =
          $(anchor).attr(
            'href'
          );

        const text =
          normalizeWhitespace(
            $(anchor).text()
          );

        if (
          !href ||
          !text
        ) {
          return;
        }

        const sourceUrl =
          absoluteUrl(
            href,
            pageUrl
          );

        if (!sourceUrl) {
          return;
        }

        const looksLikeArticle =
          text.length >= 12 &&
          !/read more|rss feed|search|filter|archive|next|previous|older/i.test(
            text
          );

        if (
          !looksLikeArticle
        ) {
          return;
        }

        const containerText =
          normalizeWhitespace(
            $(anchor)
              .closest(
                'article, li, div'
              )
              .text()
          );

        const dateMatch =
          containerText.match(
            /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/i
          );

        let publishedAt =
          null;

        if (dateMatch) {
          const candidate =
            new Date(
              dateMatch[0]
            );

          if (
            !Number.isNaN(
              candidate.getTime()
            )
          ) {
            publishedAt =
              candidate.toISOString();

            if (
              candidate < cutoff
            ) {
              return;
            }
          }
        }

        results.set(
          sourceUrl,
          {
            title: text,
            summary:
              scrubPII(
                containerText.slice(
                  0,
                  1500
                )
              ),
            sourceUrl,
            publishedAt,
            source:
              'Hamilton Police Service',
            sourceType:
              'police'
          }
        );
      }
    );

    for (
      const link
      of extractArchivePageLinks(
        html,
        pageUrl
      )
    ) {
      if (
        !visited.has(link) &&
        !queue.includes(link)
      ) {
        queue.push(link);
      }
    }
  }

  console.log(
    `Hamilton Police archive pages read: ${pagesRead}`
  );

  return [
    ...results.values()
  ];
}

/* ------------------------------------------------------------------ */
/* Hamilton Fire ArcGIS                                               */
/* ------------------------------------------------------------------ */

function arcgisDateLiteral(
  date
) {
  const d =
    new Date(date);

  if (
    Number.isNaN(
      d.getTime()
    )
  ) {
    throw new Error(
      'Invalid ArcGIS cutoff date.'
    );
  }

  const iso =
    d.toISOString();

  return iso
    .replace(
      'T',
      ' '
    )
    .replace(
      /\.\d{3}Z$/,
      ''
    );
}

function buildFireRecord(
  feature
) {
  const a =
    feature?.attributes ||
    {};

  const g =
    feature?.geometry ||
    {};

  const objectId =
    Number(a.OBJECTID);

  if (
    !Number.isFinite(
      objectId
    )
  ) {
    return null;
  }

  const rawLat =
    Number(g.y);

  const rawLon =
    Number(g.x);

  const coordinates =
    privacySafeCoordinates(
      rawLat,
      rawLon
    );

  const incidentType =
    a.incident_type_name ||
    a.incident_type_description ||
    a.incident_group_name ||
    'Fire Department incident';

  const incidentGroup =
    a.incident_group_name ||
    a.incident_subgroup_code ||
    '';

  const title =
    `Hamilton Fire — ${normalizeWhitespace(
      incidentType
    )}`;

  const rawAddress =
    a.address || '';

  const locationText =
    looksLikePrivateResidentialAddress(
      rawAddress
    )
      ? null
      : sanitizeLocationText(
          rawAddress
        );

  const summaryParts = [
    incidentGroup,

    a.incident_type_description &&
    a.incident_type_description !==
      incidentType
      ? a.incident_type_description
      : null
  ].filter(Boolean);

  const summary =
    scrubPII(
      summaryParts.join(
        ' — '
      )
    ) ||
    'Hamilton Fire Department public incident record.';

  const dispatchAt =
    a.dispatch_date_time ||
    a.arrive_date_time ||
    null;

  const publishedAt =
    dispatchAt
      ? toISOStringOrNull(
          Number(dispatchAt)
            ? new Date(
                Number(dispatchAt)
              )
            : dispatchAt
        )
      : null;

  if (
    publishedAt &&
    new Date(
      publishedAt
    ) < cutoffDate()
  ) {
    return null;
  }

  const sourceUrl =
    `${HAMILTON_FIRE_ARCGIS_URL}/${objectId}?f=pjson`;

  return {
    id:
      crypto
        .createHash(
          'sha256'
        )
        .update(
          [
            'hamilton-fire',
            objectId,
            publishedAt || '',
            title
          ].join('|')
        )
        .digest(
          'hex'
        ),

    title,

    summary,

    category:
      classify(
        `${title} ${incidentType}`,
        summary
      ),

    source:
      'Hamilton Fire Department',

    sourceType:
      'fire',

    sourceUrl,

    publishedAt:
      publishedAt
        ? new Date(
            publishedAt
          )
        : null,

    locationText:
      locationText ||
      'Hamilton public incident area',

    coordinates,

    mapped:
      Boolean(
        coordinates
      ),

    geocodeDisplayName:
      locationText ||
      'Hamilton public incident area',

    verifiedLocation:
      Boolean(
        coordinates
      ),

    importedAt:
      admin.firestore.FieldValue
        .serverTimestamp(),

    updatedAt:
      admin.firestore.FieldValue
        .serverTimestamp()
  };
}

async function ingestHamiltonFireArcGIS() {
  console.log(
    'Hamilton Fire ArcGIS:',
    HAMILTON_FIRE_ARCGIS_URL
  );

  const cutoffLiteral =
    arcgisDateLiteral(
      cutoffDate()
    );

  const results = [];

  const pageSize = 2000;
  let offset = 0;
  let pages = 0;

  while (true) {
    const url =
      new URL(
        `${HAMILTON_FIRE_ARCGIS_URL}/query`
      );

    url.searchParams.set(
      'where',
      `dispatch_date_time >= DATE '${cutoffLiteral}'`
    );

    url.searchParams.set(
      'outFields',
      '*'
    );

    url.searchParams.set(
      'returnGeometry',
      'true'
    );

    url.searchParams.set(
      'outSR',
      '4326'
    );

    url.searchParams.set(
      'orderByFields',
      'dispatch_date_time DESC'
    );

    url.searchParams.set(
      'resultRecordCount',
      String(pageSize)
    );

    url.searchParams.set(
      'resultOffset',
      String(offset)
    );

    url.searchParams.set(
      'f',
      'json'
    );

    let payload;

    try {
      const response =
        await fetch(
          url,
          {
            headers: {
              'User-Agent':
                'WetFloorWatch/1.0',

              'Accept':
                'application/json'
            }
          }
        );

      if (
        !response.ok
      ) {
        throw new Error(
          `ArcGIS HTTP ${response.status}`
        );
      }

      payload =
        await response.json();

    } catch (error) {
      throw new Error(
        `Hamilton Fire ArcGIS query failed: ${error.message}`
      );
    }

    if (
      payload?.error
    ) {
      throw new Error(
        `Hamilton Fire ArcGIS error: ${
          payload.error.message ||
          JSON.stringify(
            payload.error
          )
        }`
      );
    }

    const features =
      Array.isArray(
        payload.features
      )
        ? payload.features
        : [];

    pages++;

    for (
      const feature
      of features
    ) {
      const record =
        buildFireRecord(
          feature
        );

      if (record) {
        results.push(
          record
        );
      }
    }

    console.log(
      `Hamilton Fire ArcGIS page ${pages}: ${features.length} features`
    );

    if (
      features.length < pageSize ||
      payload.exceededTransferLimit !==
        true
    ) {
      break;
    }

    offset +=
      features.length;
  }

  console.log(
    `Hamilton Fire ArcGIS collected ${results.length} mapped/eligible records.`
  );

  return results;
}

/* ------------------------------------------------------------------ */
/* Normalize + enrich non-Fire records                                */
/* ------------------------------------------------------------------ */

async function enrichRecord(
  raw
) {
  const summary =
    scrubPII(
      raw.summary
    );

  const title =
    scrubPII(
      raw.title
    );

  let extracted =
    null;

  if (groq) {
    extracted =
      await extractWithGroq(
        title,
        summary
      );
  }

  if (
    extracted &&
    extracted.isHamilton !==
      true
  ) {
    return null;
  }

  let locationText =
    extracted?.locationText ||
    extractIntersection(
      `${title} ${summary}`
    );

  if (locationText) {
    locationText =
      sanitizeLocationText(
        locationText
      );

    if (
      looksLikePrivateResidentialAddress(
        locationText
      )
    ) {
      locationText = null;
    }
  }

  const coordinates =
    locationText
      ? await geocodeHamilton(
          locationText
        )
      : null;

  const category =
    extracted?.category ||
    classify(
      title,
      summary
    );

  const id =
    incidentId(
      raw.sourceUrl,
      raw.publishedAt,
      title
    );

  return {
    id,

    title,

    summary,

    category,

    source:
      raw.source,

    sourceType:
      raw.sourceType,

    sourceUrl:
      raw.sourceUrl,

    publishedAt:
      raw.publishedAt
        ? new Date(
            raw.publishedAt
          )
        : null,

    locationText:
      locationText ||
      null,

    coordinates:
      coordinates
        ? {
            lat:
              coordinates.lat,
            lon:
              coordinates.lon
          }
        : null,

    mapped:
      Boolean(
        coordinates
      ),

    geocodeDisplayName:
      coordinates?.displayName ||
      null,

    verifiedLocation:
      Boolean(
        coordinates
      ),

    importedAt:
      admin.firestore.FieldValue
        .serverTimestamp(),

    updatedAt:
      admin.firestore.FieldValue
        .serverTimestamp()
  };
}

/* ------------------------------------------------------------------ */
/* Firestore                                                          */
/* ------------------------------------------------------------------ */

async function writeRecord(
  record
) {
  if (
    !record?.id ||
    !record?.sourceUrl
  ) {
    return;
  }

  await db
    .collection(
      COLLECTION
    )
    .doc(
      record.id
    )
    .set(
      record,
      {
        merge:
          true
      }
    );
}

async function processRawRecords(
  records
) {
  let processed = 0;
  let mapped = 0;
  let skipped = 0;

  for (
    const raw
    of records
  ) {
    try {
      const record =
        await enrichRecord(
          raw
        );

      if (!record) {
        skipped++;
        continue;
      }

      await writeRecord(
        record
      );

      processed++;

      if (
        record.mapped
      ) {
        mapped++;
      }

      console.log(
        `${record.mapped ? 'MAP' : 'TEXT'} ` +
        `${record.sourceType}: ` +
        `${record.category}: ` +
        `${record.title}`
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

async function processPreMappedRecords(
  records
) {
  let processed = 0;
  let mapped = 0;
  let skipped = 0;

  for (
    const record
    of records
  ) {
    try {
      if (
        !record ||
        !record.id ||
        !record.sourceUrl
      ) {
        skipped++;
        continue;
      }

      await writeRecord(
        record
      );

      processed++;

      if (
        record.mapped
      ) {
        mapped++;
      }

      console.log(
        `${record.mapped ? 'MAP' : 'TEXT'} ` +
        `${record.sourceType}: ` +
        `${record.category}: ` +
        `${record.title}`
      );

    } catch (error) {
      skipped++;

      console.warn(
        'Pre-mapped record failed:',
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
/* Optional Instagram adapter                                         */
/* ------------------------------------------------------------------ */

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
    name:
      '@interventionintersection2026',

    url:
      feedUrl,

    type:
      'instagram'
  };

  return ingestRSSFeed(
    feed
  );
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(
    `WetFloorWatch ingestion starting; historical depth=${HISTORY_DAYS} days`
  );

  const feeds = [
    ...BUILTIN_NEWS_FEEDS
  ];

  if (
    process.env.RSS_FEEDS
  ) {
    try {
      const configured =
        JSON.parse(
          process.env.RSS_FEEDS
        );

      if (
        Array.isArray(
          configured
        )
      ) {
        feeds.push(
          ...configured
        );
      }

    } catch (error) {
      throw new Error(
        `Invalid RSS_FEEDS JSON: ${error.message}`
      );
    }
  }

  if (
    process.env.HAMILTON_EMS_FEED_URL
  ) {
    feeds.push({
      name:
        'Hamilton EMS',

      url:
        process.env.HAMILTON_EMS_FEED_URL,

      type:
        'ems'
    });
  }

  const [
    rssRecords,
    policeRecords,
    instagramRecords,
    fireRecords
  ] =
    await Promise.all([
      Promise.all(
        feeds.map(
          ingestRSSFeed
        )
      ).then(
        groups =>
          groups.flat()
      ),

      ingestHamiltonPoliceArchive(),

      ingestInstagramFeed(),

      ingestHamiltonFireArcGIS()
    ]);

  const nonFireRecords = [
    ...rssRecords,
    ...policeRecords,
    ...instagramRecords
  ];

  const unique = [
    ...new Map(
      nonFireRecords
        .filter(
          item =>
            item?.sourceUrl
        )
        .map(
          item => [
            `${item.sourceUrl}|${item.title}`,
            item
          ]
        )
    ).values()
  ];

  console.log(
    `Collected ${unique.length} unique non-Fire source records.`
  );

  console.log(
    `Prepared ${fireRecords.length} official Fire records.`
  );

  const normalResult =
    await processRawRecords(
      unique
    );

  const fireResult =
    await processPreMappedRecords(
      fireRecords
    );

  const totalProcessed =
    normalResult.processed +
    fireResult.processed;

  const totalMapped =
    normalResult.mapped +
    fireResult.mapped;

  const totalSkipped =
    normalResult.skipped +
    fireResult.skipped;

  console.log(
    JSON.stringify(
      {
        ok:
          true,

        historyDays:
          HISTORY_DAYS,

        groqModel:
          GROQ_MODEL,

        groqUsed:
          Boolean(
            groq
          ),

        groqDisabledForRun,

        nonFireCollected:
          unique.length,

        fireCollected:
          fireRecords.length,

        processed:
          totalProcessed,

        mapped:
          totalMapped,

        skipped:
          totalSkipped,

        nonFireResult:
          normalResult,

        fireResult
      },
      null,
      2
    )
  );
}

main().catch(
  error => {
    console.error(
      error
    );

    process.exit(
      1
    );
  }
);
