// Entity limits for every XML parser in ingest (feeds and sitemaps).
//
// The library's default caps total entity expansions at 1,000. Full-text feeds
// (Blogger, WordPress) carry each post's HTML escaped (&lt;p&gt;...), so five
// ordinary posts exceed it and the whole feed is rejected. Big sitemaps hit it
// through &amp; in URLs.
//
// What actually stops an "entity bomb" is kept strict: nesting depth, the number
// and size of entities declared in a DOCTYPE. Ordinary entities expand to one
// character each, so the totals are already bounded by the 10 MB fetch cap.
export const XML_ENTITY_LIMITS = {
  enabled: true,
  maxEntitySize: 10_000,
  maxExpansionDepth: 10,
  maxEntityCount: 100,
  maxTotalExpansions: 2_000_000,
  maxExpandedLength: 20_000_000,
};
