# Publishing and implementation alignment

Use agent (node scripts/agent.mjs) with --profile NAME. These operations require separate permissions and explicit user intent. Discover per-action schemas with help versions.ACTION.

versions {action:"review"} returns bounded draft-vs-base differences, fixed base/draft/main source references and a review handle. Follow all necessary pages before publishing. Conflicts/diagnostics may be partial; incomplete review is not permission to publish. versions {action:"publish",review,title,description} with --task ID publishes the reviewed draft directly, without a separate approval process. Both draft and main must still match. Release afterward.

To discard, versions {action:"discard-preview",review,targets:[{id,key?}]} expands actual affected targets/dependencies. Omit key for the whole file. Inspect impact and issues, confirm unintended dependencies with the user, then versions {action:"discard",plan} with --task ID. Discard changes drafts and restores their baseline, not latest main. It is undoable. Do not treat discard as merely deselecting a publication.

versions {action:"refresh",review,resolutions?} updates the draft baseline. Resolve conflicts explicitly with per-object ours/theirs; never choose all sides just to bypass a conflict.

versions {action:"list"} returns publication summaries and sync status. Inspect {action:"inspect",id} for differences at fixed revisions. Use read/find/query with revision or returned snapshot references for precise formal design context; do not compare implementation against a moving draft.

A programmer/coding agent must inspect actual code and the relevant fixed design revision before versions {action:"sync",ids:[PUBLICATION_ID],repository,commit,note,active:true} with --task ID. Record a real commit and verification evidence. A code change may be unnecessary, but code inspection is not optional. active:false returns the record to pending while preserving history. This API records a confirmation, not proof that code is correct. Never mark unverified examples synchronized.
