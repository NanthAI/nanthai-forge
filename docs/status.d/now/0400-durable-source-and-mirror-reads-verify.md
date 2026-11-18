Durable source and mirror reads verify legacy file IDs against live project
ownership before fetching bytes. Unowned references return `SOURCE_REF_UNOWNED`;
unregistered old continuations need migration. R2 reads add no ownership RPC.
