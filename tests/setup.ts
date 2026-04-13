/**
 * Vitest global setup — runs before all tests.
 * Sets environment variables that simulate a CI/comment-trigger context.
 */

process.env.COMMENT_AUTHOR_ASSOC = "MEMBER"
