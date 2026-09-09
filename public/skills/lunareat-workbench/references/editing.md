# Draft editing

Use node scripts/agent.mjs with --profile NAME. Examples below are JSON supplied with --json, --input - or --input FILE; do not create a temporary file when direct input is simpler. Global flags can appear before the command.

## Locate enough context

- find: {"query":"霜刃","collection":"skills","fields":["cost"]}. Exact matching is default; collection IDs are user-defined, discover them rather than assuming these examples exist.
- read: {"ids":["skills"],"facets":["schema"]}. Fields have types, options and required constraints. For big schemas choose fields, or read field "fields" as a paged JSON string on a collection.
- read: {"ids":["page-id"],"facets":["outline","references"]}. Each section includes a handle and range read instruction. Body/text ranges return complete, next and fixed snapshot; follow next to read the necessary span. Outline is capped at 30 with outlineComplete; use body ranges for later sections.
- find with relation {id,direction:"incoming"|"outgoing"} discovers dependency metadata. Find never searches inspiration.
- query accepts a saved view OR definition {collection,filters,sort,columns,search}. Example numeric filter: {"key":"cost","operator":"gte","value":2}. Project fields and request selection:true for bulk edits. A selection covers all matches, not just the returned page.

Every bounded list returns complete and next. Continue with only {cursor:next,limit?,maxBytes?}; do not resend filters. Snapshot/cursor/section/selection references are opaque, credential/project-bound and expire after 15 minutes. Requery if expired; do not invent IDs. Ranges count UTF-16 positions supplied by the server. Oversized values are explicitly omitted with a read instruction, never silently shortened as if complete.

## Conditional atomic editing

Run new-task once. Supply --task ID for mutations; taskId/writeSessionId are client-managed and must not appear in JSON. requestId is normally generated and persisted before the request. An uncertain response must reuse identical input; a new intentional edit receives a new ID.

An edit payload:

    {"snapshot":"RETURNED_SNAPSHOT","operations":[{"type":"field","id":"record-id","key":"cost","value":3}]}

Snapshot supplies expected old fields; alternatively supply explicit expected. null removes a value subject to schema validation. patch replaces a unique before string with after. section replaces the exact outlined span, rejecting a changed document. put creates/replaces a complete entity; replacing requires snapshot or expected entity. Discover exact operation help, not the entire union.

Bulk: {"operations":[{"type":"bulk-field","selection":"QUERY_SELECTION","key":"cost","value":3}]}. Server expands up to 500 operations atomically, rejects changed collection schema, target values, membership or ordering; relative-date selection uses the original query instant. An empty selection is an explicit no-op error. Do not issue one request per row.

## Views and embeds

Views are shared objects, not private copies per embed. When asked to add a table/view to one document, create a NEW view ID and embed it there; preserve existing views and embeds unless the user asked to change them. Read incoming references before changing an existing shared view. This is a scope decision, not just a visual preference.

Use **agent help view** for the authoritative entity schema. New writes use filters, not legacy filter. Numeric gte is not a contains string such as ">=2". Page size belongs at pagination.pageSize (10/25/50/100/null), never at top level. API query paging is independent of saved display pagination.

One batch may create a view using put with alias:"view1", then embed using {type:"embed",id:"page-id",target:"$view1",after:"unique existing anchor",format:"view"}. Other formats are document/link. This avoids rereading or discovering a just-created ID. Anchors must exist uniquely; no partial batch is saved if a later operation fails.

Inspect receipt.checks.persisted and checks.views (actual filters, sort, matchedCount, pageSize, sample). Saved does not mean semantically correct: compare with user intent, and do not claim expected results that the receipt contradicts. Uniform bulk edits also return checks.fields with actual value/count and checks.bodyChangedCount. When the full aggregate matches the intended selection count/value and scope, that verifies the batch without fetching every receipt page or repeating queries. Fetch further summaries only when individual differences or omitted values matter. Never read the entire workspace to verify a field.

## Destruction and history

Deletion or removal of a collection field requires edit mode:"preview" with snapshot and operations. It does not lock or save drafts. Inspect actual impact; apply {plan:RETURNED_PLAN} only for the authorized scope. A plan becomes stale when the draft changes. References block unsafe deletion.

history filters by actor:"human"|"agent" and/or objectId; inspect one group by action:"inspect", id. undo/redo use action and explicit group id (or objectId scope); they preserve later independent changes and reject conflicts. All writes in one control session form one undo group. Never undo unrelated human work. Use history receipt for actual verification.
