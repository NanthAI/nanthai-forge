// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// A Dock with one region has nothing to reorder, so that region shows no header bar and no drag handle (owner
// 2026-11-23: "it's actually not going anywhere and it's the only thing in that page"). The Dock says so here; a
// Region reads it. Only a region with a fold or tools keeps its bar, since those live in it.
import { createContext, useContext } from 'react';

const SoloRegion = createContext(false);
export const SoloRegionProvider = SoloRegion.Provider;
export const useSoloRegion = () => useContext(SoloRegion);
