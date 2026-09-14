'use strict';

/*
 * WetFloorWatch
 * Hamilton public-safety ingestion engine
 *
 * Sources:
 *   - Hamilton Police
 *   - Hamilton Fire Department official public ArcGIS layer
 *   - Configured local-news RSS feeds
 *   - Configured social/community feeds
 *   - Optional Instagram feed adapter
 *   - Optional EMS feed adapter
 *
 * Design:
 *   - Never fabricate incidents.
 *   - Never fabricate coordinates.
 *   - Never map private residential civic addresses.
 *   - Never replace missing source URLs with homepages.
 *   - Fire records use the official public ArcGIS geometry when available.
 *   - Nominatim is reserved primarily for public intersections extracted
 *     from news/community text.
 */

const Parser = require('rss-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');
const admin = require('firebase-admin');

let Groq = null;

try {
  Groq = require('groq-sdk');
} catch (_) {
  // Optional.
}


/* =====================================================================
   CONFIG
   ===================================================================== */

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

/*
 * CURRENT official Hamilton Fire public layer.
 *
 * This layer contains point geometry.
 */
const HFD_FEATURE_URL =
  process.env.HFD_FEATURE_URL ||
  'https://services.arcgis.com/v400IkDOw1ad7Yad/ArcGIS/rest/services/Fire_Incidents_Public/FeatureServer/0';

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


/* =====================================================================
   FIREBASE
   ===================================================================== */

const serviceAccount =
  JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );

admin.initializeApp({
  credential:
    admin.credential.cert(
      serviceAccount
    )
});

const db =
  admin.firestore();


/* =====================================================================
   GROQ
   ===================================================================== */

const groq =
  Groq &&
  process.env.GROQ_API_KEY
    ? new Groq({
        apiKey:
          process.env.GROQ_API_KEY
      })
    : null;


/* =====================================================================
   RSS
   ===================================================================== */

const parser =
  new Parser({
    timeout:
      20000,

    headers: {
      'User-Agent':
        'WetFloorWatch/1.0'
    }
  });


/* =====================================================================
   HAMILTON BOUNDARY
   ===================================================================== */

const HAMILTON_BOUNDS = {

  minLat:
    43.05,

  maxLat:
    43.55,

  minLon:
    -80.25,

  maxLon:
    -79.55
};


function isHamiltonCoordinate(
  lat,
  lon
) {

  return (

    Number.isFinite(lat) &&

    Number.isFinite(lon) &&

    lat >=
      HAMILTON_BOUNDS.minLat &&

    lat <=
      HAMILTON_BOUNDS.maxLat &&

    lon >=
      HAMILTON_BOUNDS.minLon &&

    lon <=
      HAMILTON_BOUNDS.maxLon

  );

}


/* =====================================================================
   DATES / BASIC UTILITIES
   ===================================================================== */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );

}


function cutoffDate() {

  return new Date(
    Date.now() -
      HISTORY_DAYS *
      86400000
  );

}


function normalizeWhitespace(
  value = ''
) {

  return String(value)
    .replace(
      /\s+/g,
      ' '
    )
    .trim();

}


function absoluteUrl(
  value,
  base
) {

  try {

    if (!value) {
      return null;
    }

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


/* =====================================================================
   PRIVACY
   ===================================================================== */

function scrubPII(
  value = ''
) {

  let result =
    String(value);


  result =
    result.replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[redacted]'
    );


  result =
    result.replace(
      /\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-])\d{3}[\s.-]\d{4}\b/g,
      '[redacted]'
    );


  result =
    result.replace(
      /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi,
      '[postal code redacted]'
    );


  return normalizeWhitespace(
    result
  );

}


function safePublicLocation(
  location = ''
) {

  const clean =
    normalizeWhitespace(
      location
    );


  /*
   * Reject civic-address patterns that look
   * like private residential locations.
   */

  if (
    /^\d{1,6}\s+[A-Za-z].*(Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Lane|Ln|Crescent|Cres|Court|Ct|Place|Pl|Way|Terrace|Ter)\b/i.test(
      clean
    )
  ) {

    return null;

  }


  if (
    /\b(?:unit|suite|apt|apartment|#)\s*[-A-Za-z0-9]+/i.test(
      clean
    )
  ) {

    return null;

  }


  return scrubPII(
    clean
      .replace(
        /^\d{1,6}[ -]+(?=[A-Za-z])/,
        ''
      )
  ).slice(
    0,
    300
  ) || null;

}


/* =====================================================================
   SAFETY FILTER
   ===================================================================== */

const SAFETY_TERMS =
  /\b(?:shooting|shot fired|gunfire|gunshot|stabbing|stabbed|assault|attack|harassment|violent|violence|homicide|murder|death|suspicious death|sexual assault|robbery|theft|stolen|break.?in|arson|fire|explosion|collision|crash|pedestrian struck|cyclist struck|impaired driving|drug|fentanyl|opioid|overdose|open drug|needle|syringe|pipe|paraphernalia|weapon|firearm|gun|bomb|hazard|gas leak|carbon monoxide|missing person|encampment|tent|road closure|emergency|paramedic|ambulance|fire department)\b/i;


const BOILERPLATE =
  /^(skip to|main content|footer content|home$|search$|filter$|archive$|rss feed|read more$|load more|privacy|cookie|terms|accessibility|careers|contact us|site map)/i;


const CATEGORY_RULES = [

  [
    'shooting',
    /shooting|shot fired|gunfire|gunshot|shots fired/i
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


function classify(
  title,
  summary
) {

  const text =
    `${title} ${summary}`;


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
   * Emergency-service datasets don't require
   * keyword filtering.
   */

  if (
    sourceType === 'fire' ||
    sourceType === 'ems' ||
    sourceType === 'police'
  ) {

    return true;

  }


  return SAFETY_TERMS.test(
    `${title} ${summary}`
  );

}


/* =====================================================================
   INTERSECTION EXTRACTION
   ===================================================================== */

function extractIntersection(
  text = ''
) {

  const clean =
    normalizeWhitespace(
      text
    );


  const match =
    clean.match(
      /\b([A-Z][A-Za-z.'’\- ]{1,50}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Parkway|Pkwy|Crescent|Cres|Lane|Ln|Court|Ct|Way|Place|Pl|Trail|Highway|Hwy)(?:\s+(?:North|South|East|West))?)\s+(?:and|at|\/|&)\s+([A-Z][A-Za-z.'’\- ]{1,50}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Parkway|Pkwy|Crescent|Cres|Lane|Ln|Court|Ct|Way|Place|Pl|Trail|Highway|Hwy)(?:\s+(?:North|South|East|West))?)/i
    );


  if (!match) {
    return null;
  }


  return safePublicLocation(
    `${match[1]} & ${match[2]}, Hamilton, Ontario, Canada`
  );

}


/* =====================================================================
   URL RESOLUTION
   ===================================================================== */

async function resolveSourceUrl(
  url
) {

  if (
    !url
  ) {

    return null;

  }


  /*
   * Only attempt redirect resolution for Google News.
   * Don't waste requests on normal article URLs.
   */

  if (
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
          redirect:
            'follow',

          headers: {
            'User-Agent':
              'WetFloorWatch/1.0'
          }
        }
      );


    const finalUrl =
      response.url ||
      url;


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


/* =====================================================================
   NOMINATIM
   ===================================================================== */

const geocodeCache =
  new Map();

let lastGeocodeAt =
  0;


async function geocode(
  locationText
) {

  if (
    !locationText
  ) {

    return null;

  }


  const query =
    safePublicLocation(
      locationText
    );


  if (
    !query
  ) {

    return null;

  }


  if (
    geocodeCache.has(
      query
    )
  ) {

    return geocodeCache.get(
      query
    );

  }


  /*
   * Respect Nominatim throttling.
   */

  const wait =
    Math.max(
      0,
      1100 -
      (
        Date.now() -
        lastGeocodeAt
      )
    );


  if (wait) {

    await sleep(
      wait
    );

  }


  lastGeocodeAt =
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


  /*
   * Retry 429/5xx twice rather than hammering.
   */

  for (
    let attempt = 0;
    attempt < 3;
    attempt++
  ) {

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


      if (
        response.status ===
        429 ||
        response.status >=
        500
      ) {

        const delay =
          2000 *
          Math.pow(
            2,
            attempt
          );


        console.warn(
          `Nominatim ${response.status}; retrying in ${delay}ms: ${query}`
        );


        await sleep(
          delay
        );


        continue;

      }


      if (
        !response.ok
      ) {

        throw new Error(
          `Nominatim ${response.status}`
        );

      }


      const results =
        await response.json();


      const candidate =
        results?.[0];


      if (
        !candidate
      ) {

        geocodeCache.set(
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
        !isHamiltonCoordinate(
          lat,
          lon
        )
      ) {

        geocodeCache.set(
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


      geocodeCache.set(
        query,
        result
      );


      return result;

    }

    catch (
      error
    ) {

      if (
        attempt ===
        2
      ) {

        console.warn(
          `Geocode skipped after retries: ${query} — ${error.message}`
        );

        geocodeCache.set(
          query,
          null
        );

        return null;

      }

    }

  }


  return null;

}


/* =====================================================================
   GROQ
   ===================================================================== */

async function extractWithGroq(
  title,
  summary
) {

  if (
    !groq
  ) {

    return null;

  }


  const prompt = `

Return ONLY valid JSON.

This is a Hamilton, Ontario public-safety information extraction task.

Never invent facts.
Never invent locations.
Never invent coordinates.

Reject a private residential address as a mapped location.

Prefer intersections, public facilities and public spaces.

Produce a concise factual brief.

Schema:

{
  "isHamilton": true,
  "category": "shooting|assault|fire|collision|drug|weapons|theft|missing-person|suspicious|hazard|community-safety",
  "locationText": "public intersection/public facility/null",
  "brief": "short factual safety brief",
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
      parsed.isHamilton !==
        true ||

      typeof parsed.confidence !==
        'number' ||

      parsed.confidence <
        0.75
    ) {

      return null;

    }


    return parsed;

  }
  catch (
    error
  ) {

    console.warn(
      'Groq extraction failed:',
      error.message
    );

    return null;

  }

}


/* =====================================================================
   RSS
   ===================================================================== */

async function ingestRSS(
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


    const output =
      [];


    for (
      const item of
      parsed.items
    ) {

      let sourceUrl =
        absoluteUrl(
          item.link ||
            item.guid ||
            item.id,
          feed.url
        );


      sourceUrl =
        await resolveSourceUrl(
          sourceUrl
        );


      if (
        !sourceUrl
      ) {

        continue;

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


      if (
        !title ||
        BOILERPLATE.test(
          title
        )
      ) {

        continue;

      }


      if (
        !isRelevant(
          title,
          summary,
          feed.type
        )
      ) {

        continue;

      }


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
        date <
          cutoffDate()
      ) {

        continue;

      }


      output.push(
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
            feed.name,

          sourceType:
            feed.type
        }
      );

    }


    console.log(
      `RSS ${feed.name}: ${output.length} accepted`
    );


    return output;

  }
  catch (
    error
  ) {

    console.warn(
      `RSS failed ${feed.name}:`,
      error.message
    );

    return [];

  }

}


/* =====================================================================
   HAMILTON POLICE
   ===================================================================== */

async function ingestHamiltonPolice() {

  const primary =
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
   * If the genuine RSS feed gives us records,
   * prefer those over scraping archive navigation.
   */

  if (
    primary.length >=
    5
  ) {

    return primary;

  }


  console.log(
    'HPS RSS returned limited results; using archive fallback.'
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


    if (
      !response.ok
    ) {

      throw new Error(
        `HPS archive HTTP ${response.status}`
      );

    }


    const html =
      await response.text();


    const $ =
      cheerio.load(
        html
      );


    const output =
      new Map();


    $('a[href]')
      .each(
        (_, anchor) => {

          const href =
            $(anchor).attr(
              'href'
            );


          const title =
            normalizeWhitespace(
              $(anchor).text()
            );


          if (
            !href ||
            !title ||
            BOILERPLATE.test(
              title
            )
          ) {

            return;

          }


          const sourceUrl =
            absoluteUrl(
              href,
              HPS_ARCHIVE
            );


          if (
            !sourceUrl
          ) {

            return;

          }


          if (
            !sourceUrl.startsWith(
              'https://hamiltonpolice.on.ca/news/'
            )
          ) {

            return;

          }


          const pathname =
            new URL(
              sourceUrl
            ).pathname;


          if (
            pathname ===
              '/news/' ||
            pathname.includes(
              '/feed'
            )
          ) {

            return;

          }


          const surrounding =
            normalizeWhitespace(
              $(anchor)
                .closest(
                  'article,li,div'
                )
                .text()
            );


          if (
            !isRelevant(
              title,
              surrounding,
              'police'
            )
          ) {

            return;

          }


          const dateMatch =
            surrounding.match(
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
            date <
              cutoffDate()
          ) {

            return;

          }


          output.set(
            sourceUrl,
            {
              title:
                scrubPII(
                  title
                ),

              summary:
                scrubPII(
                  surrounding
                    .slice(
                      0,
                      1800
                    )
                ),

              sourceUrl,

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


    return [
      ...new Map(
        [
          ...primary,
          ...output.values()
        ].map(
          item => [
            item.sourceUrl,
            item
          ]
        )
      ).values()
    ];

  }
  catch (
    error
  ) {

    console.warn(
      'HPS archive fallback failed:',
      error.message
    );

    return primary;

  }

}


/* =====================================================================
   HAMILTON FIRE — OFFICIAL ARCGIS
   ===================================================================== */

async function ingestFire() {

  console.log(
    'HFD: querying official public ArcGIS layer'
  );


  const output =
    [];


  /*
   * The current official public layer contains
   * point geometry. We therefore DO NOT geocode
   * every Fire incident through Nominatim.
   *
   * This is the major performance fix.
   */

  let offset =
    0;


  const pageSize =
    2000;


  for (
    let page = 0;
    page < 4;
    page++
  ) {

    const queryUrl =
      new URL(
        `${HFD_FEATURE_URL}/query`
      );


    queryUrl.searchParams.set(
      'where',
      '1=1'
    );


    queryUrl.searchParams.set(
      'outFields',
      [
        'OBJECTID',
        'incident_number',
        'incident_type_description',
        'incident_group_name',
        'incident_subgroup_code',
        'incident_type_name',
        'dispatch_date_time',
        'arrive_date_time',
        'cleared_date_time',
        'station',
        'address'
      ].join(',')
    );


    /*
     * IMPORTANT:
     * request the official point geometry.
     */
    queryUrl.searchParams.set(
      'returnGeometry',
      'true'
    );


    queryUrl.searchParams.set(
      'outSR',
      '4326'
    );


    queryUrl.searchParams.set(
      'f',
      'json'
    );


    queryUrl.searchParams.set(
      'resultOffset',
      String(
        offset
      )
    );


    queryUrl.searchParams.set(
      'resultRecordCount',
      String(
        pageSize
      )
    );


    queryUrl.searchParams.set(
      'orderByFields',
      'dispatch_date_time DESC'
    );


    let payload;


    try {

      const response =
        await fetch(
          queryUrl,
          {
            headers: {
              'User-Agent':
                'WetFloorWatch/1.0'
            }
          }
        );


      if (
        !response.ok
      ) {

        throw new Error(
          `HFD HTTP ${response.status}`
        );

      }


      payload =
        await response.json();


    }
    catch (
      error
    ) {

      console.warn(
        'HFD query failed:',
        error.message
      );

      break;

    }


    if (
      payload.error
    ) {

      console.warn(
        'HFD ArcGIS error:',
        JSON.stringify(
          payload.error
        )
      );

      break;

    }


    const features =
      payload.features ||
      [];


    console.log(
      `HFD page ${page + 1}: ${features.length} records`
    );


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


      const geometry =
        feature.geometry ||
        {};


      const dispatchDate =
        attrs.dispatch_date_time
          ? new Date(
              attrs.dispatch_date_time
            )
          : null;


      if (
        dispatchDate &&
        !Number.isNaN(
          dispatchDate.getTime()
        ) &&
        dispatchDate <
          cutoffDate()
      ) {

        /*
         * Because the API is ordered newest first,
         * all later records will also be older.
         */
        return output;

      }


      const lat =
        Number(
          geometry.y
        );


      const lon =
        Number(
          geometry.x
        );


      /*
       * Only use geometry if it is actually inside
       * the Hamilton boundary.
       */
      const coordinates =
        isHamiltonCoordinate(
          lat,
          lon
        )
          ? {
              lat,
              lon
            }
          : null;


      const incidentType =
        scrubPII(
          attrs.incident_type_name ||
          attrs.incident_type_description ||
          'Fire Department incident'
        );


      const group =
        scrubPII(
          attrs.incident_group_name ||
          ''
        );


      /*
       * Do not display exact private addresses
       * in the public text.
       */
      const safeAddress =
        safePublicLocation(
          attrs.address ||
          ''
        );


      const title =
        `Hamilton Fire — ${incidentType}`;


      const brief =
        normalizeWhitespace(
          `${incidentType}${
            group
              ? ` (${group})`
              : ''
          }${
            safeAddress
              ? ` near ${safeAddress}`
              : ''
          }.`
        );


      /*
       * Stable record-level source URL.
       */
      const sourceUrl =
        `${HFD_FEATURE_URL}/query?where=OBJECTID%3D${encodeURIComponent(
          attrs.OBJECTID
        )}&outFields=*&returnGeometry=true&outSR=4326&f=pjson`;


      output.push(
        {

          title,

          summary:
            brief,

          sourceUrl,

          publishedAt:
            dispatchDate &&
            !Number.isNaN(
              dispatchDate.getTime()
            )
              ? dispatchDate.toISOString()
              : null,

          source:
            'Hamilton Fire Department',

          sourceType:
            'fire',

          locationText:
            safeAddress,

          coordinates

        }
      );

    }


    if (
      features.length <
      pageSize
    ) {

      break;

    }


    offset +=
      pageSize;

  }


  console.log(
    `HFD accepted ${output.length} records`
  );


  return output;

}


/* =====================================================================
   ENRICH
   ===================================================================== */

async function enrich(
  raw
) {

  const title =
    scrubPII(
      raw.title
    );


  const summary =
    scrubPII(
      raw.summary
    );


  /*
   * Fire geometry is already authoritative public
   * geometry; do not overwrite it with Nominatim.
   */

  let coordinates =
    raw.coordinates ||
    null;


  let locationText =
    raw.locationText ||
    extractIntersection(
      `${title} ${summary}`
    );


  let brief =
    raw.brief ||
    null;


  let extracted =
    null;


  if (
    groq
  ) {

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


  if (
    extracted?.brief
  ) {

    brief =
      scrubPII(
        extracted.brief
      );

  }


  /*
   * Only ask Nominatim to help source-text
   * records that don't already have coordinates.
   */
  if (
    !coordinates &&
    extracted?.locationText
  ) {

    locationText =
      safePublicLocation(
        extracted.locationText
      ) ||
      locationText;

  }


  if (
    !coordinates &&
    locationText &&
    (
      raw.sourceType !==
        'fire'
    )
  ) {

    coordinates =
      await geocode(
        locationText
      );

  }


  if (
    !isRelevant(
      title,
      summary,
      raw.sourceType
    )
  ) {

    return null;

  }


  if (
    !brief
  ) {

    brief =
      `${title}. ${summary}`
        .slice(
          0,
          320
        );

  }


  const category =
    classify(
      title,
      summary
    );


  return {

    id:
      incidentId(
        raw.sourceUrl,
        raw.publishedAt,
        title
      ),

    title,

    summary,

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

    verifiedLocation:
      Boolean(
        coordinates
      ),

    importedAt:
      admin.firestore.FieldValue.serverTimestamp(),

    updatedAt:
      admin.firestore.FieldValue.serverTimestamp()

  };

}


/* =====================================================================
   FIRESTORE
   ===================================================================== */

async function writeRecord(
  record
) {

  if (
    !record ||
    !record.id ||
    !record.sourceUrl
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


/* =====================================================================
   MAIN
   ===================================================================== */

async function main() {

  console.log(
    `WetFloorWatch starting; history=${HISTORY_DAYS} days`
  );


  const customFeeds =
    process.env.RSS_FEEDS
      ? JSON.parse(
          process.env.RSS_FEEDS
        )
      : [];


  const feeds = [

    {
      name:
        'Global News Hamilton',

      url:
        'https://globalnews.ca/hamilton/feed/',

      type:
        'news'
    },

    {
      name:
        'CBC Hamilton',

      url:
        'https://www.cbc.ca/webfeed/rss/rss-canada-hamiltonnews',

      type:
        'news'
    },

    ...(
      Array.isArray(
        customFeeds
      )
        ? customFeeds
        : []
    )

  ];


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


  console.log(
    `Configured RSS feeds: ${feeds.length}`
  );


  /*
   * Run Fire and HPS in parallel with RSS.
   */

  const [
    rssGroups,
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


  const all =
    [

      ...rssGroups.flat(),

      ...police,

      ...fire

    ];


  const unique =
    [
      ...new Map(
        all
          .filter(
            item =>
              item &&
              item.sourceUrl
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
    `Collected ${unique.length} unique source records.`
  );


  let processed =
    0;

  let mapped =
    0;

  let skipped =
    0;


  for (
    let i = 0;
    i < unique.length;
    i++
  ) {

    const raw =
      unique[i];


    try {

      const record =
        await enrich(
          raw
        );


      if (
        !record
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


      if (
        processed %
          25 ===
        0
      ) {

        console.log(
          `Progress: processed=${processed} mapped=${mapped} skipped=${skipped} remaining=${unique.length - i - 1}`
        );

      }


    }
    catch (
      error
    ) {

      skipped++;


      console.warn(
        `Record failed: ${raw.title}`,
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
