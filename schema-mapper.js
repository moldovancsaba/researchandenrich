/**
 * ContentCreator Schema Mapper
 *
 * Translates generic ContentCreator fields into tenant-specific API payloads.
 * Prevents cross-tenant field contamination by mapping and validating at write time.
 *
 * Tenants are declared entirely in tenants.json -- this file never hardcodes
 * a tenant ID. Two config fields on each tenant object drive all dispatch:
 *   - `schemaFamily`: which API/schema shape this tenant's payloads follow
 *     ('sales-lead-api' for the salesleadgenerator-shaped lead schema shared
 *     by cogmap/seyu/dvsc today; 'program-api' for classscout's real
 *     `POST /api/ingest` batch-operations contract, matching its Provider
 *     Zod schema at classscout's `src/lib/curator/providerSchema.ts`).
 *   - `forecastModel` (sales-lead-api tenants only): 'deal-size-band' or
 *     'pricing-by-company' -- which forecast-field normalization/validation
 *     applies. A tenant using neither omits this field entirely; no
 *     forecast-field handling runs for it.
 *
 * Onboarding a new tenant that fits an EXISTING schemaFamily (the common
 * case -- another salesleadgenerator brand) requires ONLY a new entry in
 * tenants.json with a matching `schemaFamily`/`forecastModel` -- zero
 * changes to this file. A genuinely new schema shape (a different target
 * API entirely) needs a new `_map<Family>()`/`_validate<Family>()` pair and
 * a new `schemaFamily` case below -- still no tenant-ID-specific code.
 *
 * program-api note: unlike sales-lead-api, classscout has ONE endpoint
 * (`POST /api/ingest`) for both create and patch -- the HTTP verb never
 * changes, only the JSON body's `operations[].action`. `mapToApiPayload`
 * therefore takes a third `action` parameter ('post' for discovery/create,
 * 'put' for enrichment/patch) so it can build the right operation envelope;
 * sales-lead-api ignores this parameter entirely (its two HTTP verbs map
 * to two different URLs, decided by the caller, not by the payload shape).
 * classscout's ingest credential also has no readable list/get endpoint
 * (`getApiEndpoint('classscout', 'list'|'get')` throws) -- verification
 * uses `runtime/verifier/response-based.js` against the POST response's
 * own per-operation `{ok, error?}` results, not a re-fetch.
 */

const fs = require('fs');
const path = require('path');

const TENANTS_PATH = path.join(__dirname, 'tenants.json');

/**
 * Identifier accepted in a URL path segment. Deliberately narrow: it permits
 * MongoDB ObjectId hex strings and classscout's `prov-<slug>` form, and
 * excludes `/ ? # & . %` -- every character that can alter URL structure.
 *
 * Encoding alone is not sufficient. An id containing those characters is
 * malformed regardless, and accepting `%2F%2E%2E%2F` as a "valid, safely
 * encoded" identifier would be a correct-looking mistake.
 */
const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

class InvalidIdentifierError extends Error {
  constructor(value, reason) {
    super(reason);
    this.name = 'InvalidIdentifierError';
    this.value = value;
    this.reason = reason;
  }
}

function assertValidId(id, action) {
  if (id === null || id === undefined || id === '') {
    throw new InvalidIdentifierError(id, `record id is required for action '${action}'`);
  }
  if (typeof id !== 'string') {
    throw new InvalidIdentifierError(id, `record id must be a string, received ${typeof id}`);
  }
  if (!RECORD_ID_PATTERN.test(id)) {
    throw new InvalidIdentifierError(id, `record id must match ${RECORD_ID_PATTERN}: '${id}'`);
  }
  return id;
}

/**
 * Build an absolute endpoint URL. Path segments are percent-encoded and the
 * query is serialised by URLSearchParams, so no caller-supplied value can
 * introduce a separator.
 *
 * Query parameter order follows insertion order, which keeps output
 * byte-identical to the previous template-literal construction.
 */
function buildEndpoint(base, segments, query) {
  const normalisedBase = String(base).replace(/\/+$/, '');
  const encodedPath = segments.map((s) => encodeURIComponent(String(s))).join('/');
  const qs = new URLSearchParams(query).toString();
  const url = `${normalisedBase}/${encodedPath}${qs ? `?${qs}` : ''}`;
  new URL(url); // throws on a malformed base
  return url;
}

class SchemaMapper {
  constructor() {
    this.tenants = this._loadTenants();
  }

  _loadTenants() {
    const raw = fs.readFileSync(TENANTS_PATH, 'utf8');
    const config = JSON.parse(raw);
    return config.tenants || {};
  }

  getTenant(tenantId) {
    const tenant = this.tenants[tenantId];
    if (!tenant) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }
    return tenant;
  }

  listTenants() {
    return Object.keys(this.tenants).map(id => ({
      id,
      name: this.tenants[id].name,
      app: this.tenants[id].app,
      discoveryEnabled: this.tenants[id].discovery?.enabled ?? false,
      enrichmentEnabled: this.tenants[id].enrichment?.enabled ?? false
    }));
  }

  /**
   * Map a generic ContentCreator record to a tenant-specific API payload.
   * This is the main anti-contamination gate.
   *
   * Dispatches purely on `tenant.schemaFamily` (tenants.json) -- never on
   * tenant identity. A new tenant with a matching schemaFamily needs no
   * change here.
   *
   * @param {string} tenantId
   * @param {object} genericRecord - The record built by the agent
   * @param {'post'|'put'} [action='post'] - 'post' for discovery/create, 'put' for
   *   enrichment/patch. Only consulted by program-api tenants (see class docblock);
   *   sales-lead-api ignores it.
   * @returns {object} tenant-specific payload ready to send as the POST/PUT body
   */
  mapToApiPayload(tenantId, genericRecord, action = 'post') {
    const tenant = this.getTenant(tenantId);
    const payload = { ...genericRecord };

    // Remove any fields that belong to other tenants
    const forbidden = tenant.forbiddenFields || [];
    for (const field of forbidden) {
      delete payload[field];
    }

    switch (tenant.schemaFamily) {
      case 'sales-lead-api':
        return this._mapSalesLeadApi(tenant, payload);
      case 'program-api':
        return this._mapClassScout(tenant, payload, action);
      default:
        throw new Error(`Tenant '${tenantId}' has no (or an unrecognized) schemaFamily in tenants.json: ${tenant.schemaFamily}`);
    }
  }

  /**
   * The salesleadgenerator-shaped lead schema, shared by any tenant whose
   * tenants.json entry declares `schemaFamily: 'sales-lead-api'` (cogmap,
   * seyu, dvsc today -- a future tenant needs only the same declaration,
   * not a code change). Forecast-field normalization varies per tenant via
   * `tenant.forecastModel`, not per hardcoded tenant ID.
   */
  _mapSalesLeadApi(tenant, payload) {
    // All sales-lead-api tenants share the same brand field names:
    // pro_for_organization / con_for_organization
    // Nothing to remap here; keep payload as-is.

    // Do NOT force a board field for sales-lead-api tenants.
    // The SalesLeadGenerator API routes via `brand`, not `board`.

    // Standardize emails and phones
    this._standardizeContacts(payload);

    // 'deal-size-band' tenants (cogmap, dvsc -- dvsc reuses cogmap's own
    // model per issue #148 in salesleadgenerator) get recommended_tier/
    // revenue_model/estimated_participants normalization.
    if (tenant.forecastModel === 'deal-size-band') {
      if (payload.recommended_tier && typeof payload.recommended_tier === 'string') {
        const normalized = payload.recommended_tier.trim().toLowerCase();
        if (!['essential', 'performance', 'elite', 'multiple'].includes(normalized)) {
          payload.recommended_tier = 'essential';
        } else {
          payload.recommended_tier = normalized;
        }
      }
      if (payload.revenue_model && typeof payload.revenue_model === 'string') {
        const normalized = payload.revenue_model.trim().toLowerCase().replace(/[^a-z_]/g, '_');
        if (!['per_participant', 'revenue_share', 'hybrid'].includes(normalized)) {
          payload.revenue_model = 'per_participant';
        } else {
          payload.revenue_model = normalized;
        }
      }
      if (payload.estimated_participants !== undefined) {
        payload.estimated_participants = Math.max(0, Number(payload.estimated_participants) || 0);
      }
      if (payload.estimated_annual_revenue_usd !== undefined) {
        payload.estimated_annual_revenue_usd = Math.max(0, Number(payload.estimated_annual_revenue_usd) || 0);
      }
      if (payload.product_fit_notes && typeof payload.product_fit_notes === 'string') {
        payload.product_fit_notes = payload.product_fit_notes.trim();
      }
    }

    // 'pricing-by-company' tenants (seyu today) get pricingByCompany
    // normalization instead of the deal-size-band fields above -- a tenant
    // never has both models, per the mutually-exclusive branches here.
    if (tenant.forecastModel === 'pricing-by-company') {
      if (payload.pricingByCompany && typeof payload.pricingByCompany === 'object') {
        const normalized = {};
        for (const [company, data] of Object.entries(payload.pricingByCompany)) {
          const item = (data && typeof data === 'object') ? { ...data } : {};
          if ('currency' in item && typeof item.currency === 'string') {
            item.currency = item.currency.trim().toUpperCase();
          }
          if ('pricing_model' in item && typeof item.pricing_model === 'string') {
            const raw = item.pricing_model.trim().toLowerCase().replace(/[^a-z_]/g, '_');
            if (!['upfront_monthly', 'revenue_share', 'monthly_saas', 'annual_fee', 'custom'].includes(raw)) {
              item.pricing_model = 'custom';
            } else {
              item.pricing_model = raw;
            }
          }
          const numericKeys = ['upfront_eur', 'monthly_eur', 'annual_fee_eur', 'discount_percent', 'revenue_share_percent'];
          for (const key of numericKeys) {
            if (item[key] !== undefined) {
              item[key] = Math.max(0, Number(item[key]) || 0);
            }
          }
          if ('notes' in item && typeof item.notes === 'string') {
            item.notes = item.notes.trim();
          }
          normalized[company] = item;
        }
        payload.pricingByCompany = normalized;
      }
    }

    return payload;
  }

  /**
   * classscout's real Provider shape (`curatedProviderSchema` in classscout's
   * `src/lib/curator/providerSchema.ts`) -- NOT the flat program/lead shape
   * any prior classscout integration attempt used. Notably:
   *   - `category` is one of exactly 4 values (Classes/Camps/Birthday
   *     Parties/Drop-In Activities) -- the PROGRAM FORMAT, not the subject.
   *     Subject/activity ("Sports", "Art", "STEM", ...) belongs in the
   *     free-text `activityTypes` array instead.
   *   - `ageRanges` is a closed 5-bucket enum with an EN DASH character
   *     ("0–2", "3–5", "6–8", "9–12", "Teens"), not raw
   *     age_min/age_max numbers.
   *   - `image` and `website` are REQUIRED, non-empty, and validated
   *     (`image` must be an https ImgBB URL; `website` must be a valid URL)
   *     on every create/upsert AND on every patch-merge -- there is no
   *     image-optional path through `/api/ingest`. A discovery record with
   *     no sourced-and-uploaded ImgBB image cannot be written; see the
   *     discovery prompt's Image Sourcing section.
   *   - `id` must match `/^prov-[a-z0-9-]+$/`.
   */
  _mapClassScout(tenant, payload, action = 'post') {
    this._standardizeContacts(payload);
    if (payload.email && typeof payload.email === 'string') {
      payload.email = payload.email.toLowerCase().trim();
    }
    if (Array.isArray(payload.contactLinks)) {
      for (const link of payload.contactLinks) {
        if (link && link.type === 'email' && typeof link.value === 'string') {
          link.value = link.value.toLowerCase().trim();
        }
      }
    }

    if (action === 'put') {
      // Enrichment: only-changed fields, merged server-side against the
      // existing (already-valid) provider document by `provider.patch`.
      const { id, ...patch } = payload;
      return {
        operations: [
          { resource: 'provider', action: 'patch', id, patch },
        ],
      };
    }

    // Discovery: a brand-new provider document, defaults filled in for
    // fields the research agent has no factual basis to report (editorial
    // fields like `rating`/`reviewCount`/`badges` are never invented here --
    // classscout's own moderation/curation loop owns those).
    const provider = {
      id: payload.id,
      name: payload.name,
      category: payload.category,
      borough: payload.borough,
      neighborhood: payload.neighborhood,
      address: payload.address,
      activityTypes: payload.activityTypes || [],
      ageRanges: payload.ageRanges || [],
      dayTimeTags: payload.dayTimeTags || [],
      pricePerClass: typeof payload.pricePerClass === 'number' ? payload.pricePerClass : 0,
      shortDescription: payload.shortDescription,
      longDescription: payload.longDescription,
      rating: 0,
      reviewCount: 0,
      badges: [],
      image: payload.image,
      email: payload.email || '',
      website: payload.website,
      phone: payload.phone || '',
    };
    if (Array.isArray(payload.contactLinks) && payload.contactLinks.length > 0) {
      provider.contactLinks = payload.contactLinks;
    }
    if (Array.isArray(payload.sourceUrls) && payload.sourceUrls.length > 0) {
      provider.sourceUrls = payload.sourceUrls;
    }
    if (Array.isArray(payload.tags) && payload.tags.length > 0) {
      provider.tags = payload.tags;
    }

    return {
      operations: [
        { resource: 'providers', action: 'upsertMany', documents: [provider] },
      ],
    };
  }

  /**
   * Validate a payload for a specific tenant before sending to API.
   * Returns { valid: boolean, errors: string[] }
   *
   * differences. This validator enforces anti-contamination and basic shape.
   */
  validateForTenant(tenantId, payload) {
    const tenant = this.getTenant(tenantId);
    const errors = [];

    // Check required fields
    const required = tenant.qualityGate?.requiredFields || [];
    for (const field of required) {
      if (!payload[field] || (typeof payload[field] === 'string' && payload[field].trim() === '')) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // Check forbidden fields are not present
    const forbidden = tenant.forbiddenFields || [];
    for (const field of forbidden) {
      if (payload[field] !== undefined) {
        errors.push(`Forbidden field present: ${field}`);
      }
    }

    // Schema-family-specific validation -- dispatches on tenant.schemaFamily
    // (tenants.json), never on tenant identity. See mapToApiPayload() above.
    switch (tenant.schemaFamily) {
      case 'sales-lead-api':
        this._validateLead(tenant, payload, errors);
        break;
      case 'program-api':
        this._validateProgram(tenant, payload, errors);
        break;
      default:
        errors.push(`Tenant '${tenantId}' has no (or an unrecognized) schemaFamily in tenants.json: ${tenant.schemaFamily}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  _validateLead(tenant, payload, errors) {
    // Validate contacts
    if (payload.contacts && !Array.isArray(payload.contacts)) {
      errors.push('contacts must be an array');
    }

    // Validate emails are lowercase
    if (payload.contacts) {
      for (const contact of payload.contacts) {
        if (contact.email && contact.email !== contact.email.toLowerCase()) {
          errors.push(`Email not lowercase: ${contact.email}`);
        }
      }
    }

    // Validate phone format
    if (payload.contact_phone && !payload.contact_phone.startsWith('+')) {
      errors.push(`Phone not in international format: ${payload.contact_phone}`);
    }

    // Validate brand field shape -- pro_for_organization/con_for_organization
    // accept either a single string or a string[] in salesleadgenerator's
    // real schema (app/types.ts), not array-only as this check previously
    // assumed.
    const proField = tenant.brandFields?.pro;
    const conField = tenant.brandFields?.con;
    const isStringOrStringArray = (v) => v === undefined
      || typeof v === 'string'
      || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (proField && payload[proField] !== undefined && !isStringOrStringArray(payload[proField])) {
      errors.push(`${proField} must be a string or string[]`);
    }
    if (conField && payload[conField] !== undefined && !isStringOrStringArray(payload[conField])) {
      errors.push(`${conField} must be a string or string[]`);
    }

    // Validate deal-size-band forecast fields (see _mapSalesLeadApi above).
    if (tenant.forecastModel === 'deal-size-band') {
      const validTiers = ['essential', 'performance', 'elite', 'multiple'];
      const validRevenueModels = ['per_participant', 'revenue_share', 'hybrid'];
      if (payload.recommended_tier && !validTiers.includes(payload.recommended_tier)) {
        errors.push(`recommended_tier must be one of: ${validTiers.join(', ')}`);
      }
      if (payload.revenue_model && !validRevenueModels.includes(payload.revenue_model)) {
        errors.push(`revenue_model must be one of: ${validRevenueModels.join(', ')}`);
      }
      if (payload.estimated_participants !== undefined && (typeof payload.estimated_participants !== 'number' || payload.estimated_participants < 0)) {
        errors.push('estimated_participants must be a non-negative number');
      }
      if (payload.estimated_annual_revenue_usd !== undefined && (typeof payload.estimated_annual_revenue_usd !== 'number' || payload.estimated_annual_revenue_usd < 0)) {
        errors.push('estimated_annual_revenue_usd must be a non-negative number');
      }
    }
  }

  /**
   * Validates a `_mapClassScout`-produced ingest envelope against classscout's
   * real Provider contract -- a lightweight mirror of `curatedProviderSchema`
   * (classscout's `src/lib/curator/providerSchema.ts`), NOT re-implementing
   * every Zod rule (long text-quality checks like `validatePublicDescription`
   * stay authoritative server-side). Catches the mistakes a research agent is
   * actually likely to make: wrong category vocabulary, wrong age-range
   * format, a missing/invalid image, an id that doesn't match classscout's
   * required slug shape.
   */
  _validateProgram(tenant, payload, errors) {
    const CATEGORIES = ['Classes', 'Camps', 'Birthday Parties', 'Drop-In Activities'];
    const AGE_RANGES = ['0–2', '3–5', '6–8', '9–12', 'Teens'];
    const DAY_TAGS = ['Weekday', 'Weekend', 'Morning', 'Afternoon', 'Evening', 'After-school'];
    // Confirmed against a real live 422 rejection (2026-08-03): classscout's
    // server-side Zod schema enforces this exact set on contactLinks[].type --
    // 'linkedin' is a real, plausible-looking value a research agent will try
    // that is NOT in this list, and this local check did not previously catch
    // it, so the invalid write only failed at the live API, one operation late.
    const CONTACT_LINK_TYPES = ['website', 'registration', 'email', 'phone', 'instagram', 'facebook', 'other'];

    const op = payload.operations && payload.operations[0];
    if (!op) {
      errors.push('program-api payload must contain operations[0]');
      return;
    }

    if (op.action === 'patch') {
      const doc = op.patch || {};
      if (!op.id || typeof op.id !== 'string' || !/^prov-[a-z0-9-]+$/.test(op.id)) {
        errors.push(`patch id must match /^prov-[a-z0-9-]+$/: ${op.id}`);
      }
      this._validateProviderFieldsIfPresent(doc, errors, CATEGORIES, AGE_RANGES, DAY_TAGS, CONTACT_LINK_TYPES);
      return;
    }

    // create (providers.upsertMany)
    const doc = (op.documents && op.documents[0]) || {};
    if (!doc.id || typeof doc.id !== 'string' || !/^prov-[a-z0-9-]+$/.test(doc.id)) {
      errors.push(`id must match /^prov-[a-z0-9-]+$/: ${doc.id}`);
    }
    if (!doc.name || (typeof doc.name === 'string' && doc.name.trim() === '')) {
      errors.push('name is required');
    }
    if (!doc.category) {
      errors.push(`category is required and must be one of: ${CATEGORIES.join(', ')}`);
    }
    if (!doc.borough || (typeof doc.borough === 'string' && doc.borough.trim() === '')) {
      errors.push('borough is required');
    }
    if (!doc.neighborhood || (typeof doc.neighborhood === 'string' && doc.neighborhood.trim() === '')) {
      errors.push('neighborhood is required');
    }
    if (!doc.address || (typeof doc.address === 'string' && doc.address.length < 8)) {
      errors.push('address is required (min 8 chars)');
    }
    if (!Array.isArray(doc.activityTypes) || doc.activityTypes.length < 1) {
      errors.push('activityTypes must be a non-empty array');
    }
    if (!doc.shortDescription || doc.shortDescription.length < 10) {
      errors.push('shortDescription must be at least 10 characters');
    }
    if (!doc.longDescription || doc.longDescription.length < 40) {
      errors.push('longDescription must be at least 40 characters');
    }
    if (!doc.image || !/^https:\/\/(i\.)?ibb\.co\//.test(doc.image)) {
      errors.push('image is required and must be an https ImgBB URL (i.ibb.co) -- source and upload an official photo before writing; do not invent a placeholder');
    }
    if (!doc.website) {
      errors.push('website is required and must be a valid URL');
    } else {
      try { new URL(doc.website); } catch { errors.push(`website must be a valid URL: ${doc.website}`); }
    }
    this._validateProviderFieldsIfPresent(doc, errors, CATEGORIES, AGE_RANGES, DAY_TAGS, CONTACT_LINK_TYPES);
  }

  _validateProviderFieldsIfPresent(doc, errors, CATEGORIES, AGE_RANGES, DAY_TAGS, CONTACT_LINK_TYPES) {
    if (doc.category !== undefined && !CATEGORIES.includes(doc.category)) {
      errors.push(`category must be one of: ${CATEGORIES.join(', ')} (this is the program FORMAT, not the subject -- subjects like "Sports"/"Art" belong in activityTypes)`);
    }
    if (doc.borough !== undefined && (typeof doc.borough !== 'string' || doc.borough.trim() === '')) {
      errors.push('borough must be a non-empty string');
    }
    if (Array.isArray(doc.ageRanges)) {
      for (const range of doc.ageRanges) {
        if (!AGE_RANGES.includes(range)) {
          errors.push(`ageRanges entry not in the closed vocabulary (${AGE_RANGES.join(', ')}): ${range}`);
        }
      }
    }
    if (Array.isArray(doc.dayTimeTags)) {
      for (const tag of doc.dayTimeTags) {
        if (!DAY_TAGS.includes(tag)) {
          errors.push(`dayTimeTags entry not in the closed vocabulary (${DAY_TAGS.join(', ')}): ${tag}`);
        }
      }
    }
    if (Array.isArray(doc.contactLinks)) {
      for (const link of doc.contactLinks) {
        if (!link || !CONTACT_LINK_TYPES.includes(link.type)) {
          errors.push(`contactLinks[].type not in the closed vocabulary (${CONTACT_LINK_TYPES.join(', ')}): ${link && link.type}`);
        }
        // Confirmed against a real live 422 rejection (2026-08-03,
        // "contactLinks.0.label: Required"): classscout's server-side schema
        // requires a non-empty `label` per entry in addition to `type`/`value`,
        // and this was not previously checked locally.
        if (link && (typeof link.label !== 'string' || link.label.trim() === '')) {
          errors.push(`contactLinks[].label is required and must be a non-empty string: ${link && link.label}`);
        }
      }
    }
    // No exemption for an explicitly-empty string: `image` is hard-required on every
    // create AND every patch-merge (there is no image-optional path through
    // /api/ingest) -- a patch that sets image: '' would overwrite an existing valid
    // image and get rejected server-side, so it must fail local validation too,
    // the same as any other non-ImgBB value. Only an OMITTED key (undefined) is
    // fine on a patch (means "leave the existing image alone").
    if (doc.image !== undefined && !/^https:\/\/(i\.)?ibb\.co\//.test(doc.image)) {
      errors.push(`image must be an https ImgBB URL (i.ibb.co): ${doc.image}`);
    }
  }

  _standardizeContacts(payload) {
    // Lowercase all emails
    if (payload.contacts && Array.isArray(payload.contacts)) {
      for (const contact of payload.contacts) {
        if (contact.email) {
          contact.email = contact.email.toLowerCase();
        }
      }
    }

    // Standardize main contact fields
    if (payload.decision_maker_contact && typeof payload.decision_maker_contact === 'string') {
      payload.decision_maker_contact = payload.decision_maker_contact.toLowerCase();
    }
  }

  /**
   * Get the API endpoint for a tenant action. Dispatches on
   * `tenant.schemaFamily` (tenants.json), never on tenant identity -- a new
   * sales-lead-api tenant needs no change here. Every action for a
   * sales-lead-api tenant carries `?brand=${tenantId}` explicitly
   * (including post/get/put, not just list) -- salesleadgenerator's own
   * `resolveBrand()` defaults a missing/unrecognized `brand` param to
   * 'cogmap' rather than erroring, so omitting it here would have silently
   * written every non-cogmap tenant's leads into cogmap's own collection.
   * Confirmed directly against the live API (2026-08-02): a real
   * `POST /api/leads?brand=dvsc` succeeds and writes to dvsc's own
   * collection; there is no tenant whitelist on salesleadgenerator's side.
   */
  getApiEndpoint(tenantId, action, id = null) {
    const tenant = this.getTenant(tenantId);
    const base = tenant.apiBase;

    switch (tenant.schemaFamily) {
      case 'sales-lead-api':
        switch (action) {
          case 'list':
            return buildEndpoint(base, ['api', 'leads'], { brand: tenantId, limit: '1000' });
          case 'get':
          case 'put':
            // `id` comes from an agent-produced record assembled from web-sourced
            // content -- the least trustworthy input in the system. An unencoded
            // `?` here truncates the path and drops ?brand=, and
            // salesleadgenerator's resolveBrand() defaults a missing brand to
            // 'cogmap' -- so a seyu or dvsc write would silently land in cogmap's
            // collection. See docs/RUNTIME_ARCHITECTURE_NOTES.md §4a.
            return buildEndpoint(base, ['api', 'leads', assertValidId(id, action)],
              { brand: tenantId });
          case 'post':
            return buildEndpoint(base, ['api', 'leads'], { brand: tenantId });
          case 'health': return buildEndpoint(base, ['api', 'health'], {});
          case 'stats': return buildEndpoint(base, ['api', 'stats'], {});
          default: throw new Error(`Unknown action: ${action}`);
        }
      case 'program-api':
        // classscout has ONE real write endpoint for both create and patch --
        // `POST /api/ingest` -- the operation type lives in the request body
        // (see `_mapClassScout`'s action-dependent envelope), not the URL.
        // There is no ingest-credential-readable list/get endpoint (the
        // readable routes are staff-session-gated or publish-status-filtered)
        // -- 'list'/'get' throw here rather than pointing at a URL the agent
        // could call and be misled by a false-negative/false-positive.
        switch (action) {
          case 'post':
          case 'put':
          case 'health':
            return buildEndpoint(base, ['api', 'ingest'], {});
          case 'list':
          case 'get':
            throw new Error(`program-api has no ingest-credential-readable '${action}' endpoint -- verify writes via the POST response itself (runtime/verifier/response-based.js), not a re-fetch`);
          default: throw new Error(`Unknown action: ${action}`);
        }
      default:
        throw new Error(`Tenant '${tenantId}' has no (or an unrecognized) schemaFamily in tenants.json: ${tenant.schemaFamily}`);
    }
  }

  /**
   * Get enrichment criteria for a tenant
   */
  getEnrichmentCriteria(tenantId) {
    const tenant = this.getTenant(tenantId);
    return tenant.enrichmentCriteria || {};
  }

  /**
   * Get quality gate for a tenant
   */
  getQualityGate(tenantId) {
    const tenant = this.getTenant(tenantId);
    return tenant.qualityGate || {};
  }
}

module.exports = SchemaMapper;
module.exports.InvalidIdentifierError = InvalidIdentifierError;
module.exports.RECORD_ID_PATTERN = RECORD_ID_PATTERN;
