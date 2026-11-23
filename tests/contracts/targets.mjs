// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Each contract case runs once per target: the fake always, the real system when its settings
// are present. FORGE_CONTRACT_REQUIRE (comma-separated system names, set by the nightly
// workflow) turns a missing setting into a failure, so a lost secret can never pass as a skip.
// Errors and skip reasons name settings only, never their values.
export function contractTargets(system, settings, { fake, real }) {
  const missing = settings.filter(name => !process.env[name]),
    required = (process.env.FORGE_CONTRACT_REQUIRE ?? '').split(',').map(name => name.trim());
  const realTarget = { name: 'real' };
  if (!missing.length) realTarget.open = () => real(process.env);
  else if (required.includes(system))
    realTarget.open = () => {
      throw new Error(`The ${system} contract is required but ${missing.join(', ')} is not set.`);
    };
  else realTarget.skip = `set ${missing.join(', ')} to run against the real system`;
  return [{ name: 'fake', open: fake }, realTarget];
}
