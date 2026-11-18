Landing request tickets retain their reader contracts while cold request and
batch-selection metadata live in unindexed parent-owned bodies. Phase writes leave those
bodies unchanged; the S0 model and storage/call guards cover the split. New report runs retain headers and one pinned R2 object, with no result-report rows;
legacy replay remains for old runs. No billed S3 saving is claimed.
