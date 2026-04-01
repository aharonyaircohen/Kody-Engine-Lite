# docs: add screenshots of Kody PR, review comment, and pipeline labels

## Problem

The documentation has zero visual proof of what Kody produces. Readers have to *imagine* the output — a Kody-created PR, a review comment, pipeline labels progressing on an issue.

A single screenshot in the README would significantly improve first impressions and conversion.

## Suggested screenshots

- A Kody-created PR showing the rich description (What/Scope/Changes/Verify/Plan)
- A `@kody review` comment on a PR with Critical/Major/Minor findings
- An issue with `kody:planning` → `kody:building` → `kody:done` labels progressing
- (Optional) A GIF or Asciinema recording of `kody init` running

## Where to add them

- README.md — at least one screenshot after the Quick Start section
- ABOUT.md — in the Real-World Example section
- FEATURES.md — inline with Standalone PR Review and Rich PR Descriptions sections