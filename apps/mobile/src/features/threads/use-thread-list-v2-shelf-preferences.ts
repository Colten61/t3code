import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled === true;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;
  // FORK: the Shelf.
  const shelvedShelfExpanded =
    loaded && preferencesResult.value.threadListShelvedShelfExpanded === true;

  // A transform reads the optimistic value, so two presses before the next
  // render still toggle twice instead of writing the same value.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  const toggleShelvedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListShelvedShelfExpanded: current.threadListShelvedShelfExpanded !== true,
      }),
    });
  };

  return {
    loaded,
    settledShelfExpanded,
    shelvedShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleShelvedShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
