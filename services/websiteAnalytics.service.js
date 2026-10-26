import { getOrSet } from '../infra/cache.js';
import { isWebsiteDbConfigured, websiteCollection } from '../infra/websiteDb.js';
import { dateRangeFilter, resolveDateRange } from '../lib/dateRange.js';
import { createAppError } from '../lib/errors.js';
import { containsPattern } from '../lib/queryBuilder.js';

// The Website screen's analytics (founder, 2026-10-26): the visitors of engenx.in and its
// contact-form leads, read straight from the WEBSITE's database (infra/websiteDb.js), where the
// website's own tracker writes them:
//   pageviews { timestamp, path, referrer, device, browser, ipHash, ipAddress,
//               location { country, countryCode, regionName, city }, duration (seconds) }
//   leads     { name, email, company, phone, message, timestamp }
// Nothing is copied into the CRM and nothing is written to the website's database.
// Every number follows the date filter (India-time days, lib/dateRange.js).

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const TIME_ZONE = 'Asia/Kolkata';
// Without a date filter the traffic chart shows the last 30 days.
const DEFAULT_CHART_DAYS = 30;
// Longer than this, the chart counts per month instead of per day.
const MAX_DAILY_POINTS = 92;
const OVERVIEW_CACHE_SECONDS = 60;
const TOP_PAGES = 50;
const TOP_REFERRERS = 10;

export const getWebsiteStatus = () => ({ isConfigured: isWebsiteDbConfigured() });

function assertConfigured() {
  if (!isWebsiteDbConfigured()) {
    throw createAppError(
      'WEBSITE_NOT_CONNECTED',
      503,
      'The website database is not connected yet (setting WEBSITE_MONGODB_URI).',
    );
  }
}

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const round = (value) => Math.round(value ?? 0);

/** The India calendar day of a moment, as "YYYY-MM-DD". */
const indiaDay = (moment) => new Date(moment.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Every day (or month) between two moments, so the chart has no holes. */
function chartSlots(from, to, unit) {
  const slots = [];
  const seen = new Set();
  for (let moment = from.getTime(); moment < to.getTime(); moment += DAY_MS) {
    const day = indiaDay(new Date(moment));
    const key = unit === 'month' ? day.slice(0, 7) : day;
    if (!seen.has(key)) {
      seen.add(key);
      slots.push(key);
    }
  }
  return slots;
}

async function trafficOverTime(pageviews, resolved, now) {
  const to = resolved?.to ?? new Date(now.getTime());
  const from =
    resolved?.from ??
    // The start of the India day DEFAULT_CHART_DAYS - 1 days ago.
    new Date(
      Date.parse(
        `${indiaDay(new Date(now.getTime() - (DEFAULT_CHART_DAYS - 1) * DAY_MS))}T00:00:00+05:30`,
      ),
    );
  const unit = (to - from) / DAY_MS > MAX_DAILY_POINTS ? 'month' : 'day';
  const rows = await pageviews
    .aggregate([
      { $match: { timestamp: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: unit === 'month' ? '%Y-%m' : '%Y-%m-%d',
              date: '$timestamp',
              timezone: TIME_ZONE,
            },
          },
          views: { $sum: 1 },
          visitors: { $addToSet: '$ipHash' },
        },
      },
      { $project: { views: 1, visitors: { $size: '$visitors' } } },
    ])
    .toArray();
  const byKey = new Map(rows.map((row) => [row._id, row]));
  return {
    unit,
    points: chartSlots(from, to, unit).map((key) => ({
      date: key,
      views: byKey.get(key)?.views ?? 0,
      visitors: byKey.get(key)?.visitors ?? 0,
    })),
  };
}

async function buildOverview(query, now) {
  const resolved = resolveDateRange(query, now);
  const match = dateRangeFilter('timestamp', resolved);
  const [pageviews, leads] = await Promise.all([
    websiteCollection('pageviews'),
    websiteCollection('leads'),
  ]);
  const [facets] = await pageviews
    .aggregate([
      { $match: match },
      {
        $facet: {
          totals: [{ $group: { _id: null, views: { $sum: 1 }, avgStay: { $avg: '$duration' } } }],
          visitors: [{ $group: { _id: '$ipHash' } }, { $count: 'count' }],
          countries: [
            { $match: { 'location.countryCode': { $nin: [null, '', 'LCL', 'UN'] } } },
            { $group: { _id: '$location.countryCode' } },
            { $count: 'count' },
          ],
          pages: [
            {
              $group: {
                _id: '$path',
                views: { $sum: 1 },
                avgStay: { $avg: '$duration' },
              },
            },
            { $sort: { views: -1, _id: 1 } },
            { $limit: TOP_PAGES },
          ],
          engaged: [
            { $match: { duration: { $gt: 0 } } },
            { $group: { _id: '$path', avgStay: { $avg: '$duration' } } },
            { $sort: { avgStay: -1, _id: 1 } },
            { $limit: 1 },
          ],
          devices: [{ $group: { _id: '$device', views: { $sum: 1 } } }, { $sort: { views: -1 } }],
          referrers: [
            { $group: { _id: '$referrer', views: { $sum: 1 } } },
            { $sort: { views: -1, _id: 1 } },
            { $limit: TOP_REFERRERS },
          ],
        },
      },
    ])
    .toArray();
  const views = facets.totals[0]?.views ?? 0;
  const visitors = facets.visitors[0]?.count ?? 0;
  const [traffic, leadCount] = await Promise.all([
    trafficOverTime(pageviews, resolved, now),
    leads.countDocuments(match),
  ]);
  return {
    range: resolved ? { preset: resolved.preset, from: resolved.from, to: resolved.to } : null,
    summary: {
      pageviews: views,
      visitors,
      pagesPerVisitor: visitors > 0 ? Math.round((views / visitors) * 10) / 10 : 0,
      avgStaySeconds: round(facets.totals[0]?.avgStay),
      countries: facets.countries[0]?.count ?? 0,
      leads: leadCount,
    },
    mostEngagedPath: facets.engaged[0]
      ? { path: facets.engaged[0]._id, avgStaySeconds: round(facets.engaged[0].avgStay) }
      : null,
    traffic,
    topPages: facets.pages.map((row) => ({
      path: row._id ?? '/',
      views: row.views,
      share: share(row.views, views),
      avgStaySeconds: round(row.avgStay),
    })),
    devices: facets.devices.map((row) => ({
      device: row._id || 'Other',
      views: row.views,
      share: share(row.views, views),
    })),
    referrers: facets.referrers.map((row) => ({
      name: row._id || 'Direct',
      views: row.views,
      share: share(row.views, views),
    })),
  };
}

/**
 * Overview, Pages & Sources: totals, the traffic chart, pages, devices and where visitors came
 * from, all for the chosen dates. Cached for a minute per date range.
 * @param {{ range?: string, from?: string, to?: string }} query  Validated
 */
export async function getWebsiteOverview(query, now = new Date()) {
  assertConfigured();
  // Checked first, so a wrong range answers 400 and is never cached.
  const resolved = resolveDateRange(query, now);
  const key = resolved
    ? `website:overview:${resolved.from.toISOString()}:${resolved.to.toISOString()}`
    : `website:overview:all:${indiaDay(now)}`;
  return getOrSet(key, OVERVIEW_CACHE_SECONDS, () => buildOverview(query, now));
}

/**
 * Visitor sessions: one row per visitor (the website's hashed address) with where they are,
 * their device, the pages they opened, the time they stayed and when they were last seen.
 * @param {{ range?, from?, to?, search?: string, page: number, pageSize: number }} query
 */
export async function listWebsiteSessions(query, now = new Date()) {
  assertConfigured();
  const resolved = resolveDateRange(query, now);
  const pattern = query.search ? containsPattern(query.search) : null;
  const match = {
    ...dateRangeFilter('timestamp', resolved),
    ...(pattern
      ? {
          $or: [
            { ipAddress: pattern },
            { 'location.city': pattern },
            { 'location.regionName': pattern },
            { 'location.country': pattern },
            { path: pattern },
          ],
        }
      : {}),
  };
  const pageviews = await websiteCollection('pageviews');
  const skip = (query.page - 1) * query.pageSize;
  const [result] = await pageviews
    .aggregate([
      { $match: match },
      { $sort: { timestamp: 1 } },
      {
        $group: {
          _id: '$ipHash',
          ipAddress: { $last: '$ipAddress' },
          location: { $last: '$location' },
          device: { $last: '$device' },
          browser: { $last: '$browser' },
          pagesCount: { $sum: 1 },
          paths: { $addToSet: '$path' },
          totalDuration: { $sum: '$duration' },
          firstSeen: { $min: '$timestamp' },
          lastActive: { $max: '$timestamp' },
        },
      },
      { $sort: { lastActive: -1, _id: 1 } },
      {
        $facet: {
          rows: [{ $skip: skip }, { $limit: query.pageSize }],
          total: [{ $count: 'count' }],
        },
      },
    ])
    .toArray();
  return {
    items: result.rows.map((row) => ({
      id: String(row._id ?? 'unknown'),
      ipAddress: row.ipAddress ?? null,
      location: row.location
        ? {
            city: row.location.city ?? null,
            region: row.location.regionName ?? null,
            country: row.location.country ?? null,
            countryCode: row.location.countryCode ?? null,
          }
        : null,
      device: row.device ?? 'Other',
      browser: row.browser ?? 'Other',
      pagesCount: row.pagesCount,
      paths: [...row.paths].sort(),
      totalDurationSeconds: round(row.totalDuration),
      firstSeen: row.firstSeen,
      lastActive: row.lastActive,
    })),
    pagination: { page: query.page, pageSize: query.pageSize, total: result.total[0]?.count ?? 0 },
  };
}

/**
 * Contact-form leads of the website, newest first.
 * @param {{ range?, from?, to?, search?: string, page: number, pageSize: number }} query
 */
export async function listWebsiteLeads(query, now = new Date()) {
  assertConfigured();
  const resolved = resolveDateRange(query, now);
  const pattern = query.search ? containsPattern(query.search) : null;
  const filter = {
    ...dateRangeFilter('timestamp', resolved),
    ...(pattern
      ? {
          $or: [
            { name: pattern },
            { email: pattern },
            { company: pattern },
            { phone: pattern },
            { message: pattern },
          ],
        }
      : {}),
  };
  const leads = await websiteCollection('leads');
  const [rows, total] = await Promise.all([
    leads
      .find(filter)
      .sort({ timestamp: -1, _id: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .toArray(),
    leads.countDocuments(filter),
  ]);
  return {
    items: rows.map((row) => ({
      id: String(row._id),
      name: row.name ?? '',
      email: row.email || null,
      company: row.company || null,
      phone: row.phone || null,
      message: row.message || '',
      submittedAt: row.timestamp ?? null,
    })),
    pagination: { page: query.page, pageSize: query.pageSize, total },
  };
}
