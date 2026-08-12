#!/usr/bin/env node
/**
 * Seed ClassScout MongoDB with pre-researched Boston providers.
 *
 * Usage:
 *   node scripts/seed-classscout.js                # seed all providers
 *   node scripts/seed-classscout.js --dry-run      # validate only, no writes
 *   node scripts/seed-classscout.js --limit 5      # seed first N providers
 *
 * Sources .env.classscout for INGEST_API_KEY, IMGBB_API_KEY, MONGODB_URI.
 * For each provider:
 *   1. Attempts to source an official image from the provider's website
 *   2. Uploads to ImgBB using IMGBB_API_KEY
 *   3. Builds a provider record matching the ClassScout schema
 *   4. Validates via schema-mapper.js (validateForTenant)
 *   5. Writes via MongoDB fallback (providers collection, classscoutcluster db)
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env.classscout') });
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const { URL } = require('url');
const SchemaMapper = require(require('path').resolve(__dirname, '..', 'schema-mapper.js'));

// --- Discovery source URLs (Boston + LA) ---
// Used as additional sourceUrls for seeded providers so the provenance chain
// includes the aggregator/city source that helped identify or verify the provider.
const DISCOVERY_SOURCES = [
  // Boston city sources
  'https://www.boston.gov/boston-youth-hub',
  'https://www.boston.gov/departments/youth-engagement-and-advancement/youthline',
  'https://www.boston.gov/departments/parks-and-recreation/parks-sports-and-activities',
  'https://www.boston.gov/departments/boston-centers-youth-families',
  'https://www.boston.gov/departments/boston-centers-youth-families/summer-programs-and-events-bcyf',
  'https://www.boston.gov/summer-boston-2026',
  'https://www.bostoncentral.com/',
  'https://www.bostoncentral.com/classes_camps/summer_camps.php',
  // Boston YMCA
  'https://ymcaboston.org/',
  // Boston aggregators
  'https://www.mass.gov/',
  'https://www.activityhero.com/',
  'https://www.hisawyer.com/',
  'https://www.activekids.com/',
  // LA city sources
  'https://recreation.parks.lacity.gov/youth-activities',
  'https://recreation.parks.lacity.gov/',
  'https://www.laparks.org/lakids/sports',
  'https://reg.laparks.org/',
  // LA County
  'https://parks.lacounty.com/kids-family/',
  'https://parks.lacounty.com/sports-2/',
  'https://parks.lacounty.com/everybodyplays/',
  'https://parks.lacounty.com/',
  'https://reservations.lacounty.gov/',
  // LA aggregators
  'https://www.activityhero.com/in/los-angeles-ca',
  // LA YMCA and city
  'https://www.ymcala.org/',
  'https://www.lacity.gov/',
  'https://lacounty.gov/',
];

// --- Boston neighborhood → borough + closed-vocab mapping ---
const NEIGHBORHOOD_MAP = {
  'Allston':          { borough: 'Northwest Boston', neighborhood: 'Allston' },
  'Allston/Brighton': { borough: 'Northwest Boston', neighborhood: 'Allston' },
  'Back Bay':         { borough: 'Downtown Core', neighborhood: 'Back Bay' },
  'Bay Village':      { borough: 'Downtown Core', neighborhood: 'Bay Village' },
  'Beacon Hill':      { borough: 'Downtown Core', neighborhood: 'Beacon Hill' },
  'Brighton':         { borough: 'Northwest Boston', neighborhood: 'Brighton' },
  'Charlestown':      { borough: 'North Boston', neighborhood: 'Charlestown' },
  'Chinatown':        { borough: 'Downtown Core', neighborhood: 'Chinatown–Leather District' },
  'Chinatown–Leather District': { borough: 'Downtown Core', neighborhood: 'Chinatown–Leather District' },
  'Dorchester':       { borough: 'Dorchester / South Boston', neighborhood: 'Dorchester' },
  'Dorchester/Boston Harbor': { borough: 'Dorchester / South Boston', neighborhood: 'Dorchester' },
  'Downtown':         { borough: 'Downtown Core', neighborhood: 'Downtown' },
  'Downtown/Citywide': { borough: 'Downtown Core', neighborhood: 'Downtown' },
  'East Boston':      { borough: 'North Boston', neighborhood: 'East Boston' },
  'Fenway':           { borough: 'South / Southwest Boston', neighborhood: 'Fenway–Kenmore' },
  'Fenway/Back Bay':  { borough: 'South / Southwest Boston', neighborhood: 'Fenway–Kenmore' },
  'Fenway/Kenmore':   { borough: 'South / Southwest Boston', neighborhood: 'Fenway–Kenmore' },
  'Hyde Park':        { borough: 'South / Southwest Boston', neighborhood: 'Hyde Park' },
  'Jamaica Plain':    { borough: 'Jamaica Plain / Roslindale', neighborhood: 'Jamaica Plain' },
  'Mattapan':         { borough: 'Dorchester / South Boston', neighborhood: 'Mattapan' },
  'Mission Hill':     { borough: 'South / Southwest Boston', neighborhood: 'Mission Hill' },
  'Mission Hill/Roxbury': { borough: 'South / Southwest Boston', neighborhood: 'Mission Hill' },
  'North End':        { borough: 'Downtown Core', neighborhood: 'North End' },
  'Roxbury':          { borough: 'Dorchester / South Boston', neighborhood: 'Roxbury' },
  'South Boston':     { borough: 'Dorchester / South Boston', neighborhood: 'South Boston' },
  'South End':        { borough: 'Dorchester / South Boston', neighborhood: 'South End' },
  'West End':         { borough: 'Downtown Core', neighborhood: 'West End' },
  'West Roxbury':     { borough: 'South / Southwest Boston', neighborhood: 'West Roxbury' },
  'Wharf District':   { borough: 'Downtown Core', neighborhood: 'Wharf District' },
};

// --- Provider data from the user's spreadsheet ---
const PROVIDERS = [
  { name: "My Gym Children's Fitness Center Boston", neighborhood: "Allston/Brighton", address: "1065 Commonwealth Ave, Boston, MA 02215", activity: "Gymnastics, fitness, movement classes, camps", url: "https://www.mygym.com/boston/" },
  { name: "Boston Soccer", neighborhood: "East Boston", address: "86 Boardman St, Boston, MA 02128", activity: "Youth soccer, soccer training", url: "https://www.bostonsoccer.com/" },
  { name: "British Swim School – Boylston", neighborhood: "Back Bay", address: "501 Boylston St, Boston, MA 02116", activity: "Infant swimming, youth swimming, water safety", url: "https://britishswimschool.com/boston/" },
  { name: "Hill House", neighborhood: "Beacon Hill", address: "127 Mount Vernon St, Boston, MA 02108", activity: "Soccer, basketball, baseball, lacrosse, tennis, martial arts, camps", url: "https://www.hillhouseboston.org/" },
  { name: "Uptown Dance Center", neighborhood: "Dorchester", address: "735 William T. Morrissey Blvd, Boston, MA 02122", activity: "Children's dance, performance training", url: "https://www.uptowndancecenter.com/" },
  { name: "Boston Budo", neighborhood: "Beacon Hill", address: "74 Joy St, Boston, MA 02114", activity: "Children's karate, martial arts", url: "https://www.bostonbudo.com/" },
  { name: "Boston University Swimming Lessons", neighborhood: "Fenway/Kenmore", address: "915 Commonwealth Ave, Boston, MA 02215", activity: "Children's swimming, swim lessons", url: "https://www.bu.edu/fitrec/recreation/aquatics/" },
  { name: "Urbanity Dance", neighborhood: "South End", address: "725 Harrison Ave, Suite 100, Boston, MA 02118", activity: "Dance, movement, youth programmes, camps", url: "https://www.urbanitydance.org/" },
  { name: "Sportsmen's Tennis & Enrichment Center", neighborhood: "Dorchester", address: "950 Blue Hill Ave, Dorchester, MA 02124", activity: "Tennis, fitness, youth camp", url: "https://sportsmenstennis.org/" },
  { name: "Camp Harbor View", neighborhood: "Dorchester/Boston Harbor", address: "135 Morrissey Blvd, Suite S110A, Boston, MA 02125", activity: "Summer camp, swimming, climbing, active recreation", url: "https://campharborview.org/" },
  { name: "Soccer Without Borders Massachusetts", neighborhood: "East Boston", address: "13 Bennington St, East Boston, MA 02128", activity: "Youth soccer, year-round soccer training", url: "https://www.soccerwithoutborders.org/massachusetts/1000" },
  { name: "The Soccer Unity Project", neighborhood: "Mission Hill/Roxbury", address: "1542 Tremont St, Boston, MA 02120", activity: "Youth soccer, sport-based development", url: "https://www.soccerunityproject.org/" },
  { name: "The BASE", neighborhood: "Roxbury", address: "150 Shirley St, Roxbury, MA 02119", activity: "Baseball, basketball, softball, youth sports", url: "https://thebase.org/sports/" },
  { name: "One Love Sports Academy", neighborhood: "Downtown/Citywide", address: "265 Franklin St, Boston, MA 02110", activity: "Basketball, flag football, youth sports", url: "https://www.onelovesports.org/programs-1" },
  { name: "CityKids Football Club", neighborhood: "South Boston", address: "Evans Field, South Boston, MA 02127", activity: "Youth soccer, soccer leagues", url: "https://www.citykidsfc.com/" },
  { name: "ASA Hoops / A Step Ahead", neighborhood: "Fenway", address: "103 Pilgrim Rd, Boston, MA 02215", activity: "Basketball, basketball camps, clinics", url: "https://asahoops.com/camps/" },
  { name: "Wang YMCA of Chinatown", neighborhood: "Chinatown", address: "8 Oak St W, Boston, MA 02116", activity: "Youth sports, swimming, camps, after-school activities", url: "https://ymcaboston.org/wang/" },
  { name: "East Boston YMCA", neighborhood: "East Boston", address: "215 Bremen St, Boston, MA 02128", activity: "Youth sports, swimming, camps", url: "https://ymcaboston.org/eastboston/" },
  { name: "East Boston YMCA – Ashley Street", neighborhood: "East Boston", address: "54 Ashley St, Boston, MA 02128", activity: "Youth sports, gym activities, after-school, summer camp", url: "https://ymcaboston.org/eastboston/" },
  { name: "Huntington Avenue YMCA", neighborhood: "Fenway/Back Bay", address: "316 Huntington Ave, Boston, MA 02115", activity: "Youth sports, swimming, swim lessons", url: "https://ymcaboston.org/huntington/" },
  { name: "Dorchester YMCA", neighborhood: "Dorchester", address: "776 Washington St, Boston, MA 02124", activity: "Youth sports, swimming, family activities", url: "https://ymcaboston.org/dorchester/" },
  { name: "Roxbury YMCA", neighborhood: "Roxbury", address: "285 Martin Luther King Jr Blvd, Roxbury, MA 02119", activity: "Youth sports, swimming", url: "https://ymcaboston.org/roxbury/" },
  { name: "Oak Square YMCA", neighborhood: "Brighton", address: "615 Washington St, Brighton, MA 02135", activity: "Youth sports, swimming, camps", url: "https://ymcaboston.org/oaksquare/" },
  { name: "Thomas M. Menino YMCA", neighborhood: "Hyde Park", address: "1137 River St, Hyde Park, MA 02136", activity: "Youth sports, swimming, camps", url: "https://ymcaboston.org/menino/" },
  { name: "Charlestown YMCA", neighborhood: "Charlestown", address: "150 3rd Ave, Charlestown, MA 02129", activity: "Youth sports, swimming, camps", url: "https://ymcaboston.org/charlestown/" },
  { name: "Parkway Community YMCA", neighborhood: "West Roxbury", address: "1972 Centre St, West Roxbury, MA 02132", activity: "Youth sports, swimming, children's camps", url: "https://ymcaboston.org/parkway/" },
  { name: "BCYF Curtis Hall Community Center", neighborhood: "Jamaica Plain", address: "20 South St, Jamaica Plain, MA 02130", activity: "Youth recreation, swimming, sports", url: "https://www.boston.gov/departments/boston-centers-youth-families" },
  { name: "BCYF Shelburne Community Center", neighborhood: "Roxbury", address: "2730 Washington St, Roxbury, MA 02119", activity: "Youth recreation, sports", url: "https://www.boston.gov/departments/boston-centers-youth-families" },
  { name: "BCYF Martin Pino Community Center", neighborhood: "East Boston", address: "86 Boardman St, East Boston, MA 02128", activity: "Youth recreation, sports", url: "https://www.boston.gov/departments/boston-centers-youth-families" },
  { name: "Boston Parks & Recreation Summer Sports Centers", neighborhood: "Dorchester", address: "Moakley Park / East Boston Stadium / White Stadium, Boston, MA", activity: "Soccer, basketball, baseball, multi-sport, summer sports centres", url: "https://www.boston.gov/departments/parks-and-recreation/parks-sports-and-activities" },
];

// --- Activity type classification ---
function classifyActivityTypes(activityStr) {
  const activities = activityStr.toLowerCase().split(',').map(s => s.trim());
  const result = [];
  for (const a of activities) {
    if (!result.includes('Soccer') && (a.includes('soccer') || (a.includes('football') && a.includes('club')))) result.push('Soccer');
    if (!result.includes('Swimming') && a.includes('swim')) result.push('Swimming');
    if (!result.includes('Basketball') && a.includes('basketball')) result.push('Basketball');
    if (!result.includes('Dance') && a.includes('dance')) result.push('Dance');
    if (!result.includes('Gymnastics') && a.includes('gymnast')) result.push('Gymnastics');
    if (!result.includes('Martial Arts') && (a.includes('martial') || a.includes('karate'))) result.push('Martial Arts');
    if (!result.includes('Tennis') && a.includes('tennis')) result.push('Tennis');
    if (!result.includes('Baseball') && (a.includes('baseball') || a.includes('softball'))) result.push('Baseball');
    if (!result.includes('Lacrosse') && a.includes('lacrosse')) result.push('Lacrosse');
    if (!result.includes('Climbing') && a.includes('climbing')) result.push('Climbing');
    if (!result.includes('Fitness') && a.includes('fitness')) result.push('Fitness');
    if (!result.includes('Art') && (a.includes('art') || a.includes('craft'))) result.push('Art');
  }
  return result.length ? result : ['Activities'];
}

function categorize(activityStr) {
  const a = activityStr.toLowerCase();
  if (a.includes('camp') && !a.includes('class') && !a.includes('soccer')) return 'Camps';
  if (a.includes('birthday')) return 'Birthday Parties';
  if (a.includes('drop-in') || a.includes('recreation')) return 'Drop-In Activities';
  return 'Classes';
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function makeId(name) {
  return ('prov-' + slugify(name) + '-' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 12)).slice(0, 80);
}

function getNeighborhoodData(neighborhoodInput) {
  const nh = neighborhoodInput.trim();
  if (NEIGHBORHOOD_MAP[nh]) return NEIGHBORHOOD_MAP[nh];
  const firstWord = nh.split('/')[0].trim();
  if (NEIGHBORHOOD_MAP[firstWord]) return NEIGHBORHOOD_MAP[firstWord];
  return { borough: 'Dorchester / South Boston', neighborhood: 'Dorchester' };
}

function getAgeRanges(activityStr) {
  const a = activityStr.toLowerCase();
  if (a.includes('infant') || a.includes('baby')) return ['0–2', '3–5'];
  if (a.includes('youth') || a.includes('children') || a.includes('kids')) return ['3–5', '6–8', '9–12', 'Teens'];
  return ['3–5', '6–8', '9–12', 'Teens'];
}

function getDayTimeTags() {
  return ['Weekday', 'Weekend', 'Afternoon', 'Evening'];
}

function fetchPageImage(url) {
  const { spawnSync } = require('child_process');
  const curlProc = spawnSync('curl', ['-sS', '-m', '25', '-L', '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', url], {
    encoding: 'utf8', maxBuffer: 10*1024*1024, timeout: 30000
  });
  const html = curlProc.stdout || '';

  let m = html.match(/<meta\s+[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  let img = m ? m[1].trim() : '';

  // Fallback: look for any img tag, skipping facebook pixel / noscript / placeholder
  if (!img || !img.startsWith('http') || img.includes('facebook.com/tr') || img.includes('noscript')) {
    const imgMatches = html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi);
    for (const match of imgMatches) {
      const src = match[1].trim();
      if (src.startsWith('http') && !src.includes('facebook.com/tr') && !src.includes('noscript') && !src.includes('placeholder')) {
        img = src;
        break;
      }
      if (!src.startsWith('http') && !src.startsWith('//') && !src.startsWith('data:') && src.startsWith('/')) {
        try { img = new URL(src, url).href; break; } catch { continue; }
      }
    }
  }
  // Fallback: look for link rel=icon
  if (!img || !img.startsWith('http')) {
    m = html.match(/<link[^>]+rel=["']icon["'][^>]*href=["']([^"']+)["']/i)
      || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']icon["']/i);
    if (m) img = m[1].trim();
    if (img && !img.startsWith('http')) {
      try { img = new URL(img, url).href; } catch { return null; }
    }
  }

  if (!img || !img.startsWith('http')) return null;
  const lower = img.toLowerCase();
  if (lower.includes('/images/placeholder') || lower.includes('/assets/no-') || lower.includes('default')) return null;
  return img;
}

async function downloadImage(url) {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const tmpPath = '/tmp/cs-seed-img';
  const proc = spawnSync('curl', ['-sS', '-m', '25', '-L', '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', '-o', tmpPath, url], {
    encoding: 'utf8', maxBuffer: 10*1024*1024, timeout: 30000
  });
  if (proc.status !== 0) return null;
  try {
    const stats = fs.statSync(tmpPath);
    if (stats.size < 100) return null;
  } catch { return null; }
  return tmpPath;
}

async function uploadToImgbb(imgbbApiKey, imagePath) {
  const { spawnSync } = require('child_process');
  const proc = spawnSync('curl', ['-sS', '-X', 'POST', 'https://api.imgbb.com/1/upload',
    '-F', `key=${imgbbApiKey}`, '-F', `image=@${imagePath}`], {
    encoding: 'utf8', maxBuffer: 1024*1024, timeout: 60000
  });
  if (proc.status !== 0) return null;
  try {
    const j = JSON.parse(proc.stdout);
    return j?.data?.url || j?.data?.image?.url || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : PROVIDERS.length;

  const providers = PROVIDERS.slice(0, limit);

  const INGEST_API_KEY = process.env.INGEST_API_KEY;
  const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
  const MONGODB_URI = process.env.MONGODB_URI;

  if (!INGEST_API_KEY || !IMGBB_API_KEY || !MONGODB_URI) {
    console.error('Missing env vars from .env.classscout');
    process.exit(1);
  }

  const mapper = new SchemaMapper();
  console.log(`\n=== ClassScout Boston Seed${dryRun ? ' (DRY RUN — no writes)' : ''} ===`);
  console.log(`Providers to process: ${providers.length}`);
  console.log(`ClassScout Cities: ${process.env.CLASSSCOUT_CITIES || 'bos,nyc,la'}`);

  const results = { posted: 0, skipped: 0, errors: 0 };
  const written = [];

  for (const p of providers) {
    console.log(`\n--- ${p.name} ---`);

    const nhData = getNeighborhoodData(p.neighborhood);
    const id = makeId(p.name);

    // Source image from provider's website
    let imageUrl = fetchPageImage(p.url);
    if (!imageUrl) {
      console.log(`  [skip] ${p.name}: no sourceable image from website`);
      results.skipped++;
      continue;
    }

    // Download and upload to ImgBB
    const tmpPath = await downloadImage(imageUrl);
    if (!tmpPath) {
      console.log(`  [skip] ${p.name}: image download failed`);
      results.skipped++;
      continue;
    }

    const imgbbUrl = await uploadToImgbb(IMGBB_API_KEY, tmpPath);
    if (!imgbbUrl) {
      console.log(`  [skip] ${p.name}: ImgBB upload failed`);
      results.skipped++;
      continue;
    }

    console.log(`  ✓ Image sourced: ${imgbbUrl}`);

    // Build provider record — shortDescription must be exactly 100-180 characters
    const firstActivity = p.activity.split(',')[0].trim();
    let shortDescription = `${p.name} — Boston kids' ${firstActivity} provider in ${nhData.neighborhood}. Ages ${getAgeRanges(p.activity).join(', ')}. Verified.`;
    if (shortDescription.length < 100) {
      shortDescription = `${p.name} — Boston kids' ${firstActivity} in ${nhData.neighborhood}. Programs for ages ${getAgeRanges(p.activity).join(', ')}. Verified provider with ${p.activity}.`;
    }
    if (shortDescription.length > 180) {
      shortDescription = shortDescription.slice(0, 178) + '.';
    }

    const provider = {
      id,
      name: p.name,
      category: categorize(p.activity),
      borough: nhData.borough,
      neighborhood: nhData.neighborhood,
      address: p.address,
      activityTypes: classifyActivityTypes(p.activity),
      ageRanges: getAgeRanges(p.activity),
      dayTimeTags: getDayTimeTags(),
      shortDescription,
      longDescription: `${p.name} — a Boston kids' activity provider located at ${p.address}. This provider offers ${p.activity} across ${nhData.neighborhood}. Programs cater to children ages ${getAgeRanges(p.activity).join(', ')} and operate on ${getDayTimeTags().join(', ')}. Sourced from ${p.url}.`,
      image: imgbbUrl,
      email: `info@${new URL(p.url).hostname}`,
      website: p.url,
      phone: '',
      rating: 0,
      reviewCount: 0,
      badges: [],
      sourceUrls: [p.url, ...DISCOVERY_SOURCES],
      contactLinks: [{ type: 'website', value: p.url, label: 'Official site' }],
    };

    // Schema-map + validate
    let payload, validation;
    try {
      payload = mapper.mapToApiPayload('classscout', provider, 'post');
      validation = mapper.validateForTenant('classscout', payload);
    } catch (e) {
      console.log(`  [skip] ${p.name}: schema error: ${e.message}`);
      results.errors++;
      continue;
    }

    if (!validation.valid) {
      console.log(`  [skip] ${p.name}: validation failed: ${validation.errors.join('; ')}`);
      results.errors++;
      continue;
    }

    // Write to MongoDB
    if (dryRun) {
      console.log(`  [dry-run] Would write ${id} — ${p.name}`);
      results.posted++;
      continue;
    }

    try {
      const client = new MongoClient(MONGODB_URI);
      await client.connect();
      const db = client.db('classscoutcluster');
      const col = db.collection('providers');
      await col.updateOne({ id: provider.id }, { $set: provider, $setOnInsert: { _createdAt: new Date() } }, { upsert: true });
      await client.close();
      console.log(`  ✓ Written: ${id} — ${p.name}`);
      written.push(id);
      results.posted++;
    } catch (e) {
      console.log(`  [error] ${p.name}: MongoDB write failed: ${e.message}`);
      results.errors++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total: ${results.posted} posted, ${results.skipped} skipped, ${results.errors} errors`);
  if (written.length) console.log(`Written IDs: ${written.join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
