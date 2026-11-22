**GitHub archive imports list in pages and resume from verified pins.** A
scheduled worker validates and writes the committed tree to R2 listing pages.
Acquisition checkpoints verified file pins. Later steps fetch remaining files
in byte-bounded Git packs, and a complete step above 380 MB hands publication
off to a fresh action. Publication removes the scratch objects. The 2,405-file
deadline replay publishes the same digests and modes as a one-step acquisition.
Hosted throughput and publication at 487,756 files remain unmeasured.
([GitHub import](../../operations/github-project-import.md))
