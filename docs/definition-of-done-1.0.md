# Definition of done for 1.0

Porchlet 1.0 is done when all of these hold. Each item is checked and recorded in a milestone doc.

1. Every functional requirement in the design works on Vercel and Netlify, on Chromium, Firefox and WebKit.
2. Every RLS and storage policy has a passing pgTAP test, and the count cross-check (tables in `pg_tables` vs tables covered by tests) matches.
3. Every threat in the design's security mapping has its check run with the expected result.
4. A fresh deploy made only by following the setup guide passes CI and the full SiegeKit run.
5. No open high or critical findings from code scanning, dependency scanning or SiegeKit, and every lower finding is triaged.
6. Every item marked unverified is verified or moved to a named, accepted gap.
7. ADRs, milestone docs, the settings doc, SECURITY.md, the legal files and the privacy policy template are in place, and a lawyer has reviewed them.
8. The release has an SBOM, checksums, a signature or build attestation, and archived build inputs.

v0.1.0, the first public pre-release at the end of M6, must meet items 1-4 and 7, including the lawyer review.
