# Settings shows tag DB sync status

**Date:** 2026-06-23
**Area:** settings / tag DB sync / mobile diagnostics

Mobile users need a stable place to confirm whether the local tag database is
ready. The desktop-only header indicator is not visible on mobile, and the
search screen only surfaces failures.

The settings screen now places a Tag DB status row directly below Language
Filter and above Default Filter. That keeps the status next to settings that
depend on local tag data, including default filters, blur-tag suggestions,
Korean tag search, autocomplete, and popular tags.

The row shows readiness, sync progress, tag count, last completed sync time,
current DB initialization stage, concrete sync/DB errors, retry/start sync, and
copy-error actions. This is the only user-facing sync diagnostic surface; other
flows should continue to treat sync state as internal behavior.
