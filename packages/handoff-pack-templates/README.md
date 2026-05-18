# @founder-os/handoff-pack-templates

Markdown + Handlebars template tree that backs the `HANDOFF_PACK` stage's
PDF renderer. One `.md.hbs` per `DocDescriptor` in
`@founder-os/handoff-pack-core/manifest`.

## Layout

```
templates/
  00-company-control/
  01-strategy/
  02-product/
  03-design-brand/
  04-engineering/
  05-security-data-compliance/
  06-people-hr/
  07-finance-admin/
  08-sales-marketing/
  09-customer-success/
  10-templates/
```

Every file:

- Has YAML frontmatter (`docId`, `tier`, `category`) that the smoke test
  cross-checks against the manifest.
- Uses the Handlebars subset shipped by `@founder-os/handoff-pack-providers`
  (`{{var}}` / `{{{var}}}` / `{{#if}}` / `{{#each}}` / `{{!-- comment --}}`).
- Carries a solicitor-review banner where the category is legally
  sensitive (00-company-control, 05-security-data-compliance,
  06-people-hr).

Slice 5's `renderAllStubsStep` reads from this tree and renders each
template through the engines from slice 2. Until slice 5 lands, the
parse-all smoke test in `test/parse-all.test.ts` is the only consumer.
