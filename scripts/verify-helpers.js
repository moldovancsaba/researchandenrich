/**
 * Shared helpers for the verify-*.js scripts.
 *
 * `sourceWithoutComments` exists because structural assertions kept firing on
 * documentation rather than code: a route's own docblock NAMES the defect it no
 * longer has ("previously wrote schedule.enabled", "deliberately exempt from
 * requireApiKey"), and a naive regex over the raw file matches that prose. It
 * happened twice before being extracted here.
 */

/** Strip block and line comments, preserving enough structure to match code. */
function sourceWithoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Not preceded by ':' so protocol-relative strings like https:// survive.
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Strip comments and assert the stripping did not remove real code.
 *
 * Without the sentinel, an over-eager strip would empty the source and make
 * every downstream structural check pass vacuously -- the same failure mode as
 * the anti-contamination gate this repo already fixed once.
 */
function codeOnly(source, sentinel) {
  const stripped = sourceWithoutComments(source);
  if (sentinel && !stripped.includes(sentinel)) {
    throw new Error(
      `comment stripping removed real code: expected to still find ${JSON.stringify(sentinel)}`
    );
  }
  return stripped;
}

module.exports = { sourceWithoutComments, codeOnly };
