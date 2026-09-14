'use strict';

const Parser = require('rss-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');
const admin = require('firebase-admin');

let Groq = null;

try {
  Groq = require('groq-sdk');
} catch (_) {}

const parser = new Parser({
  timeout: 20000,
  headers: {
    'User-Agent': 'WetFloorWatch/1.0'
  }
});

const COLLECTION =
  process.env.FIRESTORE_COLLECTION || 'incidents';

const HISTORY_DAYS =
  Number(process.env.HISTORY_DAYS || 730);

const NOMINATIM_URL =
  process.env.NOMINATIM_URL ||
  'https://nominatim.openstreetmap.org/search';

const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT || '';

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  'llama-3.3-70b-versatile';

const HPS_ARCHIVE =
  process.env.HAMILTON_POLICE_ARCHIVE ||
  'https://hamiltonpolice.on.ca/news/?h=1';

const HFD_FEATURE_URL =
  process.env.HFD_FEATURE_URL ||
  'https://services.arcgis.com/rYz782eMbySr2srL/arcgis/rest/services/HFD_Fire_Incidents/FeatureServer/0';

const INSTAGRAM_FEED_URL =
  process.env.INSTAGRAM_FEED_URL || '';

const EMS_FEED_URL =
  process.env.HAMILTON_EMS_FEED_URL || '';

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error(
    'Missing FIREBASE_SERVICE_ACCOUNT_JSON'
  );
}

if (!NOMINATIM_USER_AGENT) {
  throw new Error(
    'Missing NOMINATIM_USER_AGENT'
  );
}

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON
);

admin.initializeApp({
  credential:
    admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const groq =
  Groq && process.env.GROQ_API_KEY
    ? new Groq({
        apiKey:
          process.env.GROQ_API_KEY
      })
    : null;

const HAMILTON_BOUNDS = {
  minLat: 43.05,
  maxLat: 43.55,
  minLon: -80.25,
  maxLon: -79.55
};

const cutoffDate = () =>
  new Date(
    Date.now() -
      HISTORY_DAYS *
        86400000
  );

const sleep = ms =>
  new Promise(resolve =>
    setTimeout(resolve, ms)
  );

/*
 * Built-in authoritative/local news feeds.
 *
 * These don't depend on RSS_FEEDS being configured.
 */
const DEFAULT_FEEDS = [

  {
    name: 'Global News Hamilton',
    url: 'https://globalnews.ca/hamilton/feed/',
    type: 'news'
  },

  {
    name: 'CBC Hamilton',
    url: 'https://www.cbc.ca/webfeed/rss/rss-canada-hamiltonnews',
    type: 'news'
  },

  {
    name: 'CHCH News Hamilton',
    url:
      'https://news.google.com/rss/search?q=site%3Achch.com%2Fchch-news%2F%20Hamilton&hl=en-CA&gl=CA&ceid=CA%3Aen',
    type: 'news'
  },

  {
    name: 'Hamilton Spectator',
    url:
      'https://news.google.com/rss/search?q=site%3Athespec.com%2Fnews%2Fhamilton%2F%20Hamilton&hl=en-CA&gl=CA&ceid=CA%3Aen',
    type: 'news'
  }

];

/*
 * The entire purpose of the product is safety awareness.
 * Generic sports, politics, entertainment and navigation
 * records are therefore rejected.
 */
const SAFETY_TERMS =
  /\b(
    shooting|
    shot fired|
    gunfire|
    gunshot|
    stabbing|
    stabbed|
    assault|
    attack|
    harassment|
    violent|
    violence|
    homicide|
    murder|
    death|
    suspicious death|
    sexual assault|
    robbery|
    theft|
    stolen|
    break.?in|
    arson|
    fire|
    explosion|
    collision|
    crash|
    pedestrian struck|
    cyclist struck|
    impaired driving|
    drug|
    fentanyl|
    opioid|
    overdose|
    open drug|
    needle|
    syringe|
    pipe|
    paraphernalia|
    weapon|
    firearm|
    gun|
    bomb|
    hazard|
    gas leak|
    carbon monoxide|
    missing person|
    encampment|
    tent|
    road closure|
    emergency|
    paramedic|
    ambulance|
    fire department
  )\b/ix;

/*
 * This is specifically what prevents the garbage cards
 * like "Skip to main content".
 */
const BOILERPLATE =
  /^(skip to|main content|footer content|home$|search$|filter$|archive$|rss feed|read more$|load more|privacy|cookie|terms|accessibility|careers|contact us|site map)/i;

/*
 * The categories that appear in the platform.
 */
const CATEGORY_RULES = [

  [
    'shooting',
    /shooting|gunfire|shot fired|gunshot|shots fired/i
  ],

  [
    'assault',
    /stabbing|stabbed|assault|attack|violent attack|sexual assault|harassment/i
  ],

  [
    'fire',
    /arson|structure fire|house fire|building fire|fire department|explosion/i
  ],

  [
    'collision',
    /collision|crash|pedestrian struck|cyclist struck|vehicle struck|impaired driving/i
  ],

  [
    'drug',
    /open drug|drug use|fentanyl|opioid|overdose|needle|syringe|pipe|paraphernalia|drug trafficking/i
  ],

  [
    'weapons',
    /firearm|weapon|gun|knife|bomb/i
  ],

  [
    'theft',
    /theft|stolen|robbery|break.?in|smash.?and.?grab/i
  ],

  [
    'missing-person',
    /missing person|missing child|missing youth/i
  ],

  [
    'suspicious',
    /suspicious|homicide|death under investigation|unknown death/i
  ],

  [
    'hazard',
    /hazard|danger|unsafe|gas leak|carbon monoxide|road closure|spill|encampment|tent/i
  ]

];

/* ------------------------------------------------------------------ */
/* Utility                                                            */
/* ------------------------------------------------------------------ */

function normalizeWhitespace(
  value = ''
) {
  return String(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function scrubPII(
  value = ''
) {

  return normalizeWhitespace(
    String(value)

      .replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        '[redacted]'
      )

      .replace(
        /\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-])\d{3}[\s.-]\d{4}\b/g,
        '[redacted]'
      )

      .replace(
        /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi,
        '[postal code redacted]'
      )
  );
}

function absUrl(
  value,
  base
) {

  try {

    const u =
      new URL(
        value,
        base
      );

    if (
      ![
        'http:',
        'https:'
      ].includes(
        u.protocol
      )
    ) {
      return null;
    }

    return u.href;

  } catch {

    return null;

  }
}

function isHamiltonCoord(
  lat,
  lon
) {

  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= HAMILTON_BOUNDS.minLat &&
    lat <= HAMILTON_BOUNDS.maxLat &&
    lon >= HAMILTON_BOUNDS.minLon &&
    lon <= HAMILTON_BOUNDS.maxLon
  );
}

function classify(
  title,
  summary,
  hint = ''
) {

  const text =
    `${title} ${summary} ${hint}`;

  for (
    const [
      category,
      expression
    ] of CATEGORY_RULES
  ) {

    if (
      expression.test(
        text
      )
    ) {
      return category;
    }

  }

  return 'community-safety';
}

function isRelevant(
  title,
  summary,
  sourceType
) {

  /*
   * Fire / EMS sources are already
   * emergency-service datasets.
   */
  if (
    sourceType === 'fire' ||
    sourceType === 'ems'
  ) {
    return true;
  }

  return SAFETY_TERMS.test(
    `${title} ${summary}`
  );
}

function incidentId(
  sourceUrl,
  publishedAt,
  title
) {

  return crypto
    .createHash(
      'sha256'
    )
    .update(
      [
        sourceUrl || '',
        publishedAt || '',
        title || ''
      ].join('|')
    )
    .digest('hex');
}

/*
 * Never map a private home address.
 */
function safePublicLocation(
  value = ''
) {

  const s =
    normalizeWhitespace(
      value
    );

  if (
    /^\d{1,6}\s+[A-Za-z].*(Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Lane|Ln|Crescent|Cres|Court|Ct|Place|Pl|Way|Terrace|Ter)\b/i.test(
      s
    )
  ) {
    return null;
  }

  if (
    /\b(?:unit|suite|apt|apartment|#)\s*[-A-Za-z0-9]+/i.test(
      s
    )
  ) {
    return null;
  }

  return (
    scrubPII(
      s.replace(
        /^\d{1,6}[ -]+(?=[A-Za-z])/,
        ''
      )
    ).slice(0, 300) ||
    null
  );
}

/*
 * Deterministic public-intersection extraction.
 */
function extractIntersection(
  text = ''
) {

  const s =
    normalizeWhitespace(
      text
    );

  const match =
    s.match(
      /\b([A-Z][A-Za-z.'’\- ]{1,50}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Parkway|Pkwy|Crescent|Cres|Lane|Ln|Court|Ct|Way|Place|Pl|Trail|Highway|Hwy)(?:\s+(?:North|South|East|West))?)\s+(?:and|at|\/|&)\s+([A-Z][A-Za-z.'’\- ]{1,50}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Parkway|Pkwy|Crescent|Cres|Lane|Ln|Court|Ct|Way|Place|Pl|Trail|Highway|Hwy)(?:\s+(?:North|South|East|West))?)/i
    );

  if (!match) {
    return null;
  }

  return safePublicLocation(
    `${match[1]} & ${match[2]}, Hamilton, Ontario, Canada`
  );
}

/* ------------------------------------------------------------------ */
/* Source URL integrity                                               */
/* ------------------------------------------------------------------ */

async function resolveFinalUrl(
  url
) {

  if (
    !url ||
    !url.includes(
      'news.google.com'
    )
  ) {
    return url;
  }

  try {

    const response =
      await fetch(
        url,
        {
          redirect: 'follow',
          headers: {
            'User-Agent':
              'WetFloorWatch/1.0'
          }
        }
      );

    const finalUrl =
      response.url ||
      url;

    /*
     * Do not store a Google News redirect
     * as though it were the actual publisher.
     */
    if (
      finalUrl.includes(
        'news.google.com'
      )
    ) {
      return null;
    }

    return finalUrl;

  } catch {

    return null;

  }
}

/* ------------------------------------------------------------------ */
/* Geocoding                                                          */
/* ------------------------------------------------------------------ */

async function geocode(
  locationText
) {

  if (!locationText) {
    return null;
  }

  const query =
    locationText;

  if (
    !global.geocodeCache
  ) {
    global.geocodeCache =
      new Map();
  }

  if (
    global.geocodeCache.has(
      query
    )
  ) {
    return global.geocodeCache.get(
      query
    );
  }

  const wait =
    Math.max(
      0,
      1100 -
        (
          Date.now() -
          (
            global.lastGeo || 0
          )
        )
    );

  if (wait) {
    await sleep(
      wait
    );
  }

  global.lastGeo =
    Date.now();

  const url =
    new URL(
      NOMINATIM_URL
    );

  url.searchParams.set(
    'format',
    'jsonv2'
  );

  url.searchParams.set(
    'limit',
    '1'
  );

  url.searchParams.set(
    'countrycodes',
    'ca'
  );

  url.searchParams.set(
    'q',
    query
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
        `Nominatim ${response.status}`
      );
    }

    const data =
      await response.json();

    const candidate =
      data?.[0];

    if (!candidate) {

      global.geocodeCache.set(
        query,
        null
      );

      return null;
    }

    const lat =
      Number(
        candidate.lat
      );

    const lon =
      Number(
        candidate.lon
      );

    if (
      !isHamiltonCoord(
        lat,
        lon
      )
    ) {

      global.geocodeCache.set(
        query,
        null
      );

      return null;
    }

    const result = {
      lat,
      lon,
      displayName:
        candidate.display_name ||
        query
    };

    global.geocodeCache.set(
      query,
      result
    );

    return result;

  } catch (error) {

    console.warn(
      'Geocode failed:',
      query,
      error.message
    );

    global.geocodeCache.set(
      query,
      null
    );

    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Groq extraction                                                    */
/* ------------------------------------------------------------------ */

async function extractWithGroq(
  title,
  summary
) {

  if (!groq) {
    return null;
  }

  const prompt = `
Return ONLY valid JSON.

This is a Hamilton, Ontario public-safety extraction task.

Never invent facts, locations or coordinates.

Prefer public intersections and public facilities.

If the only location is a private residence,
return null for location.

Return a concise factual brief,
maximum 240 characters.

Schema:

{
  "isHamilton": true,
  "category": "shooting|assault|fire|collision|drug|weapons|theft|missing-person|suspicious|hazard|community-safety",
  "locationText": "public intersection or place, or null",
  "brief": "factual one or two sentence summary",
  "confidence": 0.0
}

TITLE:
${title}

SUMMARY:
${summary}
`;

  try {

    const response =
      await groq.chat.completions.create(
        {
          model:
            GROQ_MODEL,

          temperature:
            0,

          messages: [
            {
              role:
                'system',

              content:
                'Deterministic public-safety information extractor.'
            },

            {
              role:
                'user',

              content:
                prompt
            }
          ]
        }
      );

    const content =
      response
        .choices?.[0]
        ?.message
        ?.content ||
      '';

    const start =
      content.indexOf(
        '{'
      );

    const end =
      content.lastIndexOf(
        '}'
      );

    if (
      start < 0 ||
      end <= start
    ) {
      return null;
    }

    const parsed =
      JSON.parse(
        content.slice(
          start,
          end + 1
        )
      );

    if (
      parsed.isHamilton !== true ||
      typeof parsed.confidence !==
        'number' ||
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
/* RSS                                                                 */
/* ------------------------------------------------------------------ */

async function parseFeedItem(
  item,
  feed
) {

  let sourceUrl =
    absUrl(
      item.link ||
        item.guid ||
        item.id,
      feed.url
    );

  if (!sourceUrl) {
    return null;
  }

  sourceUrl =
    await resolveFinalUrl(
      sourceUrl
    );

  if (!sourceUrl) {
    return null;
  }

  const title =
    scrubPII(
      normalizeWhitespace(
        item.title ||
        ''
      )
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
      ? new Date(
          publishedAt
        )
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

  if (
    !title ||
    BOILERPLATE.test(
      title
    )
  ) {
    return null;
  }

  if (
    !isRelevant(
      title,
      summary,
      feed.type
    )
  ) {
    return null;
  }

  return {
    title,
    summary,
    sourceUrl,

    publishedAt:
      date &&
      !Number.isNaN(
        date.getTime()
      )
        ? date.toISOString()
        : null,

    source:
      feed.name,

    sourceType:
      feed.type
  };
}

async function ingestRSS(
  feed
) {

  try {

    const parsed =
      await parser.parseURL(
        feed.url
      );

    const out = [];

    for (
      const item of
      parsed.items
    ) {

      const record =
        await parseFeedItem(
          item,
          feed
        );

      if (record) {
        out.push(
          record
        );
      }
    }

    return out;

  } catch (error) {

    console.warn(
      `RSS failed ${feed.name}:`,
      error.message
    );

    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Hamilton Police                                                    */
/* ------------------------------------------------------------------ */

async function ingestHamiltonPolice() {

  const rss =
    await ingestRSS(
      {
        name:
          'Hamilton Police Service',

        url:
          'https://hamiltonpolice.on.ca/news/feed/en-ca',

        type:
          'police'
      }
    );

  /*
   * Use the genuine RSS feed whenever it gives
   * us enough real articles.
   */
  if (
    rss.length >= 5
  ) {
    return rss;
  }

  console.log(
    'Hamilton Police RSS returned limited results; using archive fallback.'
  );

  try {

    const response =
      await fetch(
        HPS_ARCHIVE,
        {
          headers: {
            'User-Agent':
              'WetFloorWatch/1.0'
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const html =
      await response.text();

    const $ =
      cheerio.load(
        html
      );

    const out = [];
    const seen =
      new Set();

    $(
      'a[href]'
    ).each(
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
          !text ||
          BOILERPLATE.test(
            text
          )
        ) {
          return;
        }

        const url =
          absUrl(
            href,
            HPS_ARCHIVE
          );

        if (
          !url ||
          !url.startsWith(
            'https://hamiltonpolice.on.ca/news/'
          )
        ) {
          return;
        }

        const pathname =
          new URL(
            url
          ).pathname;

        /*
         * These are archive/navigation/feed
         * URLs, not articles.
         */
        if (
          pathname ===
            '/news/' ||
          pathname.includes(
            '/feed'
          )
        ) {
          return;
        }

        if (
          seen.has(
            url
          )
        ) {
          return;
        }

        /*
         * Article titles are meaningful and
         * usually at least 12 characters.
         */
        if (
          text.length < 12 ||
          /^(tags|case number|hamont|media|rss)/i.test(
            text
          )
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

        const date =
          dateMatch
            ? new Date(
                dateMatch[0]
              )
            : null;

        if (
          date &&
          !Number.isNaN(
            date.getTime()
          ) &&
          date < cutoffDate()
        ) {
          return;
        }

        const summary =
          scrubPII(
            containerText.slice(
              0,
              1800
            )
          );

        if (
          !isRelevant(
            text,
            summary,
            'police'
          )
        ) {
          return;
        }

        seen.add(
          url
        );

        out.push(
          {
            title:
              scrubPII(
                text
              ),

            summary,

            sourceUrl:
              url,

            publishedAt:
              date &&
              !Number.isNaN(
                date.getTime()
              )
                ? date.toISOString()
                : null,

            source:
              'Hamilton Police Service',

            sourceType:
              'police'
          }
        );

      }
    );

    const merged =
      new Map();

    for (
      const record of
      [
        ...rss,
        ...out
      ]
    ) {
      merged.set(
        record.sourceUrl,
        record
      );
    }

    return [
      ...merged.values()
    ];

  } catch (error) {

    console.warn(
      'HPS archive failed:',
      error.message
    );

    return rss;
  }
}

/* ------------------------------------------------------------------ */
/* Hamilton Fire — official ArcGIS layer                              */
/* ------------------------------------------------------------------ */

async function ingestFire() {

  const out = [];

  let offset = 0;

  for (
    let page = 0;
    page < 8;
    page++
  ) {

    const url =
      new URL(
        `${HFD_FEATURE_URL}/query`
      );

    url.searchParams.set(
      'where',
      '1=1'
    );

    url.searchParams.set(
      'outFields',
      '*'
    );

    url.searchParams.set(
      'returnGeometry',
      'false'
    );

    url.searchParams.set(
      'f',
      'json'
    );

    url.searchParams.set(
      'resultOffset',
      String(offset)
    );

    url.searchParams.set(
      'resultRecordCount',
      '2000'
    );

    url.searchParams.set(
      'orderByFields',
      'DATE_TIME DESC'
    );

    try {

      const response =
        await fetch(
          url,
          {
            headers: {
              'User-Agent':
                'WetFloorWatch/1.0'
            }
          }
        );

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      const data =
        await response.json();

      const features =
        data.features ||
        [];

      if (
        !features.length
      ) {
        break;
      }

      for (
        const feature of
        features
      ) {

        const attrs =
          feature.attributes ||
          {};

        const date =
          attrs.DATE_TIME
            ? new Date(
                attrs.DATE_TIME
              )
            : null;

        if (
          date &&
          !Number.isNaN(
            date.getTime()
          ) &&
          date < cutoffDate()
        ) {
          return out;
        }

        const street1 =
          safePublicLocation(
            attrs.XSTREET_1 ||
            ''
          );

        const street2 =
          safePublicLocation(
            attrs.XSTREET_2 ||
            ''
          );

        const location =
          street1 &&
          street2
            ? `${street1} & ${street2}, Hamilton, Ontario, Canada`
            : null;

        let coordinates =
          null;

        if (
          location
        ) {
          coordinates =
            await geocode(
              location
            );
        }

        const title =
          `Hamilton Fire: ${
            attrs.TYPE_OF_CALL ||
            'Incident'
          }`;

        const summary =
          scrubPII(
            `${
              attrs.TYPE_OF_CALL ||
              'Fire Department incident'
            }${
              location
                ? ` near ${location}`
                : ''
            }. Units dispatched: ${
              attrs.UNITS_DISPATCHED ||
              'not published'
            }.`
          );

        /*
         * Direct record-level ArcGIS query URL,
         * rather than the dashboard homepage.
         */
        const sourceUrl =
          `${HFD_FEATURE_URL}/query?where=OBJECTID%3D${encodeURIComponent(
            attrs.OBJECTID
          )}&outFields=*&returnGeometry=false&f=pjson`;

        out.push(
          {
            title,

            summary,

            sourceUrl,

            publishedAt:
              date &&
              !Number.isNaN(
                date.getTime()
              )
                ? date.toISOString()
                : null,

            source:
              'Hamilton Fire Department',

            sourceType:
              'fire',

            locationText:
              location,

            coordinates
          }
        );

      }

      if (
        features.length <
        2000
      ) {
        break;
      }

      offset +=
        2000;

    } catch (error) {

      console.warn(
        'HFD ArcGIS failed:',
        error.message
      );

      break;
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Enrichment                                                         */
/* ------------------------------------------------------------------ */

async function enrich(
  raw
) {

  let location =
    raw.locationText ||
    extractIntersection(
      `${raw.title} ${raw.summary}`
    );

  let brief =
    raw.brief ||
    null;

  let extracted =
    null;

  if (groq) {

    extracted =
      await extractWithGroq(
        raw.title,
        raw.summary
      );
  }

  if (
    extracted?.isHamilton ===
    false
  ) {
    return null;
  }

  if (
    extracted?.locationText
  ) {

    location =
      safePublicLocation(
        extracted.locationText
      ) ||
      location;
  }

  if (
    extracted?.brief
  ) {

    brief =
      scrubPII(
        extracted.brief
      );
  }

  if (
    !isRelevant(
      raw.title,
      raw.summary,
      raw.sourceType
    )
  ) {
    return null;
  }

  if (
    location &&
    !raw.coordinates
  ) {

    raw.coordinates =
      await geocode(
        location
      );
  }

  if (
    !brief
  ) {

    brief =
      normalizeWhitespace(
        `${raw.title}. ${raw.summary}`
      ).slice(
        0,
        320
      );
  }

  const category =
    extracted?.category ||
    classify(
      raw.title,
      raw.summary,
      raw.sourceType
    );

  return {

    id:
      incidentId(
        raw.sourceUrl,
        raw.publishedAt,
        raw.title
      ),

    title:
      raw.title,

    summary:
      raw.summary,

    brief,

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
      location ||
      null,

    coordinates:
      raw.coordinates
        ? {
            lat:
              raw.coordinates.lat,

            lon:
              raw.coordinates.lon
          }
        : null,

    mapped:
      Boolean(
        raw.coordinates
      ),

    verifiedLocation:
      Boolean(
        raw.coordinates
      ),

    importedAt:
      admin.firestore.FieldValue.serverTimestamp(),

    updatedAt:
      admin.firestore.FieldValue.serverTimestamp()
  };
}

async function write(
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
        merge: true
      }
    );
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {

  const customFeeds =
    process.env.RSS_FEEDS
      ? JSON.parse(
          process.env.RSS_FEEDS
        )
      : [];

  const feeds = [
    ...DEFAULT_FEEDS,
    ...(
      Array.isArray(
        customFeeds
      )
        ? customFeeds
        : []
    )
  ];

  /*
   * Real Instagram adapter only.
   * No HTML scraping of Instagram.
   */
  if (
    INSTAGRAM_FEED_URL
  ) {

    feeds.push(
      {
        name:
          '@interventionintersection2026',

        url:
          INSTAGRAM_FEED_URL,

        type:
          'instagram'
      }
    );
  }

  /*
   * Optional official EMS adapter.
   *
   * Do not invent a dispatch feed if one
   * is not publicly available.
   */
  if (
    EMS_FEED_URL
  ) {

    feeds.push(
      {
        name:
          'Hamilton Paramedic Service',

        url:
          EMS_FEED_URL,

        type:
          'ems'
      }
    );
  }

  const [
    feedGroups,
    police,
    fire
  ] =
    await Promise.all(
      [
        Promise.all(
          feeds.map(
            ingestRSS
          )
        ),

        ingestHamiltonPolice(),

        ingestFire()
      ]
    );

  const all = [
    ...feedGroups.flat(),
    ...(
      Array.isArray(
        police
      )
        ? police
        : []
    ),
    ...fire
  ];

  const unique =
    [
      ...new Map(
        all
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

  let processed = 0;
  let mapped = 0;
  let skipped = 0;

  for (
    const raw of
    unique
  ) {

    try {

      const record =
        await enrich(
          raw
        );

      if (!record) {

        skipped++;

        continue;
      }

      await write(
        record
      );

      processed++;

      if (
        record.mapped
      ) {
        mapped++;
      }

      console.log(
        `${
          record.mapped
            ? 'MAP'
            : 'TEXT'
        } ${
          record.sourceType
        } ${
          record.category
        }: ${
          record.title
        }`
      );

    } catch (error) {

      skipped++;

      console.warn(
        'Record failed:',
        error.message
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        ok:
          true,

        historyDays:
          HISTORY_DAYS,

        collected:
          unique.length,

        processed,

        mapped,

        skipped
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
