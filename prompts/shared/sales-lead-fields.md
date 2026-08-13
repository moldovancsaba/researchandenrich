<!-- shared:sales-lead-fields start -->
## Shared Field Contract (cogmap, seyu, dvsc — identical for all three)

These three tenants are one `schemaFamily` (`sales-lead-api`). **They emit an identical
field structure. Only the business logic differs** — scope, ICP, forecast model, and the
tenant block above. This section is generated from
`prompts/shared/sales-lead-fields.md`; do not edit it in a tenant file.

**Emit every field below on every record.** If a value cannot be sourced, emit it empty
(`""`, `[]`, or `0` as appropriate) — do **not** omit the key. A field omitted by one
tenant and populated by another is a defect: it breaks cross-tenant comparison and hides
gaps behind "that tenant just doesn't have it".

### Identity and location
- `entity_name` — organization name exactly as it appears on its official site
- `canonicalLeadName` — normalized name used for dedupe
- `url` — the organization's OWN https:// website. **Never a search-engine result URL.**
  If you only have a search link, resolve it to the real domain first.
- `region` — ISO 3166-1 alpha-2 country code
- `country`, `cityName`, `address` — as published by the organization

### Classification
- `industry`, `sport_or_sector`, `sportCode`, `level_league`, `size`
- `classificationTags`, `tags`, `orgTypeCode`, `businessUnitCode`
- `competitionLevelCode`, `demographicCodes`, `genderCode`
- `parentOrgName`, `relationshipToParent`

### Contact (minimum one named contact with email or phone)

**Put personal contact detail INSIDE `contacts[]`. That is the only carrier that
persists.** Verified 2026-08-13 against production: a real value in the flat scalars
`contact_phone`, `decision_maker_name`, `decision_maker_title`,
`decision_maker_contact` is accepted with HTTP 200 and then **ignored** — it is not
stored, empty or not. The identical detail sent inside a `contacts[]` object is stored
and normalised (the API reformats the phone and adds `linkedin`, `role`,
`isDecisionMaker` itself).

- `contacts` — **array of objects: `{ name, title, phone, email }`.** A decision maker
  is a contact object with their title, not a separate flat field.
- `contactEmails`, `general_contact` — organisation-level, these do persist

The four flat scalars are still emitted for payload uniformity and start working the
moment the API supports them, but **do not rely on them and do not treat their absence
downstream as a sourcing failure** — they are excluded from parity measurement:

- `contact_phone`, `decision_maker_name`, `decision_maker_title`, `decision_maker_contact`

### Assessment
- `value_proposition` — why this organization fits, in the tenant's own terms
- `pro_for_organization` / `con_for_organization` — **these exact names for all three.**
  Never emit `pro_for_<tenant>` / `con_for_<tenant>`; those are legacy and are treated as
  forbidden fields.
- `product_fit_notes`, `notes`, `priority`

**`ice` is the one documented exception to "emit every field empty".** It must carry real
integers — `{ "impact": 1-10, "confidence": 1-10, "ease": 1-10 }`. Verified 2026-08-12:
`PUT ice:{}` is rejected **HTTP 400** ("ice.impact must be an integer between 1 and 10") on
both cogmap and dvsc. If you cannot score a record, omit `ice` entirely rather than sending
an empty object — an empty one fails the whole write. `ice.ease` is recomputed server-side
regardless of what you send.

### Forecast (values follow the tenant's `forecastModel`; the FIELDS are always present)
- `recommended_tier`, `revenue_model`, `estimated_participants`
- `estimated_annual_revenue_usd`, `ticketSizeEstimate`, `pricingByCompany`

### Provenance (required — a record without provenance is not sovereign)
- `source` — where the lead was found
- `techSignals` — observed signals, empty array if none

<!-- shared:sales-lead-fields end -->
