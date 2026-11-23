// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// An old address that names only ids (Item d61f36fe): `?project=<id>&lane=…`, `/decisions/<id>`, `/review/<id>`.
// One access-checked read (convex/urlLegacy.ts) says where it lives now; the page then replaces itself with that
// address. A project the reader cannot see answers like a missing one, so an id never reveals its handle.
import { useEffect } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Head } from './Place';
import { lookHref, type OldAddress } from './old-address';
import { navigate } from './router';

export default function OldAddressPage({ look }: { look: Extract<OldAddress, { kind: 'look' }> }) {
  const found = useQuery(api.urlLegacy.resolve, { ...look.ref, ...(look.find && { find: look.find }) });
  useEffect(() => {
    if (found) navigate(lookHref(look, found) + location.hash, { replace: true });
  }, [found, look]);
  if (found === null)
    return (
      <Head trail={[{ label: 'Project not found' }]} sentence="It may be private, renamed or removed." />
    );
  return <Head trail={[{ label: 'Opening…' }]} sentence="Finding where this link lives now." />;
}
