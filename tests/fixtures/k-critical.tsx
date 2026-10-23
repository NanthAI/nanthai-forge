// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usePageCritical } from '../../web/src/ui/page-critical';
function Fixture() {
  const [ready,setReady] = useState(false), [tick,setTick] = useState(0);
  Object.assign(globalThis,{__criticalReady:()=>setReady(true),__presenceTick:()=>setTick(value=>value+1)});
  usePageCritical('Now',{work:ready});
  return <div>{ready?'Loaded':'Loading'} {tick}</div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
