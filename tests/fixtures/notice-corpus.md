# Notice replay corpus

[notice-corpus.json](notice-corpus.json) retains all 66 notices and 22 missed
pairs named by planning Issue ee9d5738-0272-4cb4-b03c-ca35b34966ee. The seven
original result identities and SHA-256 digests are in `sources`; the later extra
n3-r3 attempt is excluded. Base source is exactly
`fa3b73491d3a3965c4719139411c460e153632fb` from public `pingdotgg/t3code`.

Each case retains the original cell, task, peer, path, notice class and measured
conflict label. The outside-cell peer has no retained final snapshot: that one case remains
explicitly unrun, with its original unknown label. The other 87 cases are replayed. Own-origin notices
retain their own-Lane identity. Final task snapshots were compared with the exact
base using `overlapTextSketch` and `overlapTextEvidence`. Only file hashes and
changed line ranges are retained here; source text and symbol names are omitted.
An absent path in a complete task change inventory uses the unchanged base.

The acceptance test reclassifies these final deltas. It is a deterministic
snapshot replay, not reconstruction of delivery-time saved heads, save order or
first-write hook execution. It cannot prove timely delivery during live edits,
or that missing original notices were caused by projection loss. The separate
large-projection regression prevents optional metadata hiding later test paths.

Before replay, 45 blocking deliveries contained 13 useful, 31 noisy and one
unknown notice; 21 advisories were noisy. Known blocking precision is 13/44;
including the unknown delivery in the denominator gives 13/45. There are 33 unique
labeled real-conflict pairs: 11 with an original notice and 22 without one, so
original pair recall is 11/33. Directional useful deliveries are deduplicated for
this recall denominator. Precision after replay counts predicted positive cases,
including newly detected missed pairs. The test requires at least 80% precision,
all labeled positive cases detected and no known-clean automatic advisories.
One shared-hunk false positive remains in this fixture; it is not relabeled.

[The regression](../notice-corpus.test.mjs) runs with normal verification and does
not require the benchmark checkout, its deleted fork, Git, network access or any
repository code execution. Live N=3 delivery/time-to-main qualification and billed
usage comparison remain separate measurements.
