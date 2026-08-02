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
 *     by cogmap/seyu/dvsc today; 'program-api' for a ClassScout-shaped
 *     programs schema, not currently used by any tenant but kept working).
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
 */

const fs = require('fs');
const path = require('path');

const TENANTS_PATH = path.join(__dirname, 'tenants.json');

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
   * @returns {object} tenant-specific payload ready for POST/PUT
   */
  mapToApiPayload(tenantId, genericRecord) {
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
        return this._mapClassScout(tenant, payload);
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
   */
  _mapClassScout(tenant, payload) {
    // Remove any lead-specific fields that shouldn't be in programs
    const leadOnlyFields = [
      'pro_for_organization', 'con_for_organization',
      'decision_maker_name', 'decision_maker_title', 'decision_maker_contact',
      'contact_phone', 'iceScore', 'sortOrder', 'ice', 'kanbanColumn',
      'entity_name', 'name', 'board'
    ];

    for (const field of leadOnlyFields) {
      delete payload[field];
    }

    // Standardize contacts if present
    this._standardizeContacts(payload);

    return payload;
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

  _validateProgram(tenant, payload, errors) {
    // ClassScout programs use different field names than leads
    // Validate core program fields
    if (!payload.name || (typeof payload.name === 'string' && payload.name.trim() === '')) {
      errors.push('Program name is required');
    }
    if (!payload.provider || (typeof payload.provider === 'string' && payload.provider.trim() === '')) {
      errors.push('Provider is required');
    }

    // Validate age fields
    const ageMin = payload.age_min;
    const ageMax = payload.age_max;
    if (ageMin !== undefined && ageMax !== undefined) {
      const min = Number(ageMin);
      const max = Number(ageMax);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0 || min > max) {
        errors.push('age_min and age_max must be valid numbers with age_min <= age_max');
      }
    }

    // Validate pricing
    if (payload.pricing !== undefined && typeof payload.pricing !== 'object') {
      errors.push('pricing must be an object');
    }

    // Validate schedule
    if (payload.schedule !== undefined && !Array.isArray(payload.schedule)) {
      errors.push('schedule must be an array');
    }

    // Validate phone_or_email
    if (!payload.phone_or_email || (typeof payload.phone_or_email === 'string' && payload.phone_or_email.trim() === '')) {
      errors.push('phone_or_email is required');
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
          case 'list': return `${base}/api/leads?brand=${tenantId}&limit=1000`;
          case 'get': return `${base}/api/leads/${id}?brand=${tenantId}`;
          case 'post': return `${base}/api/leads?brand=${tenantId}`;
          case 'put': return `${base}/api/leads/${id}?brand=${tenantId}`;
          case 'health': return `${base}/api/health`;
          case 'stats': return `${base}/api/stats`;
          default: throw new Error(`Unknown action: ${action}`);
        }
      case 'program-api':
        switch (action) {
          case 'list': return `${base}/api/programs?limit=1000`;
          case 'get': return `${base}/api/programs/${id}`;
          case 'post': return `${base}/api/programs`;
          case 'put': return `${base}/api/programs/${id}`;
          case 'health': return `${base}/api/health`;
          case 'stats': return `${base}/api/stats`;
          case 'boroughs': return `${base}/api/boroughs`;
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
