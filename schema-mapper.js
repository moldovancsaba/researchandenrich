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
/**
 * sales-lead-api vocabularies. Declared once so the mapper and the validator
 * cannot drift apart -- they were previously duplicated as inline literals in
 * both.
 */
/**
 * The shared sales-lead field contract, mirrored from
 * `prompts/shared/sales-lead-fields.md`.
 *
 * The contract's rule is "emit every field on every record; empty if it cannot
 * be sourced, never omitted". Until now that was enforced by prompt discipline
 * alone: `scripts/verify-prompt-parity.js` proves the three prompts SAY the same
 * thing, but nothing proved the agent DID it. A live audit measured the result
 * -- sportCode at 90/84/0% and contactEmails at 4/30/95% across the three
 * tenants -- because `_mapSalesLeadApi` passed the payload through as-is.
 *
 * Backfilling here makes omission structurally impossible rather than a
 * compliance question, so cross-tenant percentages measure sourcing success
 * instead of prompt adherence.
 *
 * `scripts/verify-schema-mapper.js` asserts this list stays in step with the
 * prompt contract, so a field added on the operator's side fails the gate here
 * rather than silently going unbackfilled.
 */
const SALES_LEAD_CONTRACT_FIELDS = {
  // Identity and location
  entity_name: '', canonicalLeadName: '', url: '', region: '', country: '',
  cityName: '', address: '',
  // Classification
  industry: '', sport_or_sector: '', sportCode: '', level_league: '', size: '',
  classificationTags: [], tags: [], orgTypeCode: '', businessUnitCode: '',
  competitionLevelCode: '', demographicCodes: [], genderCode: '',
  parentOrgName: '', relationshipToParent: '',
  // Contact
  contacts: [], contactEmails: [], general_contact: '', contact_phone: '',
  decision_maker_name: '', decision_maker_title: '', decision_maker_contact: '',
  // Assessment
  value_proposition: '', pro_for_organization: '', con_for_organization: '',
  product_fit_notes: '', notes: '', priority: '',
  // Forecast
  recommended_tier: '', revenue_model: '', estimated_participants: 0,
  estimated_annual_revenue_usd: 0, pricingByCompany: {},
  // Provenance
  source: '', techSignals: [],
};

/**
 * Contract fields deliberately NOT backfilled, because salesleadgenerator
 * computes them server-side and sending an empty value risks clobbering or
 * rejecting a correct one.
 *
 *   ticketSizeEstimate -- derived from the tenant's dealSize bands in Sales
 *     Settings (RUNTIME_ARCHITECTURE_NOTES §6: `method: "tier_band"`).
 *   ice -- `ice.ease` is validated for format and then DISCARDED, recomputed
 *     from `computeEase(body)`. A record with no real contacts was rejected 422
 *     by the quality gate regardless of the submitted value (§6).
 *
 * The operator's 2026-08-12 dry run verified empty `recommended_tier` and
 * `revenue_model` are accepted (HTTP 200, stored ""); it explicitly did NOT
 * exercise ice.ease. These two stay omitted-if-absent until a dry run covers
 * them. Absent is the current, working behaviour; empty is the unverified one.
 */
const SALES_LEAD_SERVER_COMPUTED_FIELDS = ['ticketSizeEstimate', 'ice'];

const SALES_LEAD_TIERS = ['essential', 'performance', 'elite', 'multiple'];
const SALES_LEAD_REVENUE_MODELS = ['per_participant', 'revenue_share', 'hybrid'];
const SALES_LEAD_PRICING_MODELS = [
  'upfront_monthly', 'revenue_share', 'monthly_saas', 'annual_fee', 'custom',
];
const SALES_LEAD_PRICING_NUMERIC_KEYS = [
  'upfront_eur', 'monthly_eur', 'annual_fee_eur', 'discount_percent', 'revenue_share_percent',
];

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

/** Shape predicate applied before any property access or iteration. */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Resolve which document(s) a forbidden-field / required-field check should
 * inspect for a given schema family.
 *
 * sales-lead-api payloads are the flat record itself. program-api payloads are
 * an ingest envelope whose provider document sits two levels down, at
 * `operations[0].documents[i]` for a create or `operations[0].patch` for a
 * patch. Making that resolution an explicit, named step is the point: the
 * previous code implicitly assumed a shape only one of the two families
 * actually produces, and nothing made that assumption visible.
 *
 * @returns {{ok: true, documents: object[], context: string[]} | {ok: false, error: string}}
 */
function extractSubjectDocuments(schemaFamily, payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  if (schemaFamily === 'sales-lead-api') {
    return { ok: true, documents: [payload], context: ['<payload>'] };
  }

  if (schemaFamily === 'program-api') {
    const op = Array.isArray(payload.operations) ? payload.operations[0] : undefined;
    if (!op) {
      return { ok: false, error: 'program-api payload must contain operations[0]' };
    }

    if (op.action === 'patch') {
      if (op.patch === null || typeof op.patch !== 'object' || Array.isArray(op.patch)) {
        return { ok: false, error: 'program-api patch operation must contain an object patch' };
      }
      return { ok: true, documents: [op.patch], context: ['operations[0].patch'] };
    }

    if (Array.isArray(op.documents)) {
      const allObjects = op.documents.every((d) => d !== null && typeof d === 'object' && !Array.isArray(d));
      if (!allObjects) {
        return { ok: false, error: 'program-api documents[] must contain only objects' };
      }
      return {
        ok: true,
        documents: op.documents,
        context: op.documents.map((_, i) => `operations[0].documents[${i}]`),
      };
    }

    return {
      ok: false,
      error: 'program-api payload has an unrecognised operation shape: expected '
        + 'operations[0].documents or operations[0].patch',
    };
  }

  return { ok: false, error: `unrecognised schemaFamily: ${schemaFamily}` };
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
   * @param {'provider'|'meetupGroup'} [entityKind='provider'] - which classscout
   *   resource this record maps to. Only consulted by program-api tenants -- a
   *   sales-lead-api tenant models exactly one entity kind (a lead), so there's
   *   nothing to disambiguate there.
   * @returns {object} tenant-specific payload ready to send as the POST/PUT body
   */
  mapToApiPayload(tenantId, genericRecord, action = 'post', entityKind = 'provider') {
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
        return entityKind === 'meetupGroup'
          ? this._mapClassScoutMeetup(tenant, payload, action)
          : this._mapClassScout(tenant, payload, action);
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
  /**
   * The salesleadgenerator-shaped lead schema, shared by every tenant whose
   * tenants.json entry declares `schemaFamily: 'sales-lead-api'`.
   *
   * EVERY sales-lead-api tenant emits the SAME field set (owner decision
   * 2026-08-12). Fields a tenant's business logic does not populate are present
   * and empty, not absent. Previously the forecast fields were split by
   * `forecastModel` into two mutually exclusive branches: cogmap/dvsc emitted
   * recommended_tier / revenue_model / estimated_participants /
   * estimated_annual_revenue_usd / product_fit_notes, and seyu emitted
   * pricingByCompany instead. Those sets are disjoint, so seyu wrote a field
   * the others never wrote and omitted five they always wrote -- a format
   * divergence between clients of one API.
   *
   * `forecastModel` is retained but demoted: it no longer selects a payload
   * SHAPE, only describes which fields that tenant's prompt is expected to
   * populate. The shape is now identical for all of them.
   */
  _mapSalesLeadApi(tenant, payload) {
    // Backfill the shared contract first, so every tenant emits an identical
    // key set regardless of what the agent managed to source. Only ABSENT keys
    // are filled -- a sourced value, including a deliberate empty one, is never
    // overwritten.
    for (const [field, emptyValue] of Object.entries(SALES_LEAD_CONTRACT_FIELDS)) {
      if (payload[field] === undefined || payload[field] === null) {
        payload[field] = Array.isArray(emptyValue)
          ? []
          : (emptyValue !== null && typeof emptyValue === 'object' ? {} : emptyValue);
      }
    }

    // All sales-lead-api tenants share the same brand field names:
    // pro_for_organization / con_for_organization
    // Nothing to remap here; keep payload as-is.

    // Do NOT force a board field for sales-lead-api tenants.
    // The SalesLeadGenerator API routes via `brand`, not `board`.

    // Standardize emails and phones
    this._standardizeContacts(payload);

    // --- deal-size-band fields: normalised for EVERY tenant ---------------
    // An out-of-vocabulary value is coerced to the safe default only when the
    // caller supplied something; an absent field stays empty rather than being
    // invented as 'essential'.
    if (payload.recommended_tier !== undefined && payload.recommended_tier !== null
        && payload.recommended_tier !== '') {
      if (typeof payload.recommended_tier === 'string') {
        const normalized = payload.recommended_tier.trim().toLowerCase();
        payload.recommended_tier = SALES_LEAD_TIERS.includes(normalized)
          ? normalized
          : 'essential';
      }
    } else {
      payload.recommended_tier = '';
    }

    if (payload.revenue_model !== undefined && payload.revenue_model !== null
        && payload.revenue_model !== '') {
      if (typeof payload.revenue_model === 'string') {
        const normalized = payload.revenue_model.trim().toLowerCase().replace(/[^a-z_]/g, '_');
        payload.revenue_model = SALES_LEAD_REVENUE_MODELS.includes(normalized)
          ? normalized
          : 'per_participant';
      }
    } else {
      payload.revenue_model = '';
    }

    payload.estimated_participants =
      payload.estimated_participants === undefined || payload.estimated_participants === null
        ? 0
        : Math.max(0, Number(payload.estimated_participants) || 0);

    payload.estimated_annual_revenue_usd =
      payload.estimated_annual_revenue_usd === undefined
      || payload.estimated_annual_revenue_usd === null
        ? 0
        : Math.max(0, Number(payload.estimated_annual_revenue_usd) || 0);

    payload.product_fit_notes =
      typeof payload.product_fit_notes === 'string' ? payload.product_fit_notes.trim() : '';

    // --- pricing-by-company field: normalised for EVERY tenant ------------
    if (payload.pricingByCompany && typeof payload.pricingByCompany === 'object'
        && !Array.isArray(payload.pricingByCompany)) {
      const normalized = {};
      for (const [company, data] of Object.entries(payload.pricingByCompany)) {
        const item = (data && typeof data === 'object') ? { ...data } : {};
        if ('currency' in item && typeof item.currency === 'string') {
          item.currency = item.currency.trim().toUpperCase();
        }
        if ('pricing_model' in item && typeof item.pricing_model === 'string') {
          const raw = item.pricing_model.trim().toLowerCase().replace(/[^a-z_]/g, '_');
          item.pricing_model = SALES_LEAD_PRICING_MODELS.includes(raw) ? raw : 'custom';
        }
        for (const key of SALES_LEAD_PRICING_NUMERIC_KEYS) {
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
    } else {
      payload.pricingByCompany = {};
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
   * classscout's `MeetupGroup` shape (`curatedMeetupSchema` in classscout's
   * `src/lib/meetupSchema.ts`) -- a genuinely different, simpler resource than
   * Provider, not a variant of it. Notably:
   *   - `groupType` is a closed 5-value enum (Parent Meetup/Mom Group/Playdate
   *     Group/New Parents/Neighborhood Families) -- there is no `activityTypes`
   *     free-text field on this resource at all.
   *   - `ageRange` is a SINGLE value from its own closed 8-value vocabulary
   *     (0–2/0–3/0–5/0–6/2–5/2–8/3–5/All ages, en dashes) -- not an array, and
   *     not the same vocabulary as Provider's `ageRanges`.
   *   - `cadence` is a closed 4-value enum (Weekly/Monthly/Weekend/Pop-up).
   *   - `coverImageUrl` is OPTIONAL -- unlike Provider's `image`, there is no
   *     hard image-sourcing requirement for a meetup group to be written.
   *   - `id` must match `/^meetup-[a-z0-9-]+$/` (not `prov-`).
   *   - `icon`/`palette` are closed display-only enums with no natural
   *     research-derived value -- see `_validateMeetup` for the recommended
   *     defaults rather than guessing.
   */
  _mapClassScoutMeetup(tenant, payload, action = 'post') {
    if (action === 'put') {
      const { id, ...patch } = payload;
      return {
        operations: [
          { resource: 'meetupGroup', action: 'patch', id, patch },
        ],
      };
    }

    const meetup = {
      id: payload.id,
      name: payload.name,
      borough: payload.borough,
      neighborhood: payload.neighborhood,
      groupType: payload.groupType,
      ageRange: payload.ageRange,
      cadence: payload.cadence,
      instagram: payload.instagram || '',
      website: payload.website,
      description: payload.description,
      initials: payload.initials,
      icon: payload.icon,
      palette: payload.palette,
    };
    if (payload.coverImageUrl) {
      meetup.coverImageUrl = payload.coverImageUrl;
    }

    return {
      operations: [
        { resource: 'meetupGroups', action: 'upsertMany', documents: [meetup] },
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

    // Resolve the document the forbidden/required checks should actually
    // inspect. These checks used to run against the top level of `payload`.
    // For program-api that is the ingest ENVELOPE ({ operations: [...] }), so
    // classscout's 13-entry forbiddenFields list was tested against keys that
    // are never there and passed vacuously on every call. See
    // docs/RUNTIME_ARCHITECTURE_NOTES.md for the finding.
    const extracted = extractSubjectDocuments(tenant.schemaFamily, payload);
    if (!extracted.ok) {
      // Fail loudly. Vacuous success on an unrecognised shape is the defect.
      errors.push(extracted.error);
      return { valid: false, errors };
    }

    const required = tenant.qualityGate?.requiredFields || [];
    const forbidden = tenant.forbiddenFields || [];

    extracted.documents.forEach((doc, i) => {
      const where = extracted.context[i];
      for (const field of forbidden) {
        if (doc[field] !== undefined) {
          errors.push(`Forbidden field present: ${field} (at ${where})`);
        }
      }
      for (const field of required) {
        const value = doc[field];
        if (value === undefined || value === null
            || (typeof value === 'string' && value.trim() === '')) {
          errors.push(`Missing required field: ${field} (at ${where})`);
        }
      }
    });

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
    // Contacts. The previous version pushed a shape error and then iterated
    // anyway, so `contacts: {}` threw "not iterable" and aborted the whole
    // agent run instead of rejecting one record. A string is iterable, so
    // Array.isArray is the necessary test -- `contacts: "a@b.c"` used to
    // iterate characters and silently report no errors, a false pass.
    if (payload.contacts !== undefined && payload.contacts !== null) {
      if (!Array.isArray(payload.contacts)) {
        errors.push('contacts must be an array');
        // Deliberately do not fall through to iteration.
      } else {
        payload.contacts.forEach((contact, i) => {
          if (!isPlainObject(contact)) {
            errors.push(`contacts[${i}] must be an object`);
            return;
          }
          if (contact.email !== undefined && contact.email !== null) {
            if (typeof contact.email !== 'string') {
              errors.push(`contacts[${i}].email must be a string`);
            } else if (contact.email !== contact.email.toLowerCase()) {
              errors.push(`Email not lowercase: ${contact.email}`);
            }
          }
        });
      }
    }

    // Phone format
    if (payload.contact_phone !== undefined && payload.contact_phone !== null
        && payload.contact_phone !== '') {
      if (typeof payload.contact_phone !== 'string') {
        errors.push('contact_phone must be a string');
      } else if (!payload.contact_phone.startsWith('+')) {
        errors.push(`Phone not in international format: ${payload.contact_phone}`);
      }
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
    // Forecast fields are validated for EVERY sales-lead-api tenant, because
    // every tenant now emits all of them (owner decision 2026-08-12). Empty is
    // a legitimate value -- a tenant whose business logic does not populate a
    // field sends it empty rather than omitting it -- so '' and 0 must pass.
    if (payload.recommended_tier !== undefined && payload.recommended_tier !== ''
        && !SALES_LEAD_TIERS.includes(payload.recommended_tier)) {
      errors.push(`recommended_tier must be empty or one of: ${SALES_LEAD_TIERS.join(', ')}`);
    }
    if (payload.revenue_model !== undefined && payload.revenue_model !== ''
        && !SALES_LEAD_REVENUE_MODELS.includes(payload.revenue_model)) {
      errors.push(
        `revenue_model must be empty or one of: ${SALES_LEAD_REVENUE_MODELS.join(', ')}`);
    }
    if (payload.estimated_participants !== undefined
        && (typeof payload.estimated_participants !== 'number'
            || payload.estimated_participants < 0)) {
      errors.push('estimated_participants must be a non-negative number');
    }
    if (payload.estimated_annual_revenue_usd !== undefined
        && (typeof payload.estimated_annual_revenue_usd !== 'number'
            || payload.estimated_annual_revenue_usd < 0)) {
      errors.push('estimated_annual_revenue_usd must be a non-negative number');
    }
    if (payload.pricingByCompany !== undefined
        && (payload.pricingByCompany === null
            || typeof payload.pricingByCompany !== 'object'
            || Array.isArray(payload.pricingByCompany))) {
      errors.push('pricingByCompany must be an object');
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

    if (op.resource === 'meetupGroups' || op.resource === 'meetupGroup') {
      this._validateMeetup(op, errors);
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

  /**
   * Validates a `_mapClassScoutMeetup`-produced ingest envelope against
   * classscout's real MeetupGroup contract (`curatedMeetupSchema`, classscout's
   * `src/lib/meetupSchema.ts`). A meetup group is a materially simpler, distinct
   * resource from Provider -- see `_mapClassScoutMeetup`'s docblock for the
   * field-vocabulary differences (closed `groupType`/single `ageRange`/`cadence`
   * enums, optional `coverImageUrl`, `meetup-` id prefix).
   */
  _validateMeetup(op, errors) {
    const GROUP_TYPES = ['Parent Meetup', 'Mom Group', 'Playdate Group', 'New Parents', 'Neighborhood Families'];
    const AGE_RANGES = ['0–2', '0–3', '0–5', '0–6', '2–5', '2–8', '3–5', 'All ages'];
    const CADENCES = ['Weekly', 'Monthly', 'Weekend', 'Pop-up'];
    const ICONS = ['stroller', 'skyline', 'heart', 'coffee', 'playground', 'community'];
    const PALETTES = ['teal', 'orange', 'beige', 'charcoal'];

    const checkFieldsIfPresent = (doc) => {
      if (doc.groupType !== undefined && !GROUP_TYPES.includes(doc.groupType)) {
        errors.push(`groupType must be one of: ${GROUP_TYPES.join(', ')}`);
      }
      if (doc.ageRange !== undefined && !AGE_RANGES.includes(doc.ageRange)) {
        errors.push(`ageRange must be one of: ${AGE_RANGES.join(', ')} (a single value, not an array -- different vocabulary than Provider's ageRanges)`);
      }
      if (doc.cadence !== undefined && !CADENCES.includes(doc.cadence)) {
        errors.push(`cadence must be one of: ${CADENCES.join(', ')}`);
      }
      if (doc.icon !== undefined && !ICONS.includes(doc.icon)) {
        errors.push(`icon must be one of: ${ICONS.join(', ')}`);
      }
      if (doc.palette !== undefined && !PALETTES.includes(doc.palette)) {
        errors.push(`palette must be one of: ${PALETTES.join(', ')}`);
      }
      if (doc.borough !== undefined && (typeof doc.borough !== 'string' || doc.borough.trim() === '')) {
        errors.push('borough must be a non-empty string');
      }
      // coverImageUrl is OPTIONAL on this resource -- an omitted key is fine.
      // An explicitly-present, non-empty value must still be a real ImgBB URL,
      // same anti-placeholder reasoning as Provider's image field.
      if (doc.coverImageUrl !== undefined && doc.coverImageUrl !== '' && !/^https:\/\/(i\.)?ibb\.co\//.test(doc.coverImageUrl)) {
        errors.push(`coverImageUrl must be empty or an https ImgBB URL (i.ibb.co): ${doc.coverImageUrl}`);
      }
    };

    if (op.action === 'patch') {
      if (!op.id || typeof op.id !== 'string' || !/^meetup-[a-z0-9-]+$/.test(op.id)) {
        errors.push(`patch id must match /^meetup-[a-z0-9-]+$/: ${op.id}`);
      }
      checkFieldsIfPresent(op.patch || {});
      return;
    }

    // create (meetupGroups.upsertMany)
    const doc = (op.documents && op.documents[0]) || {};
    if (!doc.id || typeof doc.id !== 'string' || !/^meetup-[a-z0-9-]+$/.test(doc.id)) {
      errors.push(`id must match /^meetup-[a-z0-9-]+$/: ${doc.id}`);
    }
    if (!doc.name || (typeof doc.name === 'string' && doc.name.trim() === '')) {
      errors.push('name is required');
    }
    if (!doc.neighborhood || (typeof doc.neighborhood === 'string' && doc.neighborhood.trim() === '')) {
      errors.push('neighborhood is required');
    }
    if (!doc.groupType) {
      errors.push(`groupType is required and must be one of: ${GROUP_TYPES.join(', ')}`);
    }
    if (!doc.ageRange) {
      errors.push(`ageRange is required and must be one of: ${AGE_RANGES.join(', ')}`);
    }
    if (!doc.cadence) {
      errors.push(`cadence is required and must be one of: ${CADENCES.join(', ')}`);
    }
    if (!doc.icon) {
      errors.push(`icon is required and must be one of: ${ICONS.join(', ')}`);
    }
    if (!doc.palette) {
      errors.push(`palette is required and must be one of: ${PALETTES.join(', ')}`);
    }
    if (!doc.initials || (typeof doc.initials === 'string' && doc.initials.trim() === '')) {
      errors.push('initials is required');
    }
    if (!doc.description || doc.description.length < 20) {
      errors.push('description must be at least 20 characters');
    }
    if (!doc.website) {
      errors.push('website is required and must be a valid URL');
    } else {
      try { new URL(doc.website); } catch { errors.push(`website must be a valid URL: ${doc.website}`); }
    }
    checkFieldsIfPresent(doc);
  }

  /**
   * Lowercase emails in place.
   *
   * Runs inside mapToApiPayload, i.e. on raw agent output BEFORE the validator
   * ever sees it -- so this was the earlier of the two throw sites and
   * hardening only _validateLead would have left it live.
   *
   * Malformed entries are skipped silently here and reported by _validateLead;
   * this function has no errors array to write to. The guarantee is that a
   * malformed entry is never silently repaired, only left untouched.
   */
  _standardizeContacts(payload) {
    if (Array.isArray(payload.contacts)) {
      for (const contact of payload.contacts) {
        if (!isPlainObject(contact)) continue;
        if (typeof contact.email === 'string') {
          contact.email = contact.email.toLowerCase();
        }
      }
    }

    if (typeof payload.decision_maker_contact === 'string') {
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
module.exports.extractSubjectDocuments = extractSubjectDocuments;
module.exports.SALES_LEAD_CONTRACT_FIELDS = SALES_LEAD_CONTRACT_FIELDS;
module.exports.SALES_LEAD_SERVER_COMPUTED_FIELDS = SALES_LEAD_SERVER_COMPUTED_FIELDS;
