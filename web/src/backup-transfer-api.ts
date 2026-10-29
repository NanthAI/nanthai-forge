// SPDX-License-Identifier: Apache-2.0
import {
  makeFunctionReference,
  type ApiFromModules,
  type FunctionArgs,
  type FunctionReturnType,
} from 'convex/server';
import type * as transfer from '../../convex/backupTransfer';
type Transfer = ApiFromModules<{ backupTransfer: typeof transfer }>['backupTransfer'];
export const backupTransfer = {
  prepare: makeFunctionReference<
    'mutation',
    FunctionArgs<Transfer['prepare']>,
    FunctionReturnType<Transfer['prepare']>
  >('backupTransfer:prepare'),
  complete: makeFunctionReference<
    'action',
    FunctionArgs<Transfer['complete']>,
    FunctionReturnType<Transfer['complete']>
  >('backupTransfer:complete'),
  sign: makeFunctionReference<
    'mutation',
    FunctionArgs<Transfer['sign']>,
    FunctionReturnType<Transfer['sign']>
  >('backupTransfer:sign'),
};
